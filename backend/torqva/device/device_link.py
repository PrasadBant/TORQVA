"""Wi-Fi device link: the ESP32 opens a WebSocket over TLS (through scripts/development/ota_https_gateway.py) to /api/torqva/device/link and the backend's
existing DeviceBridge runs on it exactly as on USB serial.

Nothing about the device protocol changes: every WebSocket text message carries the same JSON lines (protocol 1, seq / ts, the same frame types), the same
mutual challenge-response handshake with the per-device key (the key never travels; the session key is derived on both sides), the same HMAC-authenticated
and replay-protected commands and the same device protections. The link is only a transport.

Rules (no fake connection state, one authoritative route):
  * enabled only with TORQVA_DEVICE_LINK=1 (npm run dev:sim strips it, so a software-only session never accepts a physical device);
  * one AUTHORITATIVE transport at a time, because the bridge holds one: a handshaken production USB session is retained, and a Wi-Fi link from the
    board meanwhile waits as a STANDBY link (never written to, so no second session starts); it is promoted when the USB session ends. The LED-only bench
    profile and an unhandshaken USB port still hand over to Wi-Fi at once;
  * an attached link that has been silent for LINK_SILENT_S is closed (the board sends every ~100 ms);
  * a link that has not completed the authenticated handshake within LINK_AUTH_TIMEOUT_S is closed; connection attempts are rate-limited per address;
  * messages larger than LINK_MAX_MSG bytes close the link.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import queue
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from torqva.telemetry.device_state import Conn
from torqva.device.transport import Transport, TransportError
from torqva.device.wire_protocol import FrameError, parse_frame

LINK_AUTH_TIMEOUT_S = 20.0
LINK_MAX_MSG = 1024
LINK_MIN_INTERVAL_S = 1.0          # per remote address (the board's own backoff starts at 1-1.5 s; 3 s made its second attempt hit this limit and double its backoff)


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
        self.mode = "active"                                  # "standby" while USB holds the command session (see DeviceLinkManager)
        self.last_rx = time.monotonic()                       # any message from the device, in either mode (liveness)
        self.rx_msgs = 0
        self.standby_dev: Optional[str] = None                # the device id the board CLAIMS in its status frames while on standby (not authenticated)
        self.standby_bad = 0                                  # standby lines that were not valid protocol frames
        self.id_cn: Optional[str] = None                      # the open identity challenge sent on this standby link (id_ch)
        self.id_sent_at = 0.0
        self.id_verified_dev: Optional[str] = None            # set only by a valid keyed proof (id_ok) answering OUR challenge on THIS link
        self.id_verified_at: Optional[float] = None
        self.id_failures = 0
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

    async def next_batch(self, limit: int = 1000) -> Optional[str]:
        """The next write plus every line already queued behind it, newline-joined, up to `limit` bytes (the firmware takes several lines per message
        and holds a bounded number of messages: one message per burst instead of one per line). Order is kept; None = the link is closing."""
        first = await self.next_write()
        if first is None:
            return None
        parts, size = [first], len(first.encode("utf-8"))
        while not self._out.empty():
            nxt = self._out._queue[0]                          # peek (asyncio.Queue keeps a deque); only this coroutine consumes
            if nxt is None:
                break                                          # shutdown marker: send what we have; the next call returns None
            n = len(nxt.encode("utf-8"))
            if size + 1 + n > limit:
                break
            self._out.get_nowait(); self._out_slots.release()
            parts.append(nxt); size += 1 + n
        return "\n".join(parts)

    def close(self) -> None:
        self.gone("closed by the backend")


STALE_LINK_S = 1.5                                       # silence after which a link is considered dead when the same address dials again
LINK_SILENT_S = 8.0                                      # an attached link (active or standby) that has sent nothing for this long is closed (the board sends every ~100 ms
                                                         # and network info every 5 s); this is what frees the slot when the board comes back with a NEW address
USB_HANDSHAKE_GRACE_S = 10.0                             # a USB port that has not produced a valid handshake by then yields to a waiting standby Wi-Fi link
STANDBY = "STANDBY"
ID_RETRY_S = 5.0                                         # an unanswered standby identity challenge is replaced after this long
ID_REFRESH_S = 60.0                                      # a proven standby link is challenged again this often (it stays proven meanwhile)


def _default_log_path() -> Optional[Path]:
    """Where link events are recorded (JSON lines, one file per day). TORQVA_LINK_LOG overrides; unset and no device link = no recording."""
    env = os.environ.get("TORQVA_LINK_LOG")
    if env:
        return Path(env)
    if not link_enabled():
        return None
    return Path(__file__).resolve().parents[3] / ".tmp" / "link_log"


class DeviceLinkManager:
    """Admission of device links and their bookkeeping (the bridge keeps the device state itself).

    Exactly one transport is authoritative (the bridge's). A Wi-Fi link that arrives while a handshaken USB session holds the bridge is admitted as STANDBY:
    the backend writes NOTHING to it except identity challenges (id_ch), which the firmware answers with a keyed proof without touching its session, so it
    cannot start a second session (no SESSION_REPLACED, no duplicate command); its liveness and its proven device id are watched, so "Wi-Fi ready" can be shown BEFORE the cable is pulled. When the USB session ends, the standby link is promoted: the bridge runs the
    normal mutual handshake on it, which starts a new session (in-flight USB commands become UNKNOWN_OUTCOME and are never replayed)."""

    def __init__(self, bridge: Any, clock=time.monotonic, log_path: Optional[Path] = None):
        self.bridge, self.clock = bridge, clock
        self._lock = threading.Lock()
        self._log_lock = threading.Lock()                 # separate from _lock: record() is called from the bridge while it holds its own lock
        self._last_attempt: Dict[str, float] = {}
        self.active: Optional[WsTransport] = None
        self.standby: Optional[WsTransport] = None
        self.paused_usb = False
        self.history: list = []                           # recent link events (bounded) for Connection diagnostics
        self.attempts = 0
        self.promotions = 0
        self.log_path = log_path if log_path is not None else _default_log_path()

    def _event(self, kind: str, **kw: Any) -> None:
        self.history.append({"at": time.time(), "kind": kind, **kw})
        del self.history[:-50]
        self.record("link_" + kind, kw)

    def record(self, kind: str, data: Dict[str, Any]) -> None:
        """Append one measured event to the link log (JSON lines). Never raises: a full disk must not affect the link."""
        if self.log_path is None:
            return
        try:
            row = json.dumps({"at": round(time.time(), 3), "kind": kind, **{k: v for k, v in data.items() if k != "updated_at"}}, default=str)
            with self._log_lock:
                d = self.log_path if self.log_path.suffix != ".jsonl" else self.log_path.parent
                d.mkdir(parents=True, exist_ok=True)
                f = self.log_path if self.log_path.suffix == ".jsonl" else d / time.strftime("link-%Y%m%d.jsonl")
                with open(f, "a", encoding="utf-8") as fh:
                    fh.write(row + "\n")
        except (OSError, TypeError, ValueError):
            pass

    # ---- standby
    def standby_feed(self, tr: WsTransport, text: str) -> None:
        """A message on a standby link: only liveness and the claimed identity are kept. Nothing is routed to the bridge and nothing is answered."""
        for line in text.split("\n"):
            line = line.strip("\r")
            if not line:
                continue
            try:
                f = parse_frame(line)
            except FrameError:
                tr.standby_bad += 1
                continue
            if f["t"] == "status":
                tr.standby_dev = f.get("dev") or tr.standby_dev
            elif f["t"] == "id_ok":
                self._check_identity(tr, f)

    def standby_challenge(self, tr: WsTransport, now: Optional[float] = None) -> Optional[str]:
        """The identity challenge to send on a standby link now, if one is due (none open, or the open one is older than ID_RETRY_S; re-proven every
        ID_REFRESH_S). It is the ONLY thing ever written to a standby link, and the firmware answers it without touching its session."""
        now = time.monotonic() if now is None else now
        if tr.id_verified_at is not None and now - tr.id_verified_at < ID_REFRESH_S:
            return None
        if tr.id_cn is not None and now - tr.id_sent_at < ID_RETRY_S:
            return None
        tr.id_cn, tr.id_sent_at = secrets.token_hex(16), now
        return json.dumps({"t": "id_ch", "cn": tr.id_cn}, separators=(",", ":"))

    def _check_identity(self, tr: WsTransport, f: Dict[str, Any]) -> None:
        cn, tr.id_cn = tr.id_cn, None                         # one answer per challenge
        ks = getattr(self.bridge, "keystore", None)
        key = ks.get(f["dev"]) if (ks is not None and cn) else None
        want = hmac.new(key, f"idp|{cn}|{f['dn']}|{f['dev']}".encode(), hashlib.sha256).hexdigest() if key else None
        if want is not None and hmac.compare_digest(want, f["proof"]):
            first = tr.id_verified_dev != f["dev"]
            tr.id_verified_dev, tr.id_verified_at = f["dev"], time.monotonic()
            if first:                                         # the first proof is an event; the periodic refreshes are not
                self._event("standby_authenticated", remote=tr.remote, device_id=f["dev"])
        else:
            tr.id_failures += 1
            tr.id_verified_dev = tr.id_verified_at = None
            self._event("standby_identity_failed", remote=tr.remote, claimed=f.get("dev"), reason="no challenge open" if not cn else ("no key for that device" if not key else "bad proof"))

    def try_promote(self, tr: WsTransport) -> bool:
        """Promote a standby link when the authoritative USB session is gone (or USB never produced a handshake). True once the bridge runs on `tr`."""
        b = self.bridge
        yield_usb = ""
        with self._lock:
            if self.standby is not tr:
                return False
            if b.connected:
                cur = getattr(b, "_transport", None)
                m = getattr(b, "model", None)
                handshaken = m is not None and m.status is not None and m.conn in (Conn.CONNECTED, Conn.STALE)
                since = getattr(m, "connecting_since", None)
                clock = getattr(b, "_clock", time.monotonic)
                if getattr(cur, "kind", "usb") == "usb" and not handshaken and since is not None and clock() - since > USB_HANDSHAKE_GRACE_S:
                    yield_usb = "USB port produced no TORQVA handshake; the standby Wi-Fi link takes over"
                else:
                    return False
        if yield_usb:
            if b.autoconnect is not None and not b.autoconnect.paused:
                b.autoconnect.paused, self.paused_usb = True, True
            b.disconnect(yield_usb)
        try:
            tr.mode = "active"
            b.connect(tr)
        except (RuntimeError, TransportError):
            tr.mode = "standby"                           # USB came back first (autoconnect): stay on standby
            return False
        with self._lock:
            self.standby = None
            self.active = tr
            self.promotions += 1
            self._event("handover", remote=tr.remote, reason=yield_usb or "USB session ended: standby Wi-Fi link promoted (new authenticated session)")
        return True

    def silent(self, tr: WsTransport) -> bool:
        return time.monotonic() - tr.last_rx > LINK_SILENT_S

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
                elif kind == "usb":
                    # A handshaken USB session stays authoritative. The Wi-Fi link is admitted as STANDBY (one standby slot; the same address may redial into it).
                    sb = self.standby
                    if sb is not None and sb.remote != remote and not self.silent(sb):
                        self._event("refused", remote=remote, reason="LINK_BUSY (standby slot taken by another address)")
                        return False, "LINK_BUSY: another Wi-Fi standby link is attached"
                    if sb is not None:
                        sb.gone("replaced by a new standby link")
                        self.standby = None
                    self._event("standby", remote=remote, reason="USB holds the command session; Wi-Fi admitted as standby (no session, nothing sent)")
                    return True, STANDBY
                else:
                    self._event("refused", remote=remote, reason=f"LINK_BUSY ({kind})")
                    return False, f"LINK_BUSY: a device is connected over {kind}"
        if disconnect_reason:
            b.disconnect(disconnect_reason)
        return True, ""

    def attached(self, tr: WsTransport) -> None:
        with self._lock:
            if tr.mode == "standby":
                self.standby = tr
                self._event("standby_attached", remote=tr.remote)
            else:
                self.active = tr
                self._event("connected", remote=tr.remote)

    def detached(self, tr: WsTransport, why: str) -> None:
        with self._lock:
            if self.active is tr:
                self.active = None
            if self.standby is tr:
                self.standby = None
            if self.paused_usb and self.bridge.autoconnect is not None:
                self.bridge.autoconnect.paused, self.paused_usb = False, False
            self._event("disconnected" if tr.mode == "active" else "standby_ended", remote=tr.remote, reason=why, rx_msgs=tr.rx_msgs, lasted_s=round(time.time() - tr.since, 1))

    def status(self) -> Dict[str, Any]:
        with self._lock:
            a, s = self.active, self.standby
            now = time.monotonic()
            standby = None
            if s is not None:
                standby = {"remote": s.remote, "since": s.since, "claimed_device_id": s.standby_dev, "silent_s": round(now - s.last_rx, 1), "messages": s.rx_msgs,
                           "invalid_lines": s.standby_bad, "alive": now - s.last_rx <= LINK_SILENT_S, "authenticated": s.id_verified_dev is not None,
                           "verified_device_id": s.id_verified_dev, "verified_s_ago": round(now - s.id_verified_at, 1) if s.id_verified_at else None,
                           "identity_failures": s.id_failures}
            return {"enabled": link_enabled(), "active": a is not None, "remote": a.remote if a else None, "since": a.since if a else None,
                    "silent_s": round(now - a.last_rx, 1) if a else None, "standby": standby, "promotions": self.promotions,
                    "attempts": self.attempts, "usb_autoconnect_paused": self.paused_usb, "events": list(self.history[-20:])}
