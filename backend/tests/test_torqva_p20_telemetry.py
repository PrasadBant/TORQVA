"""Acceleration frames, truthful per-sensor status, state labels and aggregated protocol-error events. Frames come from hand-built lines and from the REAL firmware core (fitl). No port is opened."""
import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent))

from torqva import serial_bridge as sb
from torqva.serial_bridge import Conn, DeviceBridge, DeviceModel, FrameError, MemoryTransport, parse_frame
from test_torqva_p16_serial import fast, slow, status, wait

FITL = Path(__file__).resolve().parents[2] / "esp32" / "torqva_fw" / ".pio" / "build" / "fitl" / "program.exe"


def accel(seq, ok=1, **kw):
    f = {"t": "accel", "seq": seq, "ts": (seq * 100) % 2 ** 32, "ok": ok}
    if ok:
        f.update({"ax": 0.01, "ay": -0.02, "az": 0.99, "mag": 0.99})
    f.update(kw)
    return json.dumps(f)


def test_valid_and_invalid_accel_frames_parse_and_invalid_ones_carry_no_numbers():
    assert parse_frame(accel(1))["mag"] == 0.99
    assert parse_frame(accel(2, ok=0))["ok"] == 0
    for bad, code in ((accel(3, ok=0, mag=1.0), "BAD_FIELD"), (accel(3, ok=2), "BAD_FIELD"), (accel(3, mag=99.0), "OUT_OF_RANGE"), (accel(3).replace("0.99", "NaN", 1), "NON_FINITE_NUMBER"),
                      (json.dumps({"t": "accel", "seq": 1, "ts": 1, "ok": 1}), "BAD_FIELD")):
        with pytest.raises(FrameError) as e:
            parse_frame(bad)
        assert e.value.code == code


def test_acceleration_is_reported_as_total_magnitude_with_gravity_and_never_as_vibration():
    m = DeviceModel(); m.conn = Conn.CONNECTED
    m.ingest(parse_frame(accel(0)), 1.0, 100.0)
    a = m.snapshot(1.1)["values"]["acceleration"]
    assert a["valid"] and a["value"] == 0.99 and a["z_g"] == 0.99 and "INCLUDING gravity" in a["note"] and "NOT vibration RMS" in a["note"]
    assert m.snapshot(1.1)["values"]["vibration"]["origin"] == "unavailable"
    assert m.snapshot(1.1)["sensor_status"]["acceleration"] == "valid" and m.snapshot(1.1)["sensor_status"]["vibration_rms"] == "unavailable"
    m.ingest(parse_frame(accel(1, ok=0)), 1.2, 100.2)
    a = m.snapshot(1.3)["values"]["acceleration"]
    assert a["valid"] is False and a["value"] is None and m.snapshot(1.3)["sensor_status"]["acceleration"] == "invalid"
    assert m.history_series("acceleration", 60, 101.0) == [[100.0, 0.99], [100.2, None]]                    # an invalid reading is a gap, never a zero
    assert m.snapshot(10.0)["sensor_status"]["acceleration"] == "stale"


def test_no_accel_frames_means_unavailable_not_zero():
    m = DeviceModel(); m.ingest(parse_frame(fast(0)), 1.0, 1.0)
    s = m.snapshot(1.1)
    assert s["values"]["acceleration"]["origin"] == "unavailable" and s["values"]["acceleration"]["value"] is None and s["sensor_status"]["acceleration"] == "unavailable"


def test_sensor_status_distinguishes_valid_invalid_stale_and_unavailable():
    m = DeviceModel(); m.conn = Conn.CONNECTED
    m.ingest(parse_frame(fast(0, q=63 & ~16)), 1.0, 1.0)            # rpm invalid
    m.ingest(parse_frame(slow(1, q=63 & ~8)), 1.1, 1.1)             # ambient invalid
    s = m.snapshot(1.2)["sensor_status"]
    assert s["rpm"] == "invalid" and s["current"] == "valid" and s["ambient"] == "invalid" and s["housing"] == "valid" and s["acceleration"] == "unavailable"
    assert m.snapshot(20.0)["sensor_status"]["current"] == "stale"


