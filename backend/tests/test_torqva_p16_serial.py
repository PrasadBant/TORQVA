"""USB-serial bridge, device model, command lifecycle, REST and WebSocket. NO real serial port is ever opened: tests use MemoryTransport, or the REAL C++ firmware core
(fitl CLI, SimPlant) behind a pipe adapter. Nothing here is hardware validation."""
import hashlib
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva import serial_bridge as sb
from torqva.api import create_router, install_error_handlers
from torqva.auth import TokenAuth
from torqva.schemas import Role
from torqva.serial_bridge import CmdState, Conn, DeviceBridge, DeviceModel, FrameError, MemoryTransport, PhysicalControlPolicy, TransportError, parse_frame
from torqva.service import SimulationService

FITL = Path(__file__).resolve().parents[2] / "esp32" / "torqva_fw" / ".pio" / "build" / "fitl" / "program.exe"


def fast(seq, rpm=1200.0, q=63, i=1.5, v=24.0, duty=30.0):
    return json.dumps({"t": "fast", "seq": seq, "ts": (seq * 100) % 2 ** 32, "rpm": rpm, "sp": 0.0, "duty": duty, "v": v, "i": i, "p": round(v * i, 2), "q": q})


def slow(seq, housing=31.5, q=63):
    return json.dumps({"t": "slow", "seq": seq, "ts": (seq * 100) % 2 ** 32, "housing": housing, "ambient": 22.0, "q": q})


def status(seq, mode="HW", dev="RIG-1", blk="LIMITS_NOT_APPROVED", state="OK", reason="NONE", proto=1, fm=0, drive="IDLE"):
    return json.dumps({"t": "status", "seq": seq, "ts": (seq * 100) % 2 ** 32, "fw": "3.0.0", "wiring": "W1", "limits_v": 1, "state": state, "reason": reason, "mode": mode, "drive": drive, "ctl": 0,
                       "hb_age": 4294967295, "test": 0, "proto": proto, "dev": dev, "blk": blk, "fm": fm})


