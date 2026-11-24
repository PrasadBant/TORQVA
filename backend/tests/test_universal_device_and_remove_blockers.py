"""An unknown serial device cannot masquerade as a connected TORQVA device."""
import time

import pytest

from torqva.serial_bridge import Conn, DeviceBridge


class UnknownTransport:
    kind = "usb"
    port = "COM7"

    def open(self):
        pass

    def read_line(self, timeout):
        time.sleep(min(timeout, 0.01))
        return None

    def write(self, data):
        raise AssertionError("no command should reach an unknown device")

    def close(self):
        pass


def test_unknown_device_never_becomes_authoritative():
    bridge = DeviceBridge()
    with pytest.raises(ValueError):
        bridge.universal_mode = True
    bridge.connect(UnknownTransport())
    try:
        assert bridge.model.conn == Conn.CONNECTING
        bridge._housekeeping(bridge._clock() + 6.0)
        assert bridge.model.conn != Conn.CONNECTED
        assert bridge.session_active() is False
        assert bridge.control_blockers()
    finally:
        bridge.disconnect()
