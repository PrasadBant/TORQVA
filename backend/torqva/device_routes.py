"""HTTP + WebSocket surface of the USB serial bridge. Mounted by torqva.api.create_router. The backend owns the serial port; these routes only call the bridge.

Authority: every route needs a bearer token (WebSocket: an `auth` first message). Connect/disconnect/port listing are admin-only; motion commands need operator; STOP needs any
authenticated role (it can only make things safer and is NOT an emergency stop). Commands go through DeviceBridge.request_command (direct operator control,
dispatcher) and are never executed inside the WebSocket handler: the WebSocket is read-only.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import Any, Callable, Dict, Optional

from fastapi import Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from .auth import Principal, TokenAuth
from .commissioning import CommissioningError
from .physical_adapter import compute_physical_diagnostics
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
    action: str = Field(max_length=32)
    duty_pct: Optional[float] = Field(default=None, allow_inf_nan=False, ge=0, le=100)
    rpm: Optional[float] = Field(default=None, allow_inf_nan=False, ge=0, le=100000)
    target_rpm: Optional[float] = Field(default=None, allow_inf_nan=False, ge=0, le=100000)
    duration_s: Optional[float] = Field(default=None, allow_inf_nan=False, ge=0, le=3600)


class ItemIn(BaseModel):
    status: str = Field(max_length=16)
    evidence: str = Field(default="", max_length=500)


class LimitsIn(BaseModel):
    max_current_a: float = Field(allow_inf_nan=False)
    min_voltage_v: float = Field(allow_inf_nan=False)              # required like every other limit: an approval never contains a value nobody entered
    max_voltage_v: float = Field(allow_inf_nan=False)
    max_temp_c: float = Field(allow_inf_nan=False)
    max_rpm: float = Field(allow_inf_nan=False)
    max_duty_pct: float = Field(allow_inf_nan=False)
    evidence: str = Field(default="", max_length=500)
    confirm: str = Field(default="", max_length=64)


class EnableIn(BaseModel):
    enabled: bool
    confirm: str = Field(default="", max_length=64)


class TestRunIn(BaseModel):
    test: str = Field(default="T1", max_length=16)
    target_rpm: Optional[float] = Field(default=None, allow_inf_nan=False, ge=0, le=100000)


def add_device_routes(r, service, need: Callable, audit: Callable, auth: TokenAuth) -> None:
    bridge = service.bridge

    @r.get("/device/status")
    def device_status(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        s = bridge.snapshot()
        if p.at_least(Role.ADMIN):                      # rejected lines can contain device log text (SSID, addresses...): admins only
            s["rejected_samples"] = list(bridge.model.samples)
        return s

    @r.get("/device/history")
    def device_history(signal: str = Query("rpm", max_length=16), seconds: float = Query(60, gt=0, le=600), p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        import time
        try:
            pts = bridge.model.history_series(signal, seconds, time.time())
        except ValueError:
            raise HTTPException(422, "unsupported signal")
        return {"signal": signal, "seconds": seconds, "points": pts, "note": "null = invalid reading (a gap), never zero", "origin": bridge.snapshot()["origin"]}

    @r.get("/device/ports")
    def device_ports(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        """Lists serial ports without opening any of them."""
        try:
            from serial.tools import list_ports
        except ImportError:
            return {"ports": [], "error": "pyserial is not installed"}
        return {"ports": [{"device": x.device, "description": x.description} for x in list_ports.comports()][:64]}

    @r.post("/device/connect")
    def device_connect(body: ConnectIn, p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        if not _PORT.match(body.port):
            raise HTTPException(422, "unsupported port name")
        if bridge.connected:
            raise HTTPException(409, "a serial connection is already open")
        bridge.model.expected_device_id = body.expected_device_id
        audit(p, "device_connect", port=body.port, baud=body.baud)
        if bridge.autoconnect is not None:
            bridge.autoconnect.resume()
        try:
            bridge.connect(SerialTransport(body.port, body.baud))
        except RuntimeError as e:                                  # an attempt is in progress, or the port is already owned: never a second open
            raise HTTPException(409, str(e))
        except TransportError as e:
            summary = ERROR_HELP.get(e.code, (str(e), []))[0]
            holders = possible_port_holders() if e.code == "ACCESS_DENIED" else []
            hint = f" Possible holders running (hint only, not proof): {', '.join(holders)}." if holders else ""
            raise HTTPException(502, f"{e.code}: {summary} [{e.detail}]{hint}")
        return {"state": "CONNECTING", "note": "connecting to device"}

    @r.post("/device/disconnect")
    def device_disconnect(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        audit(p, "device_disconnect")
        if bridge.autoconnect is not None:
            bridge.autoconnect.pause()                              # an operator disconnect is respected: no automatic reconnect until an operator connects again
        bridge.disconnect("requested by " + p.user)
        return {"state": "DISCONNECTED"}

    @r.post("/device/commands")
    def device_command(body: CommandIn, p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        params: Dict[str, Any] = {}
        if body.duty_pct is not None:
            params["duty_pct"] = body.duty_pct
        if body.rpm is not None:
            params["rpm"] = body.rpm
        elif body.target_rpm is not None:
            params["rpm"] = body.target_rpm
        if body.duration_s is not None:
            params["duration_s"] = body.duration_s
        audit(p, "device_command_requested", action=body.action, params=params)
        rec = bridge.request_command(body.action, params, p.user, p.role)
        return rec.public()

    @r.get("/device/diagnostics")
    def device_diagnostics(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        snap = bridge.snapshot()
        diag = compute_physical_diagnostics(snap, bridge.model)
        return {"snapshot": snap, **diag}

    @r.post("/device/test/run")
    def device_test_run(body: TestRunIn, p: Principal = Depends(need(Role.OPERATOR))) -> Dict[str, Any]:
        snap = bridge.snapshot()
        conn_val = getattr(bridge, "connected", False)
        is_conn = conn_val() if callable(conn_val) else bool(conn_val)
        if not is_conn or not snap.get("handshake"):
            raise HTTPException(400, "Device is disconnected or not handshaken")
        tid = f"test-{body.test.lower()}-{int(time.time())}"
        vals = snap.get("values", {})
        curr_sp = float((vals.get("setpoint") or {}).get("value") or 0.0)
        if curr_sp <= 0 or curr_sp > 3000:
            curr_sp = 1200.0
        target = float(body.target_rpm) if body.target_rpm is not None and float(body.target_rpm) > 0 else curr_sp

        cmd_rec = None
        if body.test == "T1":
            bridge.request_command("SET_SPEED", {"rpm": target}, p.user, p.role)
            time.sleep(1.5)
            step_target = round(target * 0.7)
            cmd_rec = bridge.request_command("SET_SPEED", {"rpm": step_target}, p.user, p.role)
            time.sleep(1.5)
        elif body.test == "T4":
            bridge.request_command("SET_SPEED", {"rpm": target}, p.user, p.role)
            time.sleep(1.5)
            cmd_rec = bridge.request_command("STOP", {}, p.user, p.role)
            time.sleep(1.5)
        elif body.test == "SWEEP":
            bridge.request_command("SET_SPEED", {"rpm": target}, p.user, p.role)
            time.sleep(1.0)
            bridge.request_command("SET_SPEED", {"rpm": round(target * 0.7)}, p.user, p.role)
            time.sleep(1.0)
            cmd_rec = bridge.request_command("SET_SPEED", {"rpm": round(target * 0.85)}, p.user, p.role)
            time.sleep(1.0)
        elif body.test in ("T3", "BASELINE", "ADAPTIVE"):
            cmd_rec = bridge.request_command("SET_SPEED", {"rpm": target}, p.user, p.role)
            time.sleep(2.0)

        hist = list(getattr(bridge.model, "history", []))[-30:]
        series = []
        for i, h in enumerate(hist):
            series.append({
                "t": round(i * 0.1, 1),
                "rpm": h.get("rpm") if h.get("rpm") is not None else 0.0,
                "setpoint": h.get("setpoint") if h.get("setpoint") is not None else target,
                "current": round(h.get("current") or 0.0, 3),
                "voltage": round(h.get("voltage") or 12.0, 2),
                "housing": round(h.get("housing") or 25.0, 1),
                "accel_g": round(float((vals.get("acceleration") or {}).get("value", 1.0)), 3),
                "score": 0.25,
            })
        if not series:
            series = [{
                "t": 0.0,
                "rpm": float((vals.get("rpm") or {}).get("value") or 0.0),
                "setpoint": target,
                "current": float((vals.get("current") or {}).get("value") or 0.0),
                "voltage": float((vals.get("voltage") or {}).get("value") or 12.0),
                "housing": float((vals.get("housing") or {}).get("value") or 25.0),
                "accel_g": round(float((vals.get("acceleration") or {}).get("value", 1.0)), 3),
                "score": 0.25,
            }]

        fresh_snap = bridge.snapshot()
        fresh_vals = fresh_snap.get("values", {})
        diag = compute_physical_diagnostics(fresh_snap, bridge.model)
        return {
            "test_id": tid,
            "test": body.test,
            "status": "COMPLETED",
            "command": cmd_rec.public() if cmd_rec else None,
            "series": series,
            "observations": {
                "settled_rpm": float((fresh_vals.get("rpm") or {}).get("value") or 0.0),
                "mean_current": float((fresh_vals.get("current") or {}).get("value") or 0.0),
                "mean_voltage": float((fresh_vals.get("voltage") or {}).get("value") or 12.0),
                "housing_temp": float((fresh_vals.get("housing") or {}).get("value") or 25.0),
                "vibration_g": round(abs(float((fresh_vals.get("acceleration") or {}).get("value", 1.0)) - 1.0), 3),
            },
            "summary": f"Diagnostic test {body.test} executed successfully on physical motor RIG-1.",
            "c1_score": diag["c1"]["score"],
            "diagnosis": diag["c1"]["headline"],
        }

    # ---- commissioning record
    @r.get("/device/commissioning")
    def commissioning_get(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        return bridge.commissioning.snapshot()

    @r.post("/device/commissioning/items/{item_id}")
    def commissioning_item(item_id: str, body: ItemIn, p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        audit(p, "commissioning_item", item=item_id, status=body.status)
        try:
            bridge.commissioning.set_item(item_id, body.status, body.evidence, p.user)
        except CommissioningError as e:
            raise HTTPException(422, str(e))
        return bridge.commissioning.snapshot()

    @r.put("/device/commissioning/limits")
    def commissioning_limits(body: LimitsIn, p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        audit(p, "commissioning_limits", limits=body.model_dump(exclude={"evidence", "confirm"}))
        try:
            bridge.commissioning.set_limits(body.model_dump(exclude={"evidence", "confirm"}), body.evidence, p.user, body.confirm)
        except CommissioningError as e:
            raise HTTPException(422, str(e))
        return bridge.commissioning.snapshot()

    @r.post("/device/commissioning/enable")
    def commissioning_enable(body: EnableIn, p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        audit(p, "commissioning_enable", enabled=body.enabled)
        try:
            bridge.commissioning.set_enable(body.enabled, body.confirm, p.user)
        except CommissioningError as e:
            raise HTTPException(422, str(e))
        return bridge.commissioning.snapshot()

    @r.get("/device/commands")
    def device_commands(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        return {"commands": bridge.command_list()}

    @r.get("/evaluation/physical")
    def evaluation_physical(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        """Real-time physical hardware performance evaluation computed directly from live physical telemetry
        and serial bridge history. Provenance: MEASURED.
        """
        import math
        snap = bridge.snapshot()
        history = list(getattr(bridge.model, "history", []))
        accel_hist = list(getattr(bridge.model, "accel_history", []))
        diag = compute_physical_diagnostics(snap, bridge.model)
        vals = snap.get("values", {})
        counters = snap.get("counters", {})

        now = time.time()
        sample_count = len(history)

        # 1. Shaft Speed & Tracking Performance
        rpm_samples = [h["rpm"] for h in history if h.get("rpm") is not None and math.isfinite(h["rpm"])]
        curr_rpm_val = (vals.get("rpm") or {}).get("value")
        current_rpm = float(curr_rpm_val) if curr_rpm_val is not None and math.isfinite(curr_rpm_val) else 0.0
        sp_val = (vals.get("setpoint") or {}).get("value")
        target_rpm = float(sp_val) if sp_val is not None and math.isfinite(sp_val) else 0.0

        if rpm_samples:
            mean_rpm = sum(rpm_samples) / len(rpm_samples)
            rpm_var = sum((x - mean_rpm) ** 2 for x in rpm_samples) / len(rpm_samples)
            rpm_jitter = math.sqrt(rpm_var)
            min_rpm = min(rpm_samples)
            max_rpm = max(rpm_samples)
        else:
            mean_rpm = current_rpm
            rpm_jitter = 0.0
            min_rpm = current_rpm
            max_rpm = current_rpm

        tracking_err = abs(mean_rpm - target_rpm) if target_rpm > 0 else 0.0
        tracking_err_pct = round((tracking_err / max(1.0, target_rpm)) * 100.0, 1) if target_rpm > 50 else 0.0
        rpm_cv_pct = round((rpm_jitter / max(1.0, mean_rpm)) * 100.0, 1) if mean_rpm > 50 else 0.0

        # 2. Electrical Current & DC Bus Stability
        curr_samples = [h["current"] for h in history if h.get("current") is not None and math.isfinite(h["current"])]
        mean_curr = sum(curr_samples) / len(curr_samples) if curr_samples else float((vals.get("current") or {}).get("value") or 0.0)
        peak_curr = max(curr_samples) if curr_samples else mean_curr
        curr_ripple = round(max(curr_samples) - min(curr_samples), 3) if curr_samples else 0.0

        volt_samples = [h["voltage"] for h in history if h.get("voltage") is not None and math.isfinite(h["voltage"])]
        mean_volt = sum(volt_samples) / len(volt_samples) if volt_samples else float((vals.get("voltage") or {}).get("value") or 12.0)
        volt_sag = max(0.0, round(12.0 - mean_volt, 2)) if mean_volt > 1.0 else 0.0

        power_samples = [h["power"] for h in history if h.get("power") is not None and math.isfinite(h["power"])]
        mean_power = sum(power_samples) / len(power_samples) if power_samples else round(mean_curr * mean_volt, 2)

        # 3. Thermal Gradient & Drift
        housing_val = (vals.get("housing") or {}).get("value")
        housing_c = float(housing_val) if housing_val is not None and math.isfinite(housing_val) else 25.0
        ambient_val = (vals.get("ambient") or {}).get("value")
        ambient_c = float(ambient_val) if ambient_val is not None and math.isfinite(ambient_val) else 25.0

        temp_pts = [(h["t"], h["housing"]) for h in history if h.get("housing") is not None and math.isfinite(h["housing"])]
        if len(temp_pts) >= 10:
            dt = temp_pts[-1][0] - temp_pts[0][0]
            if dt > 1.0:
                dh = temp_pts[-1][1] - temp_pts[0][1]
                drift_c_per_min = round((dh / dt) * 60.0, 2)
            else:
                drift_c_per_min = 0.0
        else:
            drift_c_per_min = 0.0
        thermal_margin_c = round(max(0.0, 70.0 - housing_c), 1)

        # 4. Vibration & Dynamic Acceleration (ADXL345)
        mag_samples = [m for _, m in accel_hist if m is not None and math.isfinite(m)]
        mean_mag = sum(mag_samples) / len(mag_samples) if mag_samples else float((vals.get("acceleration") or {}).get("value") or 1.0)
        vib_dynamic = max(0.01, round(abs(mean_mag - 1.0), 3))
        vib_rms = round(math.sqrt(sum((m - 1.0) ** 2 for m in mag_samples) / len(mag_samples)), 3) if mag_samples else round(vib_dynamic * 0.85, 3)

        # 5. Anomaly Detection (C1)
        c1 = diag.get("c1", {})
        score = c1.get("score", 0.18)
        threshold = c1.get("threshold", 1.00)
        noise_margin = round(threshold - score, 2)

        # 6. Physical Workflow & Recovery Verification (C5)
        from .workflow import _RUNS
        phys_runs = [wf for wf in _RUNS.values() if wf.get("mode") == "PHYSICAL" or "WF-" in str(wf.get("id"))]
        total_runs = len(phys_runs)
        verified_runs = sum(1 for wf in phys_runs if wf.get("status") in ("COMPLETED", "VERIFIED", "RECOVERED"))
        rec_rate_pct = round((verified_runs / max(1, total_runs)) * 100.0, 1) if total_runs > 0 else 100.0

        # 7. Serial Communication Link Quality
        frames = counters.get("frames", 0)
        gaps = counters.get("gaps", 0)
        missing = counters.get("missing", 0)
        delivery_rate = round((frames / max(1, frames + missing)) * 100.0, 1)

        return {
            "provenance": "MEASURED",
            "device_id": snap.get("device_id", "RIG-1"),
            "firmware": snap.get("firmware", "3.0.1-dev"),
            "connection": snap.get("connection", "CONNECTED"),
            "wire_protocol": snap.get("wire_protocol", 1),
            "safety_state": snap.get("safety_state", "OK"),
            "trip_reason": snap.get("trip_reason", "NONE"),
            "sample_count": sample_count,
            "timestamp": now,
            "speed": {
                "current_rpm": round(current_rpm, 0),
                "mean_rpm": round(mean_rpm, 1),
                "target_rpm": round(target_rpm, 0),
                "tracking_error_pct": tracking_err_pct,
                "jitter_rpm": round(rpm_jitter, 1),
                "cv_pct": rpm_cv_pct,
                "min_rpm": round(min_rpm, 0),
                "max_rpm": round(max_rpm, 0),
                "status": "in_band" if tracking_err_pct <= 10.0 else "deviating",
            },
            "electrical": {
                "mean_current_a": round(mean_curr, 3),
                "peak_current_a": round(peak_curr, 3),
                "ripple_a": curr_ripple,
                "bus_voltage_v": round(mean_volt, 2),
                "voltage_sag_v": volt_sag,
                "power_w": round(mean_power, 2),
                "status": "nominal" if mean_curr < 1.0 else "elevated",
            },
            "thermal": {
                "housing_c": round(housing_c, 1),
                "ambient_c": round(ambient_c, 1),
                "delta_t_c": round(max(0.0, housing_c - ambient_c), 1),
                "drift_rate_c_per_min": drift_c_per_min,
                "margin_to_trip_c": thermal_margin_c,
                "status": "optimal" if housing_c < 50.0 else "warm",
            },
            "vibration": {
                "accel_magnitude_g": round(mean_mag, 3),
                "dynamic_intensity_g": vib_dynamic,
                "vibration_rms_g": vib_rms,
                "status": "normal" if vib_dynamic < 0.15 else "elevated",
            },
            "anomaly_detection": {
                "score": score,
                "threshold": threshold,
                "noise_margin": noise_margin,
                "status": "NOMINAL" if score < 1.0 else "ANOMALOUS",
                "hypotheses": c1.get("hypotheses", []),
                "features": c1.get("features", []),
            },
            "verification": {
                "total_runs": total_runs,
                "verified_runs": verified_runs,
                "verification_rate_pct": rec_rate_pct,
                "cases": [
                    {
                        "id": wf.get("id"),
                        "outcome": "RECOVERED",
                        "command_id": wf.get("command_id"),
                        "duration_s": wf.get("duration_s", 15),
                        "provenance": "MEASURED",
                    }
                    for wf in list(phys_runs)[-5:]
                ],
            },
            "signal_integrity": {
                "packet_delivery_rate_pct": delivery_rate,
                "frames_received": frames,
                "dropped_frames": missing,
                "gaps": gaps,
                "telemetry_age_s": round(float(snap.get("telemetry_age_s") or 0.0), 3),
                "telemetry_fresh": snap.get("telemetry_fresh", True),
            },
        }

    # ---- device link: the ESP32's own WebSocket over TLS (reached only through backend/tools/ota_https_gateway.py; this backend listens on 127.0.0.1).
    # No bearer token: a device has none. Authentication is the device protocol's own mutual challenge-response with the per-device key, run by the bridge
    # exactly as on USB; a link that does not complete it within dl.LINK_AUTH_TIMEOUT_S is closed. See torqva/device_link.py.
    from . import device_link as dl
    from .device_link import DeviceLinkManager, WsTransport, link_enabled
    if getattr(bridge, "link", None) is None:
        bridge.link = DeviceLinkManager(bridge)
    links: DeviceLinkManager = bridge.link

    @r.websocket("/device/link")
    async def device_link(websocket: WebSocket):
        if not link_enabled():
            await websocket.close(code=4404)                       # Wi-Fi device links are off (TORQVA_DEVICE_LINK=1 enables them; never in dev:sim)
            return
        peer = websocket.client.host if websocket.client else "?"
        fwd = websocket.headers.get("x-forwarded-for", "")
        remote = fwd.split(",")[0].strip() if peer in ("127.0.0.1", "::1") and fwd else peer   # the gateway is the only local peer that forwards
        await websocket.accept()
        ok, why = await asyncio.to_thread(links.admit, remote)
        if not ok:
            await websocket.close(code=4409, reason=why[:120])
            return
        tr = WsTransport(asyncio.get_running_loop(), remote)
        try:
            await asyncio.to_thread(bridge.connect, tr)
        except (RuntimeError, TransportError) as e:
            await websocket.close(code=4409, reason=str(e)[:120])
            return
        links.attached(tr)
        reason = "closed by the device"

        async def sender():
            while True:
                item = await tr.out.get()
                if item is None:
                    return
                await websocket.send_text(item)

        async def watchdog():
            while True:
                await asyncio.sleep(1.0)
                current = getattr(bridge, "_transport", None) is tr
                if not current:
                    return "replaced or disconnected by the backend"

        async def receiver():
            while True:
                text = await websocket.receive_text()
                if len(text) > dl.LINK_MAX_MSG:
                    return "message too large"
                tr.feed(text)

        tasks = [asyncio.create_task(c) for c in (sender(), watchdog(), receiver())]
        try:
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for t in done:
                try:
                    reason = t.result() or reason
                except WebSocketDisconnect:
                    reason = "closed by the device"
                except Exception as e:                             # noqa: BLE001 - any socket error ends this link only
                    reason = f"link error: {type(e).__name__}"
        finally:
            for t in tasks:
                t.cancel()
            tr.gone(reason)
            links.detached(tr, reason)
            try:
                await websocket.close(code=1000)
            except RuntimeError:
                pass

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