def wait(cond, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return cond()


def connected_bridge(mode="HW", dev="RIG-1", expected=None, policy=None):
    b = DeviceBridge(expected_device_id=expected, policy=policy)
    tr = MemoryTransport()
    b.connect(tr)
    tr.feed(status(0, mode=mode, dev=dev))
    assert wait(lambda: b.model.conn == Conn.CONNECTED), b.model.last_error
    return b, tr


# =============================================================================================== parser
def test_valid_frames_parse():
    assert parse_frame(fast(1))["rpm"] == 1200.0
    assert parse_frame(slow(2))["housing"] == 31.5
    assert parse_frame(status(3))["proto"] == 1
    assert parse_frame('{"t":"ack","id":7,"status":"ACCEPTED","reason":"OK","dev":"RIG-1","sid":"abc"}')["dev"] == "RIG-1"


@pytest.mark.parametrize("line,code", [
    (b"x" * 600, "OVERSIZE"), (b"{broken", "MALFORMED"), (b"\xff\xfe", "MALFORMED"), (b"[1]", "MALFORMED"), (b'{"t":"mystery"}', "UNKNOWN_TYPE"),
    (fast(1).replace("1200.0", "NaN").encode(), "NON_FINITE_NUMBER"), (fast(1).replace("1200.0", "Infinity").encode(), "NON_FINITE_NUMBER"),
    (fast(1, rpm=1e9).encode(), "OUT_OF_RANGE"), (fast(1, v=500.0).encode(), "OUT_OF_RANGE"), (fast(1, q=64).encode(), "BAD_FIELD"),
    (fast(1).replace('"seq": 1', '"seq": -1').encode(), "BAD_FIELD"), (json.dumps({"t": "fast", "seq": 1}).encode(), "BAD_FIELD"),
    (status(1, proto=2).encode(), "UNSUPPORTED_PROTOCOL"), (status(1).replace('"proto": 1,', "").encode(), "UNSUPPORTED_PROTOCOL"),
    (status(1, mode="ODD").encode(), "BAD_FIELD"), (status(1, state="FINE").encode(), "BAD_FIELD"),
    (b'{"t":"ack","id":1,"status":"DONE","reason":""}', "BAD_ACK_STATUS"),
])
def test_invalid_frames_are_rejected_with_a_code(line, code):
    with pytest.raises(FrameError) as e:
        parse_frame(line)
    assert e.value.code == code


# =============================================================================================== device model
def test_invalid_sensors_are_none_never_zero_and_vibration_is_unavailable():
    m = DeviceModel()
    m.ingest(parse_frame(fast(0, q=63 & ~16 & ~2)), 1.0, 100.0)                  # rpm and voltage bits clear
    s = m.snapshot(1.1)
    assert s["values"]["rpm"]["value"] is None and s["values"]["rpm"]["valid"] is False
    assert s["values"]["voltage"]["value"] is None
    assert s["values"]["power"]["value"] is None                                  # derived from an invalid input -> invalid
    assert s["values"]["current"]["value"] == 1.5
    assert s["values"]["vibration"] == {"value": None, "valid": False, "stale": False, "origin": "unavailable", "note": "the firmware does not measure vibration or acceleration yet"}
    assert m.history[-1]["rpm"] is None                                           # a gap in the chart, not a zero


def test_sequence_gaps_duplicates_and_restarts_are_counted_and_duplicates_do_not_update_state():
    m = DeviceModel()
    assert m.ingest(parse_frame(fast(10)), 1.0, 100.0) == []
    assert m.ingest(parse_frame(fast(11)), 1.1, 100.1) == []
    assert m.ingest(parse_frame(fast(15, rpm=999.0)), 1.2, 100.2) == ["gap"] and m.counters["missing"] == 3
    n = len(m.history)
    assert m.ingest(parse_frame(fast(15, rpm=5.0)), 1.3, 100.3) == ["duplicate"] and len(m.history) == n and m.values["rpm"]["value"] == 999.0
    assert "restart" in m.ingest(parse_frame(fast(2)), 1.4, 100.4) and m.counters["restarts"] == 1          # sequence went backwards
    m2 = DeviceModel(); m2.ingest(parse_frame(fast(2 ** 32 - 1)), 1.0, 1.0)
    assert m2.ingest(parse_frame(fast(0)), 1.1, 1.1) == []                                                        # uint32 wrap is NOT a restart


def test_history_is_bounded():
    m = DeviceModel()
    for i in range(sb.HISTORY_SAMPLES + 500):
        m.ingest(parse_frame(fast(i)), float(i), float(i))
    assert len(m.history) == sb.HISTORY_SAMPLES


def test_telemetry_goes_stale_and_is_never_presented_as_live():
    m = DeviceModel(); m.conn = Conn.CONNECTED
    m.ingest(parse_frame(fast(0)), 10.0, 10.0)
    assert m.snapshot(10.5)["telemetry_fresh"] is True
    s = m.snapshot(10.0 + sb.STALE_AFTER_S + 1)
    assert s["telemetry_fresh"] is False and s["values"]["rpm"]["stale"] is True


# =============================================================================================== bridge with a memory transport
def test_connection_states_handshake_and_physical_label_only_after_a_valid_hw_status():
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr)
    assert b.snapshot()["label"] == "SIMULATION" and b.model.conn == Conn.CONNECTING
    tr.feed(fast(0)); time.sleep(0.1)
    assert b.model.conn == Conn.CONNECTING and b.snapshot()["origin"] == "none"            # telemetry alone is not a handshake
    tr.feed(status(1, mode="HW"))
    assert wait(lambda: b.model.conn == Conn.CONNECTED)
    s = b.snapshot()
    assert s["label"] == "PHYSICAL DEVICE" and s["origin"] == "physical_device" and s["identity"] == "unverified" and s["device_id"] == "RIG-1"
    b.disconnect()


def test_a_device_in_firmware_simulation_mode_is_not_labelled_physical():
    b, tr = connected_bridge(mode="SIM")
    s = b.snapshot()
    assert s["origin"] == "device_firmware_simulation" and s["label"] != "PHYSICAL DEVICE"
    assert "DEVICE IS NOT A PHYSICAL DEVICE (FIRMWARE SIMULATION MODE)" in s["control_blockers"]
    b.disconnect()


