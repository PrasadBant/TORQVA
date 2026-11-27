"""Honest connection readiness: what is actually usable right now, and the real reason when it is not.

Telemetry arriving is not the same as being able to command the device. The states, in the order a wireless link reaches them:

  DISCONNECTED          no transport
  USB_CONNECTED         the USB serial link is up and handshaken
  TRANSPORT_HANDOVER    USB was just released for an incoming Wi-Fi link (or the reverse)
  WIFI_LINKED           the device's TLS WebSocket is attached; its handshake has not been seen yet
  WIFI_AUTHENTICATING   handshake seen, the per-device-key session is not active yet
  TELEMETRY_AVAILABLE   fresh telemetry, but no active authenticated command session (or the device has not seen the host heartbeat)
  COMMAND_SESSION_READY the authenticated session is active and the device sees the host heartbeat: commands can be routed
  OPERATIONAL_WIRELESS  command-session ready AND the link has been steady (it has lasted STABLE_S seconds, with fewer than FLAP_LIMIT recent drops)
  COMMUNICATION_FAILURE the link keeps dropping or the device reported an error

``ready`` is true only when commands will be routed: COMMAND_SESSION_READY, OPERATIONAL_WIRELESS, or USB_CONNECTED with an active session.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

STABLE_S = 30.0            # a wireless link must have lasted this long to be called fully operational
FLAP_WINDOW_S = 120.0      # drops are counted over this window
FLAP_LIMIT = 3             # this many drops inside the window is a communication failure, not a blip
HB_FRESH_MS = 3000         # the device must have seen the host heartbeat this recently
HANDOVER_S = 10.0

LABELS = {
    "DISCONNECTED": "Disconnected",
    "USB_CONNECTED": "USB connected",
    "TRANSPORT_HANDOVER": "Transport handover in progress",
    "WIFI_LINKED": "Wi-Fi connected, waiting for the device handshake",
    "WIFI_AUTHENTICATING": "Wi-Fi connected, authenticating",
    "TELEMETRY_AVAILABLE": "Telemetry available, command session not ready",
    "COMMAND_SESSION_READY": "Command session ready",
    "OPERATIONAL_WIRELESS": "Fully operational wireless connection",
    "COMMUNICATION_FAILURE": "Communication failure",
}


def _recent_drops(events: List[Dict[str, Any]], now: float) -> int:
    return sum(1 for e in events if e.get("kind") == "disconnected" and now - float(e.get("at", 0)) <= FLAP_WINDOW_S)


def compute(snap: Dict[str, Any], now: Optional[float] = None) -> Dict[str, Any]:
    now = time.time() if now is None else now
    tr = snap.get("transport") or None
    link = snap.get("wifi_link") or {}
    events = link.get("events") or []
    sess = snap.get("session") or {}
    session_active = bool(sess.get("active"))
    fresh = bool(snap.get("telemetry_fresh"))
    hb = snap.get("hb_age_ms")
    hb_ok = isinstance(hb, (int, float)) and hb < HB_FRESH_MS
    reasons: List[str] = []

    sb = link.get("standby") or None

    def standby_view() -> Dict[str, Any]:
        """Is it safe to pull the USB cable? Only when a live Wi-Fi standby link from THIS device is attached (claimed id, verified again on promotion)."""
        if not sb:
            return {"state": "NONE", "ready": False, "reason": "no Wi-Fi standby link is attached"}
        expected = snap.get("device_id")
        if not sb.get("alive"):
            return {"state": "SILENT", "ready": False, "reason": f"the standby link has been silent for {sb.get('silent_s')} s"}
        if not sb.get("authenticated"):
            why = f" ({sb.get('identity_failures')} failed proofs)" if sb.get("identity_failures") else ""
            return {"state": "AUTHENTICATING", "ready": False, "reason": "the standby link is up; waiting for the board's keyed identity proof" + why}
        if expected and sb.get("verified_device_id") != expected:
            return {"state": "MISMATCH", "ready": False, "reason": f"the standby link proved device {sb.get('verified_device_id')}, the USB session is {expected}"}
        if not sb.get("claimed_device_id"):
            return {"state": "WAITING", "ready": False, "reason": "the standby link is up; waiting for the device's status frame"}
        if expected and sb.get("claimed_device_id") != expected:
            return {"state": "MISMATCH", "ready": False, "reason": f"the standby link claims device {sb.get('claimed_device_id')}, the USB session is {expected}"}
        # The claimed id is not authenticated (any host that reaches the gateway could send it). The board's own Wi-Fi address, reported over the USB session,
        # must be the address the standby link comes from.
        usb_ip = (snap.get("net_info") or {}).get("ip")
        if not usb_ip or usb_ip == "0.0.0.0":
            return {"state": "WAITING", "ready": False, "reason": "waiting for the board to report its Wi-Fi address over USB"}
        if usb_ip != sb.get("remote"):
            return {"state": "MISMATCH", "ready": False, "reason": f"the standby link comes from {sb.get('remote')}, but the board reports its Wi-Fi address as {usb_ip}"}
        return {"state": "READY", "ready": True, "reason": "Wi-Fi standby link is live and proved this board's key; it takes over (with a new authenticated session) when the USB session ends"}

    def out(state: str, ready: bool) -> Dict[str, Any]:
        return {"state": state, "label": LABELS[state], "ready": ready, "reasons": reasons, "wifi_drops_recent": _recent_drops(events, now), "wifi_standby": standby_view()}

    if snap.get("error") and (snap.get("connection") == "ERROR" or not tr):
        reasons.append(str((snap.get("error") or {}).get("message") or "the device reported an error"))
        return out("COMMUNICATION_FAILURE", False)
    handover = [e for e in events if e.get("kind") == "handover" and now - float(e.get("at", 0)) <= HANDOVER_S]
    if handover and not tr:
        reasons.append(handover[-1].get("reason") or "switching transport")
        return out("TRANSPORT_HANDOVER", False)
    if not tr or snap.get("connection") in (None, "DISCONNECTED"):
        reasons.append("no device is connected")
        return out("DISCONNECTED", False)

    kind = tr.get("kind", "usb")
    if kind != "wifi":
        if not snap.get("handshake"):
            reasons.append("the port is open but the device has not sent a valid TORQVA handshake")
            return out("USB_CONNECTED", False)
        if not session_active:
            reasons.append("the authenticated session is not active yet (" + str(sess.get("state") or "none") + ")")
        elif not hb_ok:
            reasons.append("the device has not seen the host heartbeat recently")
        return out("USB_CONNECTED", session_active and hb_ok and fresh)

    drops = _recent_drops(events, now)
    if drops >= FLAP_LIMIT:
        reasons.append(f"the Wi-Fi link dropped {drops} times in the last {int(FLAP_WINDOW_S)} s; every reconnect starts a new session, which stops the drive and loses commands in flight")
        net = snap.get("net_info") or {}
        if net.get("link_close_cause"):
            reasons.append(f"last drop reported by the device: {net['link_close_cause']}")
        return out("COMMUNICATION_FAILURE", False)
    if not snap.get("handshake"):
        reasons.append("the Wi-Fi link is attached; waiting for a valid device handshake")
        return out("WIFI_LINKED", False)
    if not session_active:
        reasons.append("authenticating the device with its key (" + str(sess.get("state") or "none") + ")")
        return out("WIFI_AUTHENTICATING", False)
    if not fresh:
        reasons.append("the session is active but telemetry is stale")
        return out("TELEMETRY_AVAILABLE", False)
    if not hb_ok:
        reasons.append("telemetry is fresh but the device has not yet seen the host heartbeat: commands are not routed yet")
        return out("TELEMETRY_AVAILABLE", False)
    since = tr.get("since")
    age = (now - float(since)) if since else 0.0
    if age < STABLE_S:
        reasons.append(f"the link is {int(age)} s old; it is called fully operational after {int(STABLE_S)} s")
        return out("COMMAND_SESSION_READY", True)
    return out("OPERATIONAL_WIRELESS", True)
