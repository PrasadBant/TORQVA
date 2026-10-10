"""Phase 27: the physical-telemetry adapter. Real firmware-core frames (fitl) go through the real bridge into the adapter. Nothing claims AI inference on real data."""
import json
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.physical_adapter import c1_gaps, c1_window, physical_window
from torqva.serial_bridge import Conn, DeviceBridge, MemoryTransport
from test_torqva_p16_serial import FITL, FitlTransport, status, fast, slow, wait


def test_no_window_without_a_handshaken_physical_device_with_fresh_data():
    b = DeviceBridge()
    assert physical_window(b.snapshot()) is None                                  # disconnected
    tr = MemoryTransport(); b.connect(tr); tr.feed(status(0, mode="SIM"))
    assert wait(lambda: b.model.conn == Conn.CONNECTED)
    tr.feed(fast(1)); tr.feed(slow(2)); time.sleep(0.2)
    assert physical_window(b.snapshot()) is None                                  # firmware simulation mode is never treated as physical
    b.disconnect()


def test_a_physical_window_carries_valid_measurements_only_and_c1_is_refused_for_missing_vibration():
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr); tr.feed(status(0, mode="HW"))
    assert wait(lambda: b.model.conn == Conn.CONNECTED)
    tr.feed(fast(1, rpm=1200.0, q=63 & ~2)); tr.feed(slow(2, housing=31.5, q=63 & ~8))        # voltage and ambient flagged invalid
    assert wait(lambda: b.model.last_fast_rx is not None and b.model.values.get("housing"))
    w = physical_window(b.snapshot())
    assert w is not None and w.provenance.value == "MEASURED" and w.origin == "physical_device"
    assert w.values["rpm"] == 1200.0 and w.values["housing"] == 31.5
    assert w.values["voltage"] is None and w.values["ambient"] is None             # invalid -> None, never zero
    gaps = c1_gaps(w)
    assert {"vib_rms", "v1x", "v2x", "v3x", "vhf", "voltage", "ambient"} <= set(gaps)
    assert c1_window(w) is None                                                    # no AI inference on this data
    b.disconnect()


@pytest.mark.skipif(not FITL.exists(), reason="fitl CLI not built (pio run -e fitl)")
def test_firmware_simulation_frames_from_the_real_core_are_not_mistaken_for_a_physical_device():
    tr = FitlTransport("--strict")
    b = DeviceBridge(expected_device_id="FITL-1"); b.connect(tr)
    for _ in range(3):
        tr.advance(500)
    assert wait(lambda: b.model.conn == Conn.CONNECTED and b.model.values.get("rpm"))
    assert physical_window(b.snapshot()) is None
    b.disconnect(); tr.close()
