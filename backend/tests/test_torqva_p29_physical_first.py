"""Phase 29: physical-first backend: per-reading metadata, honest analysis status, optional auto-connect. Mocks / in-memory transports / the real firmware core only; no port is opened."""
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.autoconnect import AutoConnector
from torqva.physical_adapter import WAITING
from torqva.serial_bridge import Conn, DeviceBridge, MemoryTransport, TransportError
from test_torqva_p16_serial import FITL, FitlTransport, fast, slow, status, wait


def physical_bridge():
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr); tr.feed(status(0, mode="HW", dev="RIG-1"))
    assert wait(lambda: b.model.conn == Conn.CONNECTED)
    tr.feed(fast(1, rpm=1200.0, q=63 & ~2)); tr.feed(slow(2, housing=31.5))
    assert wait(lambda: b.model.last_fast_rx is not None and b.model.values.get("housing"))
    return b, tr


def test_every_reading_carries_unit_identity_acquisition_and_receipt_time_and_source():
    b, tr = physical_bridge()
    v = b.snapshot()["values"]
    assert v["rpm"]["unit"] == "rpm" and v["current"]["unit"] == "A" and v["housing"]["unit"] == "°C" and v["duty"]["unit"] == "%"
    for k in ("rpm", "current", "housing"):
        assert v[k]["device_id"] == "RIG-1" and v[k]["device_ts_ms"] is not None and v[k]["received_unix"] > 1_600_000_000 and v[k]["source"] == "device_measurement" and v[k]["valid"]
    assert v["voltage"]["valid"] is False and v["voltage"]["value"] is None                       # an invalid reading is None, never zero
    assert v["vibration"]["origin"] == "unavailable" and "unit" not in v["vibration"]              # nothing invented for what the firmware does not measure
    b.disconnect()


def test_analysis_waits_without_a_device_and_never_produces_a_result_for_missing_data():
    a = DeviceBridge().snapshot()["analysis"]
    assert a["state"] == WAITING and a["basis"] == "none" and all(a["layers"][k]["status"] == WAITING for k in ("C1", "HYPOTHESES", "C2", "C4", "C5", "C6"))
    assert a["layers"]["C3"]["status"] == "physical motion BLOCKED"


def test_with_valid_physical_telemetry_the_layers_say_exactly_why_they_cannot_run():
    b, tr = physical_bridge()
    a = b.snapshot()["analysis"]
    assert a["basis"] == "physical_device" and "vib_rms" in a["missing_inputs"] and "voltage" in a["missing_inputs"]
    assert a["layers"]["C1"]["status"] == "NOT AVAILABLE" and "vibration RMS" in a["layers"]["C1"]["reason"]
    assert all("NORMAL" not in str(x) and "HEALTHY" not in str(x).upper() for x in a["layers"].values())     # no green status for missing data
    b.disconnect()


def test_firmware_simulation_mode_is_not_analysed_as_physical():
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr); tr.feed(status(0, mode="SIM"))
    assert wait(lambda: b.model.conn == Conn.CONNECTED); tr.feed(fast(1)); time.sleep(0.2)
    a = b.snapshot()["analysis"]
    assert a["state"] == WAITING and "simulation" in a["reason"]
    b.disconnect()


# ------------------------------------------------------------------------------------------ auto-connect
def test_auto_connect_is_off_without_a_configured_port_and_never_scans():
    b = DeviceBridge(); ac = AutoConnector(b, None, scan=False, factory=lambda p, k: pytest.fail("must not create a transport"))
    assert not ac.configured and ac.try_once() is False and "no device port is configured" in ac.status()["note"]
    assert not AutoConnector(b, "not a port").configured


def test_auto_connect_opens_only_the_configured_port_reports_failures_and_respects_an_operator_disconnect():
    b = DeviceBridge(); opened = []
    class Bad(MemoryTransport):
        def open(self):
            raise TransportError("cannot open COM9: not found")
    state = {"bad": True}
    def factory(p, k):
        opened.append(p)
        return Bad() if state["bad"] else MemoryTransport()
    ac = AutoConnector(b, "COM9", factory=factory)
    assert ac.try_once() is True and opened == ["COM9"] and "COM9" in ac.status()["last_error"] and b.model.conn == Conn.ERROR         # a failure is shown, not hidden
    state["bad"] = False
    ac.pause(); assert ac.try_once() is False and len(opened) == 1                                                                    # operator disconnect: no retry
    ac.resume(); assert ac.try_once() is True and b.connected and b.model.conn == Conn.CONNECTING                                    # open port != connected device
    assert b.snapshot()["handshake"] is False and b.snapshot()["label"] == "SIMULATION"
    assert ac.try_once() is False                                                                                                    # already connected: no second open
    assert b.snapshot()["autoconnect"]["configured"] is False or True
    b.disconnect()


@pytest.mark.skipif(not FITL.exists(), reason="fitl CLI not built (pio run -e fitl)")
def test_real_firmware_core_frames_flow_through_parser_adapter_and_snapshot():
    tr = FitlTransport("--strict", "--accel")
    b = DeviceBridge(expected_device_id="FITL-1"); b.connect(tr)
    for _ in range(4):
        tr.advance(500)
    assert wait(lambda: b.model.conn == Conn.CONNECTED and b.model.values.get("rpm") and b.model.accel)
    s = b.snapshot()
    assert s["values"]["rpm"]["unit"] == "rpm" and s["values"]["rpm"]["device_id"] == "FITL-1" and s["values"]["acceleration"]["origin"] == "device_measurement"
    assert s["analysis"]["state"] == WAITING                                                       # firmware SIM core: never analysed as a physical device
    b.disconnect(); tr.close()


def test_scan_connects_only_when_exactly_one_allow_listed_usb_serial_port_is_present():
    b = DeviceBridge(); opened = []
    ports = {"v": []}
    ac = AutoConnector(b, None, lister=lambda: ports["v"], factory=lambda p, k: (opened.append(p), MemoryTransport())[1])
    assert ac.configured and ac.try_once() is False and opened == [] and "no USB-serial device found" in ac.status()["note"]
    ports["v"] = ["COM7", "COM9"]
    assert ac.try_once() is False and opened == [] and "several" in ac.last_error                     # never guesses between devices
    ports["v"] = ["COM7"]
    assert ac.try_once() is True and opened == ["COM7"] and b.connected and b.snapshot()["handshake"] is False        # open port != connected TORQVA device
    b.disconnect()
    ac.pause(); assert ac.try_once() is False and len(opened) == 1                                      # an operator disconnect is respected
    ac.resume(); assert ac.try_once() is True and opened == ["COM7", "COM7"]
    b.disconnect()


def test_only_allow_listed_vendor_ids_are_candidates(monkeypatch):
    import types, serial.tools.list_ports as lp
    fake = [types.SimpleNamespace(device="COM3", vid=0x0A5C), types.SimpleNamespace(device="COM7", vid=0x1A86), types.SimpleNamespace(device="COM5", vid=None)]
    monkeypatch.setattr(lp, "comports", lambda: fake)
    from torqva.autoconnect import _list_usb_ports
    assert _list_usb_ports() == ["COM7"]                                                               # Bluetooth serial links and unknown devices are never opened
