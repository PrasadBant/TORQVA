"""Connection readiness: telemetry alone is never "operational", and the real reason is stated."""
import json

from torqva.device import readiness as rd
from torqva.device.serial_bridge import net_link_diagnostics
from torqva.device.wire_protocol import parse_frame

NOW = 10_000.0


def snap(**kw):
    base = {"connection": "CONNECTED", "handshake": True, "telemetry_fresh": True, "hb_age_ms": 500, "session": {"active": True, "state": "active"},
            "transport": {"kind": "wifi", "remote": "10.0.0.5", "since": NOW - 120}, "wifi_link": {"events": []}, "error": None}
    base.update(kw)
    return base


def drops(n, ago=10):
    return {"events": [{"kind": "disconnected", "at": NOW - ago - i} for i in range(n)]}


def test_disconnected_and_usb():
    assert rd.compute({"connection": "DISCONNECTED", "transport": None}, NOW)["state"] == "DISCONNECTED"
    usb = rd.compute(snap(transport={"kind": "usb", "port": "COM7"}), NOW)
    assert usb["state"] == "USB_CONNECTED" and usb["ready"]
    no_sess = rd.compute(snap(transport={"kind": "usb"}, session={"active": False, "state": "wait_challenge"}), NOW)
    assert no_sess["state"] == "USB_CONNECTED" and not no_sess["ready"] and "authenticated session" in no_sess["reasons"][0]


def test_wifi_steps_are_distinct():
    assert rd.compute(snap(handshake=False), NOW)["state"] == "WIFI_LINKED"
    assert rd.compute(snap(session={"active": False, "state": "wait_challenge"}), NOW)["state"] == "WIFI_AUTHENTICATING"
    r = rd.compute(snap(telemetry_fresh=False), NOW)
    assert r["state"] == "TELEMETRY_AVAILABLE" and not r["ready"]


def test_fresh_telemetry_without_a_heartbeat_is_not_ready_and_says_why():
    r = rd.compute(snap(hb_age_ms=0xFFFFFFFF), NOW)
    assert r["state"] == "TELEMETRY_AVAILABLE" and not r["ready"] and "heartbeat" in r["reasons"][0]
    assert rd.compute(snap(hb_age_ms=None), NOW)["state"] == "TELEMETRY_AVAILABLE"


def test_new_link_is_command_ready_but_only_a_steady_one_is_fully_operational():
    young = rd.compute(snap(transport={"kind": "wifi", "since": NOW - 5}), NOW)
    assert young["state"] == "COMMAND_SESSION_READY" and young["ready"]
    steady = rd.compute(snap(), NOW)
    assert steady["state"] == "OPERATIONAL_WIRELESS" and steady["ready"]


def test_a_flapping_link_is_a_communication_failure_even_with_fresh_telemetry():
    r = rd.compute(snap(wifi_link=drops(4), net_info={"link_close_cause": "send failed or timed out"}), NOW)
    assert r["state"] == "COMMUNICATION_FAILURE" and not r["ready"]
    assert "dropped 4 times" in r["reasons"][0] and "send failed" in r["reasons"][1]
    old = rd.compute(snap(wifi_link=drops(4, ago=500)), NOW)                     # drops long ago do not count
    assert old["state"] == "OPERATIONAL_WIRELESS"


def test_handover_is_reported_while_no_transport_is_attached():
    r = rd.compute({"connection": "DISCONNECTED", "transport": None, "wifi_link": {"events": [{"kind": "handover", "at": NOW - 2, "reason": "USB -> Wi-Fi"}]}}, NOW)
    assert r["state"] == "TRANSPORT_HANDOVER"


def test_net_info_link_diagnostics_are_validated_and_named():
    line = json.dumps({"t": "net_info", "seq": 0, "ts": 5, "ip": "1.2.3.4", "ssid": "x", "rssi": -60, "mac": "AA", "heap": 1, "up_s": 2,
                       "rr": 9, "lc": 1, "le": 104, "lu": 23, "ln": 7, "lr": -71, "sm": 1004})
    f = parse_frame(line)
    d = net_link_diagnostics(f)
    assert d["reset_reason"].startswith("brown-out") and d["link_close_cause"] == "send failed or timed out" and d["links_since_boot"] == 7 and d["link_errno"] == 104
    old = parse_frame(json.dumps({"t": "net_info", "seq": 0, "ts": 5, "ip": "1.2.3.4", "ssid": "x", "rssi": -60, "mac": "AA", "heap": 1, "up_s": 2}))
    assert net_link_diagnostics(old) == {}                                         # an older firmware still validates