def test_unsupported_protocol_or_identity_mismatch_never_connects():
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr)
    tr.feed(status(0, proto=2)); time.sleep(0.2)
    assert b.model.conn == Conn.CONNECTING and b.model.counters["unsupported_protocol"] == 1
    b.disconnect()
    b = DeviceBridge(expected_device_id="RIG-1"); tr = MemoryTransport(); b.connect(tr)
    tr.feed(status(0, dev="RIG-9"))
    assert wait(lambda: not b.connected) and b.model.conn == Conn.DISCONNECTED and "mismatch" in b.model.last_error and tr.is_open is False
    b, tr = connected_bridge(expected="RIG-1"); assert b.snapshot()["identity"] == "verified"; b.disconnect()


def test_unplugging_disconnects_releases_the_port_and_reconnect_works_one_owner_at_a_time():
    b, tr = connected_bridge()
    with pytest.raises(RuntimeError):
        b.connect(MemoryTransport())                                                    # second owner refused
    tr.disconnect_device()
    assert wait(lambda: not b.connected) and tr.is_open is False and b.model.conn == Conn.DISCONNECTED
    ev = b.hub.subscribe()
    tr2 = MemoryTransport(); b.connect(tr2); tr2.feed(status(0)); assert wait(lambda: b.model.conn == Conn.CONNECTED)
    b.disconnect(); assert tr2.is_open is False and not b.connected


def test_open_failure_is_a_clear_error_and_leaves_nothing_open():
    class Broken(MemoryTransport):
        def open(self):
            raise TransportError("cannot open COM250: not found")
    b = DeviceBridge()
    with pytest.raises(TransportError):
        b.connect(Broken())
    assert b.model.conn == Conn.ERROR and "COM250" in b.model.last_error and not b.connected


def test_stale_telemetry_event_and_state(monkeypatch):
    monkeypatch.setattr(sb, "STALE_AFTER_S", 0.3)
    b, tr = connected_bridge(); ev = b.hub.subscribe()
    tr.feed(fast(1)); assert wait(lambda: b.model.last_fast_rx is not None)
    assert wait(lambda: b.model.conn == Conn.STALE, 3)
    names = [e["name"] for e in ev.drain(False)]
    assert "telemetry_stale" in names and b.snapshot()["telemetry_fresh"] is False
    tr.feed(fast(2)); assert wait(lambda: b.model.conn == Conn.CONNECTED)             # recovers when frames resume
    b.disconnect()


def test_malformed_oversized_and_nonfinite_lines_are_counted_and_never_change_values():
    b, tr = connected_bridge()
    tr.feed(fast(1)); assert wait(lambda: b.model.values.get("rpm"))
    before = dict(b.model.values["rpm"])
    for bad in (b"garbage", b"x" * 700, fast(2).replace("1200.0", "NaN"), fast(2, rpm=1e9)):
        tr.feed(bad)
    assert wait(lambda: b.model.counters["malformed"] == 4)
    assert b.model.values["rpm"] == before
    b.disconnect()


# =============================================================================================== command lifecycle and blocking
def sent_ids(tr):
    return [json.loads(w)["id"] for w in tr.written]


def test_stop_is_sendable_correlated_by_id_and_acknowledgement_is_not_execution():
    b, tr = connected_bridge(expected="RIG-1")
    rec = b.request_command("STOP", {}, "vera", Role.VIEWER)
    assert rec.state == CmdState.SENT and len(tr.written) == 1
    msg = json.loads(tr.written[0]); assert msg["type"] == "STOP" and msg["id"] == rec.id and msg["k"] == ""
    tr.feed(json.dumps({"t": "ack", "id": rec.id, "status": "ACCEPTED", "reason": "OK", "dev": "RIG-1"}))
    assert wait(lambda: rec.state == CmdState.ACKNOWLEDGED)
    tr.feed(json.dumps({"t": "ack", "id": rec.id, "status": "COMPLETED", "reason": "STOPPED", "dev": "RIG-1"}))
    assert wait(lambda: rec.state == CmdState.EXECUTED)
    tr.feed(json.dumps({"t": "ack", "id": rec.id, "status": "ACCEPTED", "reason": "OK", "dev": "RIG-1"})); time.sleep(0.1)
    assert rec.state == CmdState.EXECUTED                                              # a late duplicate never reopens a finished command
    b.disconnect()


