"""Link admission: a board that redials from the same address replaces its dead (silent) link; a live link and any other address are still refused."""
from types import SimpleNamespace

from torqva.device.device_link import DeviceLinkManager


class FakeBridge:
    def __init__(self, kind, remote):
        self.connected = True
        self._transport = SimpleNamespace(kind=kind, remote=remote)
        self.model = SimpleNamespace(status={"ok": 1}, conn="CONNECTED", last_rx=0.0)
        self.now = 100.0
        self.autoconnect = None
        self.disconnected_with = None

    def _clock(self):
        return self.now

    def device_profile(self):
        return "production"

    def disconnect(self, why):
        self.disconnected_with = why
        self.connected = False


def mgr(kind, remote):
    b = FakeBridge(kind, remote)
    t = [100.0]

    def clock():
        t[0] += 10.0                                           # well apart: the per-address rate limit never interferes
        return t[0]
    return DeviceLinkManager(b, clock=clock), b


def test_same_address_redial_replaces_a_silent_wifi_link():
    m, b = mgr("wifi", "10.0.0.41")
    b.now, b.model.last_rx = 100.0, 95.0                       # the old link has said nothing for 5 s: its socket is dead
    ok, why = m.admit("10.0.0.41")
    assert ok and why == ""
    assert "same device address" in b.disconnected_with
    assert any(e["kind"] == "superseded" for e in m.history)


def test_a_live_link_is_never_displaced_even_by_the_same_address():
    m, b = mgr("wifi", "10.0.0.41")
    b.now, b.model.last_rx = 100.0, 99.8                       # frames are still arriving
    ok, why = m.admit("10.0.0.41")
    assert not ok and why.startswith("LINK_BUSY") and b.disconnected_with is None


def test_a_different_address_is_still_refused_while_a_wifi_link_is_active():
    m, b = mgr("wifi", "10.0.0.41")
    b.now, b.model.last_rx = 100.0, 95.0
    ok, why = m.admit("10.0.0.99")
    assert not ok and why.startswith("LINK_BUSY")
    assert b.disconnected_with is None and b.connected


def test_a_handshaken_usb_session_is_never_replaced_by_wifi():
    m, b = mgr("usb", None)
    ok, why = m.admit("10.0.0.41")
    assert not ok and "usb" in why
    assert b.disconnected_with is None
