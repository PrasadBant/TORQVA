"""Serial open/ownership failures that TORQVA itself owns (classification, truthful errors, serialised connects, cleanup). pyserial and the OS are MOCKED: these tests do not
claim anything about Windows or the CH343 driver, and no real port is ever opened."""
import hashlib
import json
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
from torqva.serial_bridge import CmdState, Conn, DeviceBridge, MemoryTransport, SerialTransport, TransportError, classify_open_error
from torqva.service import SimulationService

# the exact text pyserial 3.5 produced for the operator on COM7
REAL_COM7 = "could not open port 'COM7': PermissionError(13, 'Access is denied.', None, 5)"


def status(seq, **kw):
    f = {"t": "status", "seq": seq, "ts": seq * 100, "fw": "3.0.0", "wiring": "W", "limits_v": 1, "state": "OK", "reason": "NONE", "mode": "HW", "drive": "IDLE", "ctl": 0, "hb_age": 4294967295,
         "test": 0, "proto": 1, "dev": "RIG-1", "blk": "LIMITS_NOT_APPROVED", "fm": 0}
    f.update(kw)
    return json.dumps(f)


def wait(cond, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return cond()


# ---------------------------------------------------------------------------------------------------- classification from the exact error text
@pytest.mark.parametrize("exc,code", [
    (Exception(REAL_COM7), "ACCESS_DENIED"),
    (PermissionError(13, "Access is denied.", None, 5), "ACCESS_DENIED"),
    (Exception("could not open port 'COM9': FileNotFoundError(2, 'The system cannot find the file specified.', None, 2)"), "PORT_NOT_FOUND"),
    (FileNotFoundError(2, "no such file"), "PORT_NOT_FOUND"),
    (Exception("could not open port 'COM7': OSError(22, 'A device attached to the system is not functioning.', None, 31)"), "DEVICE_ERROR"),
    (Exception("could not open port 'COM7': OSError(22, 'The semaphore timeout period has expired.', None, 121)"), "DEVICE_ERROR"),
    (Exception("could not open port 'COM7': TimeoutError('timed out')"), "OPEN_TIMEOUT"),
    (Exception("something unexpected"), "OPEN_FAILED"),
])
def test_open_errors_are_classified_from_the_real_error_text(exc, code):
    assert classify_open_error(exc)[0] == code


def test_access_denied_is_never_reported_as_port_in_use():
    code, detail = classify_open_error(Exception(REAL_COM7))
    summary = sb.ERROR_HELP[code][0].lower()
    assert code == "ACCESS_DENIED" and "already in use" not in summary and "in use" not in summary
    assert "REAL" not in detail and "PermissionError(13" in detail                  # the exact underlying error is kept
    assert any("another program" in r.lower() for r in sb.ERROR_HELP[code][1])         # the recovery text says another program MAY hold it: it cannot know


class FakeSerialModule:
    """Stands in for the pyserial module: Serial() raises the configured error, exactly like pyserial on Windows."""
    class SerialException(Exception):
        pass

    def __init__(self, message):
        self.message = message
        self.calls = 0

    def Serial(self, *a, **k):
        self.calls += 1
        raise self.SerialException(self.message)


def install_fake_serial(monkeypatch, message):
    fake = FakeSerialModule(message)
    monkeypatch.setitem(sys.modules, "serial", fake)
    return fake


def test_serial_transport_open_maps_access_denied_and_port_vanished(monkeypatch):
    install_fake_serial(monkeypatch, REAL_COM7)
    with pytest.raises(TransportError) as e:
        SerialTransport("COM7").open()
    assert e.value.code == "ACCESS_DENIED" and "PermissionError(13" in e.value.detail
    install_fake_serial(monkeypatch, "could not open port 'COM7': FileNotFoundError(2, 'The system cannot find the file specified.', None, 2)")   # unplugged between listing and open
    with pytest.raises(TransportError) as e:
        SerialTransport("COM7").open()
    assert e.value.code == "PORT_NOT_FOUND"


def test_bridge_records_the_classified_error_and_leaves_nothing_open(monkeypatch):
    install_fake_serial(monkeypatch, REAL_COM7)
    b = DeviceBridge()
    with pytest.raises(TransportError):
        b.connect(SerialTransport("COM7"))
    snap = b.snapshot()
    assert snap["connection"] == "ERROR" and snap["error"]["code"] == "ACCESS_DENIED" and not b.connected and b._thread is None
    assert "PermissionError(13" in snap["error"]["detail"] and snap["error"]["recovery"] and snap["label"] == "SIMULATION" and snap["origin"] == "none"


def test_open_failure_then_a_fresh_retry_succeeds_and_clears_the_error():
    class FlakyOnce(MemoryTransport):
        opened = 0

        def open(self):
            FlakyOnce.opened += 1
            if FlakyOnce.opened == 1:
                raise TransportError("cannot open COM7: denied", "ACCESS_DENIED", REAL_COM7)
            super().open()
    b = DeviceBridge()
    t = FlakyOnce()
    with pytest.raises(TransportError):
        b.connect(t)
    assert b.model.last_error_code == "ACCESS_DENIED"
    b.connect(t)                                                                       # the operator tries again: not blocked by the failed attempt
    t.feed(status(0))
    assert wait(lambda: b.model.conn == Conn.CONNECTED) and b.snapshot()["error"] is None
    b.disconnect()


# ---------------------------------------------------------------------------------------------------- serialised connects
class SlowOpen(MemoryTransport):
    opens = 0
    lock = threading.Lock()

    def open(self):
        with SlowOpen.lock:
            SlowOpen.opens += 1
        time.sleep(0.4)
        super().open()


def test_concurrent_connect_requests_open_the_port_exactly_once_and_do_not_corrupt_the_state():
    SlowOpen.opens = 0
    b = DeviceBridge()
    results, ts = [], [SlowOpen(), SlowOpen()]

    def go(tr):
        try:
            b.connect(tr); results.append("ok")
        except RuntimeError as e:
            results.append("busy:" + str(e))
    th = [threading.Thread(target=go, args=(t,)) for t in ts]
    [t.start() for t in th]; [t.join() for t in th]
    assert sorted(r.split(":")[0] for r in results) == ["busy", "ok"] and SlowOpen.opens == 1
    assert b.model.conn == Conn.CONNECTING and b.model.last_error_code == "" and b.connected      # the loser did not overwrite the winner's state
    with pytest.raises(RuntimeError):
        b.connect(MemoryTransport())                                                    # repeated request while connected
    b.disconnect()
    assert not b.connected and b.model.conn == Conn.DISCONNECTED


def test_disconnect_during_a_blocked_read_releases_the_port_and_stops_the_reader():
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr)
    th = b._thread
    time.sleep(0.3)                                                                      # the reader is blocked in read_line(timeout)
    t0 = time.time()
    b.disconnect()
    assert time.time() - t0 < 2 and tr.is_open is False and not th.is_alive() and not b.connected