def test_wrong_device_unknown_id_and_rejected_command_acks_are_handled_safely():
    b, tr = connected_bridge(expected="RIG-1")
    rec = b.request_command("STOP", {}, "vera", Role.VIEWER)
    tr.feed(json.dumps({"t": "ack", "id": rec.id, "status": "COMPLETED", "reason": "STOPPED", "dev": "RIG-2"}))              # another device
    tr.feed(json.dumps({"t": "ack", "id": rec.id + 999, "status": "COMPLETED", "reason": "", "dev": "RIG-1"}))                # not our command
    assert wait(lambda: b.model.counters["malformed"] == 2)
    assert rec.state == CmdState.SENT
    tr.feed(json.dumps({"t": "ack", "id": rec.id, "status": "REJECTED", "reason": "UNAUTHORIZED", "dev": "RIG-1"}))
    assert wait(lambda: rec.state == CmdState.FAILED) and rec.reasons == ["UNAUTHORIZED"]
    b.disconnect()


def test_command_without_acknowledgement_times_out_and_is_never_retried(monkeypatch):
    monkeypatch.setattr(sb, "COMMAND_TIMEOUT_S", 0.3)
    b, tr = connected_bridge()
    rec = b.request_command("STOP", {}, "vera", Role.VIEWER)
    assert wait(lambda: rec.state == CmdState.TIMED_OUT, 3)
    time.sleep(0.5)
    assert len(tr.written) == 1                                                       # one write, ever
    b.disconnect()


def test_physical_start_and_speed_are_blocked_with_the_applicable_reasons_and_nothing_is_written():
    b, tr = connected_bridge()
    for action, params in (("START", {"duty_pct": 30}), ("SET_SPEED", {"rpm": 1500})):
        rec = b.request_command(action, params, "olga", Role.OPERATOR)
        assert rec.state == CmdState.REJECTED
        txt = " | ".join(rec.reasons)
        assert "hardware_control_not_enabled" in txt or "PHYSICAL CONTROL DISABLED" in txt
    blockers = b.control_blockers()
    assert "PHYSICAL CONTROL DISABLED" in blockers and "SECURE DEVICE TRANSPORT NOT CONFIGURED" in blockers and "SAFETY LIMITS NOT APPROVED" in blockers
    assert tr.written == []
    b.disconnect()


def test_even_with_the_policy_flag_on_the_secure_transport_requirement_still_blocks_physical_motion():
    b, tr = connected_bridge(policy=PhysicalControlPolicy(physical_control_enabled=True))
    assert "PHYSICAL CONTROL DISABLED" not in b.control_blockers()
    rec = b.request_command("START", {"duty_pct": 30}, "olga", Role.OPERATOR)
    assert rec.state == CmdState.REJECTED and tr.written == []                        # the supervisor context never enables hardware control either
    b.disconnect()


def test_unsupported_and_invalid_commands_and_stop_while_disconnected_are_rejected():
    b = DeviceBridge()
    assert b.request_command("STOP", {}, "vera", Role.VIEWER).reasons == ["DEVICE NOT CONNECTED"]
    for action, params in (("FORMAT_DISK", {}), ("START", {"duty_pct": float("nan")}), ("SET_SPEED", {"rpm": "fast"}), ("START", {})):
        assert b.request_command(action, params, "olga", Role.OPERATOR).state == CmdState.REJECTED


