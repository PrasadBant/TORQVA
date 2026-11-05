"""Wi-Fi device link: the ESP32 opens a WebSocket over TLS (through backend/tools/ota_https_gateway.py) to /api/torqva/device/link and the backend's
existing DeviceBridge runs on it exactly as on USB serial.

Nothing about the device protocol changes: every WebSocket text message carries the same JSON lines (protocol 1, seq / ts, the same frame types), the same
mutual challenge-response handshake with the per-device key (the key never travels; the session key is derived on both sides), the same HMAC-authenticated
and replay-protected commands and the same Safety Supervisor. The link is only a transport.

Rules (no fake connection state, one authoritative route):
  * enabled only with TORQVA_DEVICE_LINK=1 (npm run dev:sim strips it, so a software-only session never accepts a physical device);
  * one device link at a time, because the bridge holds one transport: a second link is refused while a device is connected, EXCEPT that an LED bench
    device (profile ota_led_bench) connected over USB hands over to Wi-Fi (USB autoconnect is paused while the Wi-Fi link lasts);
  * a link that has not completed the authenticated handshake within LINK_AUTH_TIMEOUT_S is closed; connection attempts are rate-limited per address;
  * messages larger than LINK_MAX_MSG bytes close the link.
"""
from __future__ import annotations

import asyncio
import os
import queue
import threading
import time
from typing import Any, Dict, Optional, Tuple

from .serial_bridge import Transport, TransportError

LINK_AUTH_TIMEOUT_S = 20.0
LINK_MAX_MSG = 1024
LINK_MIN_INTERVAL_S = 3.0          # per remote address


def link_enabled() -> bool:
    return os.environ.get("TORQVA_DEVICE_LINK", "0") == "1"


class WsTransport(Transport):
    """Bridge-side view of one device WebSocket. Reads come from a thread-safe queue fed by the async receiver; writes are queued and sent by the
    async sender, so the bridge thread never waits on the event loop (and the event loop never waits on the bridge lock)."""

    kind = "wifi"

    def __init__(self, loop: asyncio.AbstractEventLoop, remote: str):
        self.loop, self.remote = loop, remote
        self.port = f"wifi:{remote}"
        self.since = time.time()
        self._in: "queue.Queue[Any]" = queue.Queue(maxsize=512)
        self.out: "asyncio.Queue[Optional[str]]" = asyncio.Queue(maxsize=256)
        self._closed = threading.Event()
        self.dropped_out = 0

    def open(self) -> None:
        if self._closed.is_set():
            raise TransportError("Wi-Fi link already closed", "LINK_CLOSED")

    # -- fed by the async receiver
    def feed(self, text: str) -> None:
        for line in text.split("\n"):
            line = line.strip("\r")
            if line:
                try:
                    self._in.put_nowait(line.encode("utf-8", "replace"))
                except queue.Full:
                    pass                                  # the bridge counts the resulting sequence gap; nothing is invented

    def gone(self, why: str) -> None:
        if not self._closed.is_set():
            self._closed.set()
            try:
                self._in.put_nowait(TransportError(f"Wi-Fi link closed: {why}", "LINK_CLOSED", why))
            except queue.Full:
                pass
            self.loop.call_soon_threadsafe(self._put_out, None)

    # -- bridge side
    def read_line(self, timeout: float) -> Optional[bytes]:
        try:
            item = self._in.get(timeout=timeout)
        except queue.Empty:
            return None
        if isinstance(item, Exception):
            raise item
        return item

    def write(self, data: bytes) -> None:
        if self._closed.is_set():
            raise TransportError("Wi-Fi link closed", "LINK_CLOSED")
        self.loop.call_soon_threadsafe(self._put_out, data.decode("utf-8", "replace").rstrip("\n"))

    def _put_out(self, item: Optional[str]) -> None:
        try:
            self.out.put_nowait(item)
        except asyncio.QueueFull:
            self.dropped_out += 1

    def close(self) -> None:
        self.gone("closed by the backend")


class DeviceLinkManager:
    """Admission of device links and their bookkeeping (the bridge keeps the device state itself)."""

    def __init__(self, bridge: Any, clock=time.monotonic):
        self.bridge, self.clock = bridge, clock
        self._lock = threading.Lock()
        self._last_attempt: Dict[str, float] = {}
        self.active: Optional[WsTransport] = None
        self.paused_usb = False
        self.history: list = []                           # recent link events (bounded) for Connection diagnostics
        self.attempts = 0

    def _event(self, kind: str, **kw: Any) -> None:
        self.history.append({"at": time.time(), "kind": kind, **kw})
        del self.history[:-50]

    def admit(self, remote: str) -> Tuple[bool, str]:
        """Called before the link is attached. Returns (ok, reason)."""
        with self._lock:
            now = self.clock()
            self.attempts += 1
            last = self._last_attempt.get(remote)
            self._last_attempt[remote] = now
            if last is not None and now - last < LINK_MIN_INTERVAL_S:
                self._event("refused", remote=remote, reason="RATE_LIMITED")
                return False, "RATE_LIMITED"
            b = self.bridge
            if b.connected:
                tr = getattr(b, "_transport", None)
                kind = getattr(tr, "kind", "usb")
                if kind == "usb" and b.device_profile() == "ota_led_bench":
                    if b.autoconnect is not None and not b.autoconnect.paused:
                        b.autoconnect.paused, self.paused_usb = True, True
                    b.disconnect("handing the LED bench device over to its Wi-Fi link")
                    self._event("handover", remote=remote, reason="USB -> Wi-Fi (LED bench device)")
                else:
                    self._event("refused", remote=remote, reason=f"LINK_BUSY ({kind})")
                    return False, f"LINK_BUSY: a device is connected over {kind}"
            return True, ""

    def attached(self, tr: WsTransport) -> None:
        with self._lock:
            self.active = tr
            self._event("connected", remote=tr.remote)

    def detached(self, tr: WsTransport, why: str) -> None:
        with self._lock:
            if self.active is tr:
                self.active = None
            if self.paused_usb and self.bridge.autoconnect is not None:
                self.bridge.autoconnect.paused, self.paused_usb = False, False
            self._event("disconnected", remote=tr.remote, reason=why)

    def status(self) -> Dict[str, Any]:
        with self._lock:
            a = self.active
            return {"enabled": link_enabled(), "active": a is not None, "remote": a.remote if a else None, "since": a.since if a else None,
                    "attempts": self.attempts, "usb_autoconnect_paused": self.paused_usb, "events": list(self.history[-20:])}
