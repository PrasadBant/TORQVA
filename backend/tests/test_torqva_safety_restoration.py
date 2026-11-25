"""Safety restoration (3 Nov 2026): the backend leftovers of commit 319fb7b. The Safety Supervisor context is built from MEASURED values only (a
missing or invalid supply voltage is never replaced by a fixed 24 V), the sensor interlock includes the supply voltage, and a bridge without a
configured firmware key never sends a placeholder key. No real serial port is opened (MemoryTransport); nothing here is hardware validation."""
import json
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.device.wire_protocol import Q_BITS
from torqva.telemetry.device_state import Conn
from torqva.device.serial_bridge import DeviceBridge
from torqva.device.transport import MemoryTransport

ROOT = Path(__file__).resolve().parents[2]
VOLTAGE_BIT = Q_BITS["voltage"]


def fast(seq, v=24.0, q=63):
    return json.dumps({"t": "fast", "seq": seq, "ts": seq * 100, "rpm": 0.0, "sp": 0.0, "duty": 0.0, "v": v, "i": 0.2, "p": round(v * 0.2, 2), "q": q})


def slow(seq, housing=25.0, q=63):
    return json.dumps({"t": "slow", "seq": seq, "ts": seq * 100, "housing": housing, "ambient": 22.0, "q": q})


def status(seq):
    return json.dumps({"t": "status", "seq": seq, "ts": seq * 100, "fw": "3.0.0", "wiring": "W1", "limits_v": 1, "state": "OK", "reason": "NONE", "mode": "HW", "drive": "IDLE",
                       "ctl": 0, "hb_age": 4294967295, "test": 0, "proto": 1, "dev": "RIG-1", "blk": "LIMITS_NOT_APPROVED", "fm": 0})


def wait(cond, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return cond()


def bridge_with(v, q):
    b = DeviceBridge()
    tr = MemoryTransport()
    b.connect(tr)
    tr.feed(status(0))
    assert wait(lambda: b.model.conn == Conn.CONNECTED)
    tr.feed(slow(1))
    tr.feed(fast(2, v=v, q=q))
    assert wait(lambda: (b.model.values.get("voltage") or {}).get("valid") is not None)
    return b


def test_physical_status_reports_the_measured_supply_voltage():
    b = bridge_with(v=18.5, q=63)
    try:
        assert b.snapshot()["values"]["voltage"]["value"] == pytest.approx(18.5)
    finally:
        b.disconnect()


def test_invalid_supply_voltage_remains_invalid_in_status_and_interlocks():
    b = bridge_with(v=24.0, q=63 & ~VOLTAGE_BIT)
    try:
        snap = b.snapshot()
        assert snap["values"]["voltage"]["valid"] is False
        assert snap["values"]["voltage"]["value"] is None
        assert snap["interlocks"] == []
    finally:
        b.disconnect()


def test_a_valid_reading_set_including_voltage_verifies_the_sensor_interlock():
    b = bridge_with(v=24.0, q=63)
    try:
        snap = b.snapshot()
        assert snap["values"]["voltage"]["valid"] is True and snap["values"]["voltage"]["value"] == pytest.approx(24.0)
        assert snap["interlocks"] == []
    finally:
        b.disconnect()


def test_without_a_configured_firmware_key_no_placeholder_key_is_sent(monkeypatch):
    monkeypatch.delenv("TORQVA_FW_COMMAND_KEY", raising=False)
    b = DeviceBridge()
    assert not hasattr(b, "command_key")
    src = (ROOT / "backend" / "torqva" / "device" / "serial_bridge.py").read_text(encoding="utf-8")
    assert "authenticated-session-only" not in src                          # the firmware build sentinel must never be the backend's default key
    assert "dev-key-change-me" not in src
    assert 'v["voltage"] = 24.0' not in src and "voltage_v=24.0" not in src