def test_reconnect_or_device_restart_never_replays_a_pending_command():
    b, tr = connected_bridge()
    rec = b.request_command("STOP", {}, "vera", Role.VIEWER)
    tr.disconnect_device()
    assert wait(lambda: not b.connected) and rec.state == CmdState.UNKNOWN_OUTCOME
    tr2 = MemoryTransport(); b.connect(tr2); tr2.feed(status(0)); assert wait(lambda: b.model.conn == Conn.CONNECTED)
    time.sleep(0.3)
    assert tr2.written == [] and rec.state == CmdState.UNKNOWN_OUTCOME                 # nothing is re-sent; the operator must act again
    rec2 = b.request_command("STOP", {}, "vera", Role.VIEWER)
    tr2.feed(fast(5)); tr2.feed(fast(6)); tr2.feed(fast(1))                            # sequence goes backwards: the device restarted
    assert wait(lambda: rec2.state == CmdState.UNKNOWN_OUTCOME)
    b.disconnect()


def test_write_failure_marks_the_command_failed_without_retry():
    b, tr = connected_bridge(); tr.fail_writes = True
    rec = b.request_command("STOP", {}, "vera", Role.VIEWER)
    assert rec.state == CmdState.FAILED and "write failed" in rec.reasons[0]
    b.disconnect()


def test_safety_fault_status_is_published_and_listed_as_a_blocker():
    b, tr = connected_bridge(); ev = b.hub.subscribe()
    tr.feed(status(1, state="EMERGENCY_STOP", reason="OVER_CURRENT_INSTANT", fm=2 ** 1, blk="SAFETY_NOT_OK"))
    assert wait(lambda: b.model.status["state"] == "EMERGENCY_STOP")
    names = [e["name"] for e in ev.drain(False)]
    assert "safety_fault_latched" in names and "device_state_changed" in names
    assert any(x.startswith("SAFETY FAULT LATCHED") for x in b.control_blockers())
    b.disconnect()


def test_event_hub_is_bounded_and_coalesces_telemetry():
    hub = sb.EventHub(max_queue=5); c = hub.subscribe()
    for i in range(50):
        hub.publish("command_sent", {"i": i})
        hub.publish("telemetry", {"i": i})
    out = c.drain(True)
    assert len([e for e in out if e["name"] == "command_sent"]) == 5 and c.dropped == 45
    assert len([e for e in out if e["name"] == "telemetry"]) == 1 and [e for e in out if e["name"] == "telemetry"][0]["data"]["i"] == 49