def test_backend_shutdown_closes_the_port_and_marks_unfinished_commands_unknown(monkeypatch):
    import main
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr); tr.feed(status(0)); assert wait(lambda: b.model.conn == Conn.CONNECTED)
    rec = b.request_command("STOP", {}, "vera", Role.VIEWER)
    assert rec.state == CmdState.SENT
    class Svc:
        bridge = b
    monkeypatch.setattr(main, "_torqva_service", Svc())
    main.shutdown_torqva_bridge()
    assert tr.is_open is False and rec.state == CmdState.UNKNOWN_OUTCOME and not b.connected
    main.shutdown_torqva_bridge()                                                       # idempotent, never raises
    monkeypatch.setattr(main, "_torqva_service", None)
    main.shutdown_torqva_bridge()


def test_nothing_opens_a_serial_port_at_import_or_service_start(monkeypatch):
    fake = install_fake_serial(monkeypatch, REAL_COM7)
    svc = SimulationService()
    assert fake.calls == 0 and not svc.bridge.connected and svc.bridge.model.conn == Conn.DISCONNECTED


# ---------------------------------------------------------------------------------------------------- handshake diagnostics
def test_open_port_without_any_valid_frame_reports_handshake_timeout_without_retry_or_disconnect(monkeypatch):
    monkeypatch.setattr(sb, "HANDSHAKE_TIMEOUT_S", 0.3)
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr)
    assert wait(lambda: b.model.last_error_code == "HANDSHAKE_TIMEOUT", 3)
    s = b.snapshot()
    assert s["connection"] == "CONNECTING" and s["label"] == "SIMULATION" and s["handshake"] is False and tr.is_open and tr.written == []        # nothing was sent
    tr.feed(status(0)); assert wait(lambda: b.model.conn == Conn.CONNECTED) and b.snapshot()["error"] is None                                  # a late valid handshake clears it
    b.disconnect()


def test_garbage_or_wrong_protocol_data_is_an_invalid_handshake_never_a_device(monkeypatch):
    monkeypatch.setattr(sb, "HANDSHAKE_TIMEOUT_S", 0.3)
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr)
    tr.feed(b"\x00\xffgarbage boot log ets Jul 29 2019"); tr.feed(status(1, proto=2)); tr.feed(b"x" * 900)
    assert wait(lambda: b.model.last_error_code == "HANDSHAKE_INVALID", 3)
    s = b.snapshot()
    assert s["handshake"] is False and s["origin"] == "none" and s["label"] == "SIMULATION" and "unsupported-protocol" in s["error"]["detail"]
    b.disconnect()


