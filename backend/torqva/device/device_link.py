"""Wi-Fi device link: the ESP32 opens a WebSocket over TLS (through scripts/development/ota_https_gateway.py) to /api/torqva/device/link and the backend's
existing DeviceBridge runs on it exactly as on USB serial.

Nothing about the device protocol changes: every WebSocket text message carries the same JSON lines (protocol 1, seq / ts, the same frame types), the same
mutual challenge-response handshake with the per-device key (the key never travels; the session key is derived on both sides), the same HMAC-authenticated
and replay-protected commands and the same device protections. The link is only a transport.

Rules (no fake connection state, one authoritative route):
  * enabled only with TORQVA_DEVICE_LINK=1 (npm run dev:sim strips it, so a software-only session never accepts a physical device);
  * one device link at a time, because the bridge holds one transport: an existing production USB connection is retained until disconnected;
    the LED-only bench profile permits a USB-to-Wi-Fi handover;
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

from torqva.telemetry.device_state import Conn
from torqva.device.transport import Transport, TransportError

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
        # Reserve space before reporting that a write was queued. The extra slot is for shutdown.
        self._out: "asyncio.Queue[Optional[str]]" = asyncio.Queue(maxsize=257)
        self._out_slots = threading.BoundedSemaphore(256)
        self._closed = threading.Event()

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
            if not self.loop.is_closed():
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
        if not self._out_slots.acquire(blocking=False):
            raise TransportError("Wi-Fi send queue is full", "LINK_BUSY")
        try:
            self.loop.call_soon_threadsafe(self._put_out, data.decode("utf-8", "replace").rstrip("\n"))
        except RuntimeError as exc:
            self._out_slots.release()
            raise TransportError("Wi-Fi link closed", "LINK_CLOSED") from exc

    def _put_out(self, item: Optional[str]) -> None:
        self._out.put_nowait(item)

    async def next_write(self) -> Optional[str]:
        item = await self._out.get()
        if item is not None:
            self._out_slots.release()
        return item

    def close(self) -> None:
        self.gone("closed by the backend")


STALE_LINK_S = 1.5                                       # silence after which a link is considered dead when the same address dials again


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

    @staticmethod
    def _stale(b: Any, m: Any) -> bool:
        """The current link has been silent for longer than a live device ever is (it sends about 18 lines per second): its socket died on the device's side."""
        last = getattr(m, "last_rx", None)
        clock = getattr(b, "_clock", time.monotonic)
        return last is not None and clock() - last > STALE_LINK_S

    def admit(self, remote: str) -> Tuple[bool, str]:
        """Called before the link is attached. Returns (ok, reason)."""
        disconnect_reason = ""
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
                m = getattr(b, "model", None)
                handshaken = m is not None and m.status is not None and m.conn in (Conn.CONNECTED, Conn.STALE)
                if kind == "usb" and (not handshaken or b.device_profile() == "ota_led_bench"):
                    if b.autoconnect is not None and not b.autoconnect.paused:
                        b.autoconnect.paused, self.paused_usb = True, True
                    disconnect_reason = "handing the LED bench device over to its Wi-Fi link" if b.device_profile() == "ota_led_bench" else "yielding unhandshaken USB port to incoming Wi-Fi link"
                    self._event("handover", remote=remote, reason="USB -> Wi-Fi (LED bench device)" if b.device_profile() == "ota_led_bench" else "USB (unhandshaken) -> Wi-Fi")
                elif kind == "wifi" and getattr(tr, "remote", None) == remote and self._stale(b, m):
                    # The SAME device address is dialling again: its previous socket is gone on the device's side but this side has not noticed yet (a dead link is
                    # only seen on the next read or write). Refusing the new link here kept a healthy board out until the old one timed out. The old link is closed and
                    # the new one is admitted; it still has to pass the full authentication and starts a NEW session (the firmware stops the drive on a new session,
                    # and nothing is replayed). A different address is still refused: exactly one device link at a time.
                    disconnect_reason = "replaced by a new link from the same device address (the old one was silent)"
                    self._event("superseded", remote=remote, reason="same-address redial: stale link closed")
                else:
                    self._event("refused", remote=remote, reason=f"LINK_BUSY ({kind})")
                    return False, f"LINK_BUSY: a device is connected over {kind}"
        if disconnect_reason:
            b.disconnect(disconnect_reason)
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