# =============================================================================================== real firmware core behind a pipe (not hardware)
class FitlTransport(sb.Transport):
    """Runs the REAL C++ torqva_core Device (fitl CLI with its SimPlant) and exposes it through the Transport interface."""

    def __init__(self, *flags):
        self.flags, self.p, self._lines, self._cv, self._lock = flags, None, [], threading.Condition(), threading.Lock()

    def open(self):
        self.p = subprocess.Popen([str(FITL), *self.flags], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

    def _io(self, text):
        with self._lock:
            self.p.stdin.write(text + "\n"); self.p.stdin.flush()
            out = []
            while True:
                l = self.p.stdout.readline().strip()
                if l == "#":
                    break
                out.append(l)
        with self._cv:
            self._lines += out; self._cv.notify()

    def advance(self, ms):
        self._io(json.dumps({"tick": ms}))

    def read_line(self, timeout):
        with self._cv:
            if not self._lines:
                self._cv.wait(timeout)
            return self._lines.pop(0).encode() if self._lines else None

    def write(self, data):
        self._io(data.decode().strip())

    def close(self):
        try:
            self.p.stdin.close(); self.p.wait(timeout=3)
        except Exception:
            pass


@pytest.mark.skipif(not FITL.exists(), reason="fitl CLI not built (pio run -e fitl)")
def test_bridge_with_the_real_firmware_core_telemetry_identity_interlock_reason_and_stop_roundtrip():
    tr = FitlTransport("--strict")
    b = DeviceBridge(expected_device_id="FITL-1"); b.connect(tr)
    for _ in range(3):
        tr.advance(500)
    assert wait(lambda: b.model.conn == Conn.CONNECTED and b.model.values.get("rpm"))
    s = b.snapshot()
    assert s["identity"] == "verified" and s["wire_protocol"] == 1 and s["firmware_mode"] == "SIM" and s["origin"] == "device_firmware_simulation"   # a firmware SIM build is never "physical"
    assert s["start_blocked_reason"] == "LIMITS_NOT_APPROVED"                                  # the device itself explains why motion is not permitted
    assert s["values"]["housing"]["valid"] is True and s["values"]["vibration"]["origin"] == "unavailable"
    assert b.request_command("START", {"duty_pct": 30}, "olga", Role.OPERATOR).state == CmdState.REJECTED
    rec = b.request_command("STOP", {}, "vera", Role.VIEWER)                                   # STOP needs no key and no session: the real core accepts and completes it
    assert wait(lambda: rec.state == CmdState.EXECUTED), (rec.state, rec.reasons)
    b.disconnect(); tr.close()


# =============================================================================================== REST + WebSocket
def entry(token, user, role):
    return {"sha256": hashlib.sha256(token.encode()).hexdigest(), "user": user, "role": role}


H = lambda t: {"Authorization": f"Bearer {t}"}
ENTRIES = [entry("v", "vera", "viewer"), entry("o", "olga", "operator"), entry("a", "adam", "admin")]


@pytest.fixture()
def api():
    svc = SimulationService()
    app = FastAPI(); app.include_router(create_router(svc, TokenAuth(ENTRIES))); install_error_handlers(app)
    c = TestClient(app, raise_server_exceptions=False)
    yield svc, c
    svc.bridge.disconnect()


def test_simulation_mode_works_without_hardware_and_the_device_page_says_simulation(api):
    svc, c = api
    s = c.get("/api/torqva/device/status", headers=H("v")).json()
    assert s["label"] == "SIMULATION" and s["connection"] == "DISCONNECTED" and s["origin"] == "none" and s["physical_control_enabled"] is False
    assert "DEVICE NOT CONNECTED" in s["control_blockers"] and s["values"]["rpm"] is None
    assert c.post("/api/torqva/simulation/start", headers=H("o"), json={"fault": None}).status_code == 200
    assert c.get("/api/torqva/status", headers=H("v")).json()["mode"] == "SIMULATION"


def test_device_routes_enforce_authentication_and_roles(api):
    svc, c = api
    for method, path, body in (("GET", "/device/status", None), ("GET", "/device/commands", None), ("POST", "/device/commands", {"action": "STOP"})):
        assert c.request(method, "/api/torqva" + path, json=body).status_code == 401
    assert c.get("/api/torqva/device/ports", headers=H("o")).status_code == 403
    assert c.post("/api/torqva/device/connect", headers=H("o"), json={"port": "COM250"}).status_code == 403
    assert c.post("/api/torqva/device/disconnect", headers=H("v")).status_code == 403
    assert c.post("/api/torqva/device/commands", headers=H("v"), json={"action": "START", "duty_pct": 20}).status_code == 403
    r = c.post("/api/torqva/device/commands", headers=H("o"), json={"action": "START", "duty_pct": 20}).json()
    assert r["state"] == "REJECTED" and "PHYSICAL CONTROL DISABLED" in r["reasons"]


def test_connect_validates_the_port_and_baud_and_never_opens_a_real_port_in_tests(api):
    svc, c = api
    for bad in ({"port": "../../etc/passwd"}, {"port": "COM1; rm"}, {"port": "COM250", "baud": 5}, {"port": "COM250", "baud": 10 ** 9}, {"port": "COM250", "expected_device_id": "bad id!"}, {}):
        assert c.post("/api/torqva/device/connect", headers=H("a"), json=bad).status_code == 422
    r = c.post("/api/torqva/device/connect", headers=H("a"), json={"port": "COM250"})        # a port that does not exist: a clear error, nothing left open
    assert r.status_code == 502 and "COM250" in r.json()["detail"] and not svc.bridge.connected


def test_status_history_and_commands_over_rest_with_a_connected_memory_device(api):
    svc, c = api
    tr = MemoryTransport(); svc.bridge.connect(tr)
    tr.feed(status(0)); tr.feed(slow(1)); tr.feed(fast(2)); tr.feed(fast(3, q=63 & ~16))
    assert wait(lambda: len(svc.bridge.model.history) == 2)
    j = c.get("/api/torqva/device/history?signal=rpm&seconds=60", headers=H("v")).json()
    assert [p[1] for p in j["points"]] == [1200.0, None] and j["origin"] == "physical_device"
    assert c.get("/api/torqva/device/history?signal=vibration", headers=H("v")).status_code == 422
    r = c.post("/api/torqva/device/commands", headers=H("v"), json={"action": "STOP"}).json()
    assert r["state"] == "SENT"
    assert [x["state"] for x in c.get("/api/torqva/device/commands", headers=H("v")).json()["commands"]] == ["SENT"]
    assert c.post("/api/torqva/device/commands", headers=H("v"), json={"action": "STOP", "rpm": float("1e999") if False else 5}).status_code == 200


def test_websocket_requires_the_auth_first_message_and_rejects_bad_tokens_and_timeouts(api, monkeypatch):
    from torqva import device_routes
    svc, c = api
    monkeypatch.setattr(device_routes, "WS_AUTH_TIMEOUT_S", 0.4)
    with pytest.raises(Exception):
        with c.websocket_connect("/api/torqva/ws") as ws:                           # no auth message -> closed
            ws.receive_text()
    for first in ('{"type":"auth","token":"nope"}', '{"type":"hello"}', "not json", '{"type":"auth","token":5}', "x" * 5000):
        with pytest.raises(Exception):
            with c.websocket_connect("/api/torqva/ws") as ws:
                ws.send_text(first); ws.receive_text()
    assert svc.bridge.hub.client_count == 0


def test_websocket_streams_events_is_read_only_and_cleans_up_on_disconnect(api):
    svc, c = api
    tr = MemoryTransport(); svc.bridge.connect(tr); tr.feed(status(0)); assert wait(lambda: svc.bridge.model.conn == Conn.CONNECTED)
    with c.websocket_connect("/api/torqva/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": "v"}))
        snap = ws.receive_json()
        assert snap["type"] == "snapshot" and snap["data"]["label"] == "PHYSICAL DEVICE"
        for i in range(1, 40):
            tr.feed(fast(i))
        seen = []
        end = time.time() + 1.5
        while time.time() < end and not any(e.get("name") == "telemetry" for e in seen):
            seen.append(ws.receive_json())
        tele = [e for e in seen if e.get("name") == "telemetry"]
        assert tele and tele[0]["data"]["telemetry_fresh"] is True                     # telemetry is flowing and carries freshness
        ws.send_text(json.dumps({"type": "ping"}));
        got = []
        for _ in range(60):
            m = ws.receive_json(); got.append(m)
            if m.get("type") == "pong":
                break
        assert any(m.get("type") == "pong" for m in got)
        assert len([m for m in got if m.get("name") == "telemetry"]) <= 10             # throttled/coalesced, not 40
        before = len(svc.bridge.command_list())
        ws.send_text(json.dumps({"type": "command", "action": "START"}))             # the socket is read-only: a command is refused and the socket closed
        with pytest.raises(Exception):
            for _ in range(80):
                ws.receive_json()
        assert len(svc.bridge.command_list()) == before
    assert wait(lambda: svc.bridge.hub.client_count == 0)
    svc.bridge.disconnect()


def test_websocket_disconnect_event_reaches_clients_and_marks_the_device_disconnected(api):
    svc, c = api
    tr = MemoryTransport(); svc.bridge.connect(tr); tr.feed(status(0)); assert wait(lambda: svc.bridge.model.conn == Conn.CONNECTED)
    with c.websocket_connect("/api/torqva/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": "o"})); ws.receive_json()
        tr.disconnect_device()
        names = []
        end = time.time() + 2
        while time.time() < end and "device_disconnected" not in names:
            names.append(ws.receive_json().get("name"))
        assert "device_disconnected" in names and "connection_error" in names
    assert svc.bridge.snapshot()["label"] == "SIMULATION"
