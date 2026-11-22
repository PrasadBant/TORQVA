import hashlib
import json
import time
import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from torqva.api import create_router
from torqva.auth import TokenAuth, Role
from torqva.serial_bridge import DeviceBridge, Conn
from torqva.service import SimulationService


class MockSerialTransport:
    kind = "usb"
    port = "COM7"

    def __init__(self):
        self.is_open = False
        self.written = []
        self._lines = []

    def open(self):
        self.is_open = True

    def read_line(self, timeout: float):
        if self._lines:
            return self._lines.pop(0)
        time.sleep(min(timeout, 0.05))
        return None

    def feed(self, line: str):
        self._lines.append(line.encode() if isinstance(line, str) else line)

    def write(self, data: bytes):
        self.written.append(data)

    def close(self):
        self.is_open = False


def test_universal_device_connection_and_no_blockers():
    svc = SimulationService()
    bridge: DeviceBridge = svc.bridge
    bridge.direct_mode = True
    bridge.universal_mode = True

    transport = MockSerialTransport()
    bridge.connect(transport)
    assert bridge.connected
    assert bridge.model.conn == Conn.CONNECTING

    # Simulate handshake timeout without TORQVA wire protocol status frame
    bridge._housekeeping(bridge._clock() + 6.0)

    # In universal/direct mode, the bridge must accept the device as connected instead of erroring
    assert bridge.model.conn == Conn.CONNECTED
    assert bridge.model.last_error_code == ""
    assert bridge.control_blockers() == []

    # Ingest loose JSON telemetry
    transport.feed(json.dumps({"rpm": 1420.0, "voltage": 24.2, "current": 1.85, "power": 44.77}) + "\n")
    line = transport.read_line(0.1)
    bridge._on_line(line, bridge._clock())

    snap = bridge.snapshot()
    assert snap["values"]["rpm"]["value"] == 1420.0
    assert snap["values"]["voltage"]["value"] == 24.2
    assert snap["values"]["current"]["value"] == 1.85
    assert snap["values"]["power"]["value"] == 44.77


def test_direct_mode_endpoint_unblocks_controls():
    svc = SimulationService()
    token = "admin-tok"
    auth = TokenAuth([{"sha256": hashlib.sha256(token.encode()).hexdigest(), "user": "admin", "role": "admin"}])
    app = FastAPI()
    app.include_router(create_router(svc, auth))
    client = TestClient(app)
    headers = {"Authorization": f"Bearer {token}"}

    # Enable direct mode via API
    resp = client.post("/api/torqva/device/direct_mode", json={"enabled": True}, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["direct_mode"] is True
    assert svc.bridge.direct_mode is True

    # Connect mock transport
    transport = MockSerialTransport()
    svc.bridge.connect(transport)
    svc.bridge._housekeeping(svc.bridge._clock() + 6.0)

    assert svc.bridge.model.conn == Conn.CONNECTED
    assert svc.bridge.control_blockers() == []

    # Send command
    cmd_resp = client.post("/api/torqva/device/commands", json={"action": "START", "duty_pct": 30.0}, headers=headers)
    assert cmd_resp.status_code == 200
    assert cmd_resp.json()["action"] == "START"
    assert cmd_resp.json()["state"] in ("SENT", "ACKNOWLEDGED")
