import hashlib
import json
import threading
import time
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from torqva.api import create_router
from torqva.auth import TokenAuth
from torqva.service import SimulationService
from torqva.serial_bridge import DeviceBridge, Transport, Conn


class MockDeviceTransport(Transport):
    """Bidirectional in-memory transport simulating RIG-1 serial link."""
    kind = "usb"
    def __init__(self):
        self.written = []
        self._lines = []
        self._lock = threading.Lock()
        self.closed = False

    def open(self) -> None:
        self.closed = False

    def write(self, data: bytes) -> None:
        self.written.append(data)

    def read_line(self, timeout: float = 0.1) -> bytes:
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout:
            with self._lock:
                if self._lines:
                    return self._lines.pop(0)
            time.sleep(0.01)
        return None

    def close(self) -> None:
        self.closed = True

    def feed(self, text: str) -> None:
        with self._lock:
            for line in text.splitlines():
                if line.strip():
                    self._lines.append(line.strip().encode() + b"\n")


def test_single_operator_direct_control():
    # 1. Setup service and single-operator authenticated client
    token = "operator-token-xyz"
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    auth = TokenAuth([{"sha256": token_hash, "user": "rig1_operator", "role": "viewer"}])

    svc = SimulationService()
    bridge: DeviceBridge = svc.bridge

    app = FastAPI()
    app.include_router(create_router(svc, auth))
    client = TestClient(app)
    headers = {"Authorization": f"Bearer {token}"}

    # Verify unauthenticated boundary: no access without website login
    unauth = client.get("/api/torqva/device/status")
    assert unauth.status_code == 401, "Unauthenticated request must be rejected with 401"

    # Verify authenticated operator has direct access
    auth_resp = client.get("/api/torqva/device/status", headers=headers)
    assert auth_resp.status_code == 200, "Authenticated operator must be accepted"

    # 2. Gateway connects to RIG-1
    mock_rig = MockDeviceTransport()
    bridge.connect(mock_rig)
    assert bridge.connected

    # Feed standard status frame from RIG-1
    status_frame = json.dumps({
        "t": "status", "seq": 1, "ts": 1000, "proto": 1, "dev": "RIG-1",
        "state": "OK", "reason": "NONE", "mode": "HW", "drive": "IDLE", "ctl": 1,
        "hb_age": 10, "test": 0, "blk": "", "fm": 0, "fw": "3.1.0", "wiring": "standard",
        "limits_v": 1, "es": 2
    }) + "\n"
    mock_rig.feed(status_frame)

    # Feed standard fast telemetry frame
    fast_frame = json.dumps({
        "t": "fast", "seq": 2, "ts": 1010,
        "rpm": 0.0, "sp": 0.0, "duty": 0.0, "v": 24.1, "i": 0.45, "p": 10.8, "q": 15
    }) + "\n"
    mock_rig.feed(fast_frame)

    # Allow reader thread to ingest frames
    time.sleep(0.2)

    # 3. Verify live telemetry & immediate CONNECTED state
    st = client.get("/api/torqva/device/status", headers=headers).json()
    assert st["connection"] == "CONNECTED"
    assert st["device_id"] == "RIG-1"
    assert st["control_blockers"] == [], "No software blockers should exist for connected device"

    # 4. Test START communication path
    start_resp = client.post("/api/torqva/device/commands", headers=headers, json={
        "action": "START", "duty_pct": 25.0
    })
    assert start_resp.status_code == 200, f"START rejected: {start_resp.text}"
    start_cmd = start_resp.json()
    assert start_cmd["action"] == "START"
    assert start_cmd["state"] in ("SENT", "AUTHORIZED")

    # Verify gateway sent the command line to RIG-1
    time.sleep(0.1)
    last_written = [json.loads(line.decode().strip()) for line in mock_rig.written if b'"type":"START"' in line]
    assert len(last_written) >= 1, "START command must be written directly to device transport"
    assert last_written[-1]["type"] == "START"
    assert last_written[-1]["p"] == 25.0

    # Simulate RIG-1 acknowledging command
    cmd_id = last_written[-1]["id"]
    ack_frame = json.dumps({
        "t": "ack", "id": cmd_id, "status": "COMPLETED", "reason": "RAMPED"
    }) + "\n"
    mock_rig.feed(ack_frame)
    time.sleep(0.1)

    # 5. Test SET_SPEED communication path & direct adjustment while operating
    speed_resp = client.post("/api/torqva/device/commands", headers=headers, json={
        "action": "SET_SPEED", "rpm": 1400.0
    })
    assert speed_resp.status_code == 200
    time.sleep(0.1)
    speed_written = [json.loads(line.decode().strip()) for line in mock_rig.written if b'"type":"SET_SPEED"' in line]
    assert len(speed_written) >= 1
    assert speed_written[-1]["p"] == 1400.0

    # Adjust speed while operating
    speed2_resp = client.post("/api/torqva/device/commands", headers=headers, json={
        "action": "SET_SPEED", "rpm": 1750.0
    })
    assert speed2_resp.status_code == 200
    time.sleep(0.1)
    speed2_written = [json.loads(line.decode().strip()) for line in mock_rig.written if b'"type":"SET_SPEED"' in line]
    assert speed2_written[-1]["p"] == 1750.0

    # 6. Test STOP communication path
    stop_resp = client.post("/api/torqva/device/commands", headers=headers, json={
        "action": "STOP"
    })
    assert stop_resp.status_code == 200
    time.sleep(0.1)
    stop_written = [json.loads(line.decode().strip()) for line in mock_rig.written if b'"type":"STOP"' in line]
    assert len(stop_written) >= 1
    assert stop_written[-1]["type"] == "STOP"

    # 7. Test Reconnection behavior
    client.post("/api/torqva/device/disconnect", headers=headers)
    assert not bridge.connected
    disc_st = client.get("/api/torqva/device/status", headers=headers).json()
    assert disc_st["connection"] == "DISCONNECTED"

    # Reconnect
    mock_rig2 = MockDeviceTransport()
    bridge.connect(mock_rig2)
    mock_rig2.feed(status_frame)
    mock_rig2.feed(fast_frame)
    time.sleep(0.2)

    reconn_st = client.get("/api/torqva/device/status", headers=headers).json()
    assert reconn_st["connection"] == "CONNECTED"
    assert reconn_st["control_blockers"] == []

    # 8. Test Independent Emergency / Fault Protection
    # Hardware E-stop pressed (NC contact opens, es=1: ASSERTED)
    estop_frame = json.dumps({
        "t": "status", "seq": 10, "ts": 2000, "proto": 1, "dev": "RIG-1",
        "state": "EMERGENCY_STOP", "reason": "ESTOP_ACTIVE", "mode": "HW", "drive": "IDLE",
        "ctl": 1, "hb_age": 10, "test": 0, "blk": "ESTOP_ACTIVE", "fm": 1,
        "fw": "3.1.0", "wiring": "standard", "limits_v": 1, "es": 1
    }) + "\n"
    mock_rig2.feed(estop_frame)
    time.sleep(0.2)

    estop_st = client.get("/api/torqva/device/status", headers=headers).json()
    assert estop_st["safety_state"] == "EMERGENCY_STOP"
    assert estop_st["estop_input"]["state"] == 1

    # Cleanup
    bridge.disconnect()