def test_rejected_lines_are_kept_as_escaped_bounded_samples_for_admins_only(api):
    svc, c = api
    tr = MemoryTransport(); svc.bridge.connect(tr)
    for i in range(8):
        tr.feed(b"[WiFi] connecting to MySSID \x00\xff attempt %d " % i + b"x" * 300)
    assert wait(lambda: svc.bridge.model.counters["malformed"] == 8)
    adm = c.get("/api/torqva/device/status", headers=H("a")).json()
    assert len(adm["rejected_samples"]) == 5 and all(len(s) <= 121 and s.isprintable() for s in adm["rejected_samples"]) and "attempt 7" in adm["rejected_samples"][-1]
    assert "rejected_samples" not in c.get("/api/torqva/device/status", headers=H("v")).json()


def test_legacy_sketch_output_is_recognised_as_such_and_never_treated_as_a_device(monkeypatch):
    monkeypatch.setattr(sb, "HANDSHAKE_TIMEOUT_S", 0.3)
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr)
    for line in ("--- OVERALL CONDITION ---", "STATUS              : MOTOR OFF", "BUZZER              : OFF"):
        tr.feed(line)
    assert wait(lambda: b.model.last_error_code == "HANDSHAKE_INVALID", 3)
    e = b.snapshot()["error"]
    assert "legacy monitoring sketch" in e["message"] and any("quarantined" in r for r in e["recovery"]) and tr.written == []
    assert b.snapshot()["handshake"] is False and b.snapshot()["label"] == "SIMULATION"
    b.disconnect()


def test_device_loss_after_a_valid_handshake_is_device_disappeared_and_back_to_simulation():
    class Dying(MemoryTransport):
        def read_line(self, timeout):
            item = super().read_line(timeout)
            return item
    b = DeviceBridge(); tr = Dying(); b.connect(tr); tr.feed(status(0)); assert wait(lambda: b.model.conn == Conn.CONNECTED)
    tr.disconnect_device()
    assert wait(lambda: not b.connected)
    s = b.snapshot()
    assert s["label"] == "SIMULATION" and s["connection"] == "DISCONNECTED" and tr.is_open is False


def test_no_command_is_replayed_after_a_failed_then_successful_reconnect():
    b = DeviceBridge(); t1 = MemoryTransport(); b.connect(t1); t1.feed(status(0)); assert wait(lambda: b.model.conn == Conn.CONNECTED)
    rec = b.request_command("STOP", {}, "vera", Role.VIEWER)
    t1.disconnect_device(); assert wait(lambda: not b.connected)
    t2 = MemoryTransport(); b.connect(t2); t2.feed(status(0)); assert wait(lambda: b.model.conn == Conn.CONNECTED)
    time.sleep(0.3)
    assert t2.written == [] and rec.state == CmdState.UNKNOWN_OUTCOME
    b.disconnect()


# ---------------------------------------------------------------------------------------------------- API surface
ENTRIES = [{"sha256": hashlib.sha256(b"a").hexdigest(), "user": "adam", "role": "admin"}, {"sha256": hashlib.sha256(b"v").hexdigest(), "user": "vera", "role": "viewer"}]
H = lambda t: {"Authorization": f"Bearer {t}"}


@pytest.fixture()
def api():
    svc = SimulationService()
    app = FastAPI(); app.include_router(create_router(svc, TokenAuth(ENTRIES))); install_error_handlers(app)
    c = TestClient(app, raise_server_exceptions=False)
    yield svc, c
    svc.bridge.disconnect()


def test_connect_route_reports_access_denied_truthfully_and_status_carries_the_structured_error(api, monkeypatch):
    svc, c = api
    install_fake_serial(monkeypatch, REAL_COM7)
    monkeypatch.setattr(sb, "possible_port_holders", lambda: ["Arduino IDE.exe", "serial-monitor.exe"])
    import torqva.device_routes as dr
    monkeypatch.setattr(dr, "possible_port_holders", lambda: ["Arduino IDE.exe", "serial-monitor.exe"])
    r = c.post("/api/torqva/device/connect", headers=H("a"), json={"port": "COM7"})
    assert r.status_code == 502
    d = r.json()["detail"]
    assert d.startswith("ACCESS_DENIED") and "PermissionError(13" in d and "hint only, not proof" in d and "serial-monitor.exe" in d and "already in use" not in d.lower()
    s = c.get("/api/torqva/device/status", headers=H("v")).json()
    assert s["error"]["code"] == "ACCESS_DENIED" and s["connection"] == "ERROR" and s["label"] == "SIMULATION" and s["error"]["recovery"]


def test_second_connect_request_while_one_is_open_is_a_409_not_a_second_open(api):
    svc, c = api
    tr = MemoryTransport(); svc.bridge.connect(tr)
    r = c.post("/api/torqva/device/connect", headers=H("a"), json={"port": "COM7"})
    assert r.status_code == 409 and tr.is_open
