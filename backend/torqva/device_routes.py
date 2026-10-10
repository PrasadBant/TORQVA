"""HTTP + WebSocket surface of the USB serial bridge. Mounted by torqva.api.create_router. The backend owns the serial port; these routes only call the bridge.

Authority: every route needs a bearer token (WebSocket: an `auth` first message). Connect/disconnect/port listing are admin-only; motion commands need operator; STOP needs any
authenticated role (it can only make things safer and is NOT an emergency stop). Commands go through DeviceBridge.request_command (Safety Supervisor, commissioning/interlocks,
dispatcher) and are never executed inside the WebSocket handler: the WebSocket is read-only.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Any, Callable, Dict, Optional

from fastapi import Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from .auth import Principal, TokenAuth
from .schemas import Role
from .serial_bridge import ERROR_HELP, SerialTransport, TransportError, possible_port_holders

_PORT = re.compile(r"^(COM[0-9]{1,3}|/dev/(tty|cu)[A-Za-z0-9._-]{1,40})$")
WS_AUTH_TIMEOUT_S = 5.0
WS_PUSH_INTERVAL_S = 0.2                      # at most 5 telemetry updates per second per client
WS_MAX_CLIENT_MSG = 2048


class ConnectIn(BaseModel):
    port: str = Field(max_length=64)
    baud: int = Field(default=115200, ge=9600, le=921600)
    expected_device_id: Optional[str] = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")


class CommandIn(BaseModel):
    action: str = Field(max_length=16)
    duty_pct: Optional[float] = Field(default=None, allow_inf_nan=False, ge=0, le=100)
    rpm: Optional[float] = Field(default=None, allow_inf_nan=False, ge=0, le=100000)


def add_device_routes(r, service, need: Callable, audit: Callable, auth: TokenAuth) -> None:
    bridge = service.bridge

    @r.get("/device/status")
    def device_status(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        return bridge.snapshot()

    @r.get("/device/history")
    def device_history(signal: str = Query("rpm", max_length=16), seconds: float = Query(60, gt=0, le=600), p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        import time
        try:
            pts = bridge.model.history_series(signal, seconds, time.time())
        except ValueError:
            raise HTTPException(422, "unsupported signal")
        return {"signal": signal, "seconds": seconds, "points": pts, "note": "null = invalid reading (a gap), never zero", "origin": bridge.snapshot()["origin"]}

    @r.get("/device/ports")
    def device_ports(p: Principal = Depends(need(Role.ADMIN))) -> Dict[str, Any]:
        """Lists serial ports without opening any of them."""
        try:
            from serial.tools import list_ports
        except ImportError:
            return {"ports": [], "error": "pyserial is not installed"}
        return {"ports": [{"device": x.device, "description": x.description} for x in list_ports.comports()][:64]}

    @r.post("/device/connect")
    def device_connect(body: ConnectIn, p: Principal = Depends(need(Role.ADMIN))) -> Dict[str, Any]:
        if not _PORT.match(body.port):
            raise HTTPException(422, "unsupported port name")
        if bridge.connected:
            raise HTTPException(409, "a serial connection is already open")
        bridge.model.expected_device_id = body.expected_device_id
        audit(p, "device_connect", port=body.port, baud=body.baud)
        try:
            bridge.connect(SerialTransport(body.port, body.baud))
        except RuntimeError as e:                                  # an attempt is in progress, or the port is already owned: never a second open
            raise HTTPException(409, str(e))
        except TransportError as e:
            summary = ERROR_HELP.get(e.code, (str(e), []))[0]
            holders = possible_port_holders() if e.code == "ACCESS_DENIED" else []
            hint = f" Possible holders running (hint only, not proof): {', '.join(holders)}." if holders else ""
            raise HTTPException(502, f"{e.code}: {summary} [{e.detail}]{hint}")
        return {"state": "CONNECTING", "note": "waiting for a valid status frame (protocol 1) before the device is shown as connected"}

    @r.post("/device/disconnect")
    def device_disconnect(p: Principal = Depends(need(Role.ADMIN))) -> Dict[str, Any]:
        audit(p, "device_disconnect")
        bridge.disconnect("requested by " + p.user)
        return {"state": "DISCONNECTED"}

    @r.post("/device/commands")
    def device_command(body: CommandIn, p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        if body.action != "STOP" and not p.at_least(Role.OPERATOR):
            audit(p, "denied", needed="operator", action=body.action)
            raise HTTPException(403, "requires role operator")
        params: Dict[str, Any] = {}
        if body.duty_pct is not None:
            params["duty_pct"] = body.duty_pct
        if body.rpm is not None:
            params["rpm"] = body.rpm
        audit(p, "device_command_requested", action=body.action, params=params)
        rec = bridge.request_command(body.action, params, p.user, p.role)
        return rec.public()

    @r.get("/device/commands")
    def device_commands(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        return {"commands": bridge.command_list()}

    # ---- read-only WebSocket (authentication by first message: browsers cannot set headers on a WebSocket)
    @r.websocket("/ws")
    async def ws(websocket: WebSocket):
        origin = websocket.headers.get("origin")
        allowed = [o.strip() for o in os.environ.get("TORQVA_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip() and o.strip() != "*"]
        host = websocket.headers.get("host", "")
        if origin and origin not in allowed and not origin.endswith("//" + host):
            await websocket.close(code=4403)                       # cross-site WebSocket from an unlisted origin
            return
        await websocket.accept()
        if not auth.configured:
            await websocket.close(code=4503)
            return
        try:
            raw = await asyncio.wait_for(websocket.receive_text(), WS_AUTH_TIMEOUT_S)
            if len(raw) > WS_MAX_CLIENT_MSG:
                raise ValueError("oversize")
            msg = json.loads(raw)
            token = msg.get("token") if isinstance(msg, dict) and msg.get("type") == "auth" else None
            principal = auth.authenticate(token) if isinstance(token, str) else None
        except (asyncio.TimeoutError, ValueError, WebSocketDisconnect):
            principal = None
        if principal is None:
            try:
                await websocket.close(code=4401)
            except RuntimeError:
                pass
            return
        client = bridge.hub.subscribe()
        try:
            await websocket.send_json({"type": "snapshot", "data": bridge.snapshot(), "commands": bridge.command_list()[:20]})

            async def sender():
                while True:
                    await asyncio.sleep(WS_PUSH_INTERVAL_S)
                    for ev in client.drain(include_telemetry=True):
                        await websocket.send_json(ev)

            async def receiver():
                while True:
                    text = await websocket.receive_text()
                    try:
                        m = json.loads(text) if len(text) <= WS_MAX_CLIENT_MSG else None
                    except ValueError:
                        m = None
                    if not isinstance(m, dict) or m.get("type") != "ping":
                        await websocket.close(code=4400)           # the socket is read-only: anything else (including commands) is refused
                        return
                    await websocket.send_json({"type": "pong"})

            tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in pending:
                t.cancel()
            for t in done:
                t.exception()
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            bridge.hub.unsubscribe(client)