def test_state_labels_follow_the_real_connection_state_never_the_websocket():
    b = DeviceBridge()
    assert b.snapshot()["state_label"] == "DISCONNECTED"
    tr = MemoryTransport(); b.connect(tr)
    assert b.snapshot()["state_label"] == "PORT OPEN - WAITING FOR HANDSHAKE"
    tr.feed(b"legacy text"); assert wait(lambda: b.model.counters["malformed"] == 1)
    assert "receiving non-TORQVA data" in b.snapshot()["state_label"]
    tr.feed(status(0)); assert wait(lambda: b.model.conn == Conn.CONNECTED)
    s = b.snapshot(); assert s["state_label"] == "PHYSICAL DEVICE CONNECTED" and s["origin"] == "physical_device"
    b.disconnect()
    b2 = DeviceBridge(); t2 = MemoryTransport(); b2.connect(t2); t2.feed(status(0, mode="SIM")); assert wait(lambda: b2.model.conn == Conn.CONNECTED)
    assert b2.snapshot()["state_label"] == "DEVICE CONNECTED (FIRMWARE SIMULATION MODE)"; b2.disconnect()


def test_the_selected_port_is_reported_and_stale_label(monkeypatch):
    monkeypatch.setattr(sb, "STALE_AFTER_S", 0.3)
    class Named(MemoryTransport):
        port = "COM7"
    b = DeviceBridge(); tr = Named(); b.connect(tr); tr.feed(status(0)); tr.feed(fast(1))
    assert wait(lambda: b.model.last_fast_rx is not None) and b.snapshot()["port"] == "COM7"
    assert wait(lambda: b.snapshot()["state_label"] == "TELEMETRY STALE", 3)
    b.disconnect()


def test_repeated_protocol_errors_are_aggregated_into_few_events_with_exact_counters(monkeypatch):
    monkeypatch.setattr(sb, "ERROR_EVENT_INTERVAL_S", 0.4)
    b = DeviceBridge(); tr = MemoryTransport(); sub = b.hub.subscribe(); b.connect(tr)
    for i in range(500):
        tr.feed(b"--- OVERALL CONDITION ---")
    assert wait(lambda: b.model.counters["malformed"] == 500, 5)
    time.sleep(0.6)
    ev = [e for e in sub.drain(False) if e["name"] == "protocol_error"]
    assert 1 <= len(ev) <= 4 and sum(e["data"]["count"] for e in ev) <= 500                      # not 500 events
    assert b.model.counters["malformed"] == 500                                                   # the counters stay exact
    b.disconnect()


@pytest.mark.skipif(not FITL.exists(), reason="fitl CLI not built (pio run -e fitl)")
def test_accel_frames_from_the_real_firmware_core_pass_the_real_parser_and_report_invalid_without_a_sensor():
    p = subprocess.Popen([str(FITL), "--strict", "--accel"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    lines = []
    for _ in range(4):
        p.stdin.write('{"tick":500}\n'); p.stdin.flush()
        while True:
            l = p.stdout.readline().strip()
            if l == "#":
                break
            lines.append(l)
    p.stdin.close(); p.wait(timeout=3)
    m = DeviceModel(); kinds = set()
    for i, l in enumerate(lines):
        f = parse_frame(l); kinds.add(f["t"]); m.ingest(f, float(i), float(i))
    assert {"fast", "slow", "status", "accel"} <= kinds
    assert m.accel is not None and m.accel["valid"] is False and m.snapshot(float(len(lines)))["values"]["acceleration"]["value"] is None       # the plant has no accelerometer: nothing is invented
    assert m.counters["gaps"] == 0 and m.counters["duplicates"] == 0
