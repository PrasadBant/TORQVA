"""Secure device transport foundation (SOFTWARE ONLY). Nothing here talks to hardware: there is no firmware-side network stack yet (see docs/TORQVA_HARDWARE_READINESS.md).

What is real: the mutually authenticated TLS server (stdlib `ssl`/OpenSSL), the device registry with certificate pinning, the CRL check, the session and command-lifecycle rules
and the gateway that only accepts supervisor-approved actions. What is a mock: `MockLink` (in-memory, kind="mock", never physical). Physical actuation is refused unless the link is
real TLS AND `PhysicalControlPolicy.commissioning_approved` is set by a human decision; it defaults to False and nothing in the repository sets it.

Authority chain: authenticated request -> authorisation -> deterministic Safety Supervisor (the only minter of ApprovedAction) -> DeviceGateway.dispatch -> secure link ->
device-side validation -> ack(received/executed/...) -> observed outcome (C5, separate). The AI, the LLM and the frontend never reach this module.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import secrets
import ssl
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Set

from .device_protocol import MAX_MSG_BYTES, Message, ProtocolError, TERMINAL_ACK_STATES, encode, parse_message
from .schemas import ActionType
from .supervisor import ApprovedAction


class SecurityConfigError(Exception):
    """Security configuration is missing or unsafe: the transport must not start (fail closed)."""


class DeviceUnavailable(Exception):
    """No fresh authenticated session for the device."""


class DispatchRefused(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


# --------------------------------------------------------------------------------------------------------------------- TLS configuration
@dataclass(frozen=True)
class TlsPolicy:
    """Installed ESP32 framework (Arduino-ESP32 2.0.17) bundles mbedTLS 2.28.7, which supports TLS 1.2 at most. The default therefore allows TLS 1.2 with ECDHE + AEAD suites only;
    `require_tls13=True` is the target once the device framework supports it. Never silently downgraded: the minimum version is explicit configuration, and anything weaker is refused."""
    require_tls13: bool = False
    ciphers: str = "ECDHE+AESGCM:ECDHE+CHACHA20"        # TLS 1.2 suites: forward secrecy + AEAD only (no CBC, no RSA key exchange, no static DH)
    require_crl: bool = True                              # no revocation information -> refuse to start (fail closed)
    production: bool = True                               # production refuses development trust anchors


def _der_of_first_cert(pem_path: str) -> bytes:
    with open(pem_path, "r") as f:
        text = f.read()
    start = text.index("-----BEGIN CERTIFICATE-----")
    end = text.index("-----END CERTIFICATE-----", start) + len("-----END CERTIFICATE-----")
    return ssl.PEM_cert_to_DER_cert(text[start:end])


def build_server_context(cert: str, key: str, ca: str, crl: Optional[str], policy: TlsPolicy = TlsPolicy()) -> ssl.SSLContext:
    for label, path in (("server certificate", cert), ("server key", key), ("client CA", ca)):
        if not path or not os.path.isfile(path):
            raise SecurityConfigError(f"missing {label}: {path!r}")
    if crl is None or not os.path.isfile(crl):
        if policy.require_crl:
            raise SecurityConfigError("no certificate revocation list available (require_crl=True)")
        crl = None
    if policy.production and b"TORQVA-TEST" in _der_of_first_cert(ca):
        raise SecurityConfigError("development/test CA presented to a production TLS policy")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_3 if policy.require_tls13 else ssl.TLSVersion.TLSv1_2
    if not policy.require_tls13:
        ctx.set_ciphers(policy.ciphers)
    ctx.verify_mode = ssl.CERT_REQUIRED                  # mutual authentication: a client without a valid certificate cannot complete the handshake
    ctx.load_cert_chain(cert, key)
    ctx.load_verify_locations(ca)
    if crl:
        ctx.load_verify_locations(crl)
        ctx.verify_flags |= ssl.VERIFY_CRL_CHECK_LEAF
    ctx.options |= ssl.OP_NO_COMPRESSION | getattr(ssl, "OP_NO_RENEGOTIATION", 0)
    return ctx


# --------------------------------------------------------------------------------------------------------------------- registry
def fingerprint(der: bytes) -> str:
    return hashlib.sha256(der).hexdigest()


@dataclass
class DeviceRecord:
    device_id: str
    fingerprints: Set[str] = field(default_factory=set)     # pinned SHA-256 of the DER client certificates currently allowed (two during a rotation)
    revoked: bool = False
    physical: bool = True


class DeviceRegistry:
    """Device identities are separate from user identities. A device is allowed only if registered, not revoked, and presenting a PINNED certificate whose CN equals its id."""

    def __init__(self):
        self._d: Dict[str, DeviceRecord] = {}

    def register(self, device_id: str, cert_der: bytes, physical: bool = True) -> None:
        self._d[device_id] = DeviceRecord(device_id, {fingerprint(cert_der)}, False, physical)

    def rotate(self, device_id: str, new_cert_der: bytes, retire_old: bool = False) -> None:
        r = self._d[device_id]
        if retire_old:
            r.fingerprints.clear()
        r.fingerprints.add(fingerprint(new_cert_der))

    def retire_all_but(self, device_id: str, keep_cert_der: bytes) -> None:
        self._d[device_id].fingerprints = {fingerprint(keep_cert_der)}

    def revoke(self, device_id: str) -> None:
        if device_id in self._d:
            self._d[device_id].revoked = True

    def get(self, device_id: str) -> Optional[DeviceRecord]:
        return self._d.get(device_id)

    def authorise(self, device_id: str, cert_der: bytes, cert_cn: str) -> Optional[str]:
        """None = allowed, else a reason code."""
        r = self._d.get(device_id)
        if r is None:
            return "UNKNOWN_DEVICE"
        if r.revoked:
            return "REVOKED"
        if cert_cn != device_id:
            return "IDENTITY_MISMATCH"
        if fingerprint(cert_der) not in r.fingerprints:
            return "CERT_NOT_PINNED"
        return None


# --------------------------------------------------------------------------------------------------------------------- links
class Link:
    kind = "abstract"                                        # "tls" (real) | "mock"

    async def send(self, data: bytes) -> None:               # pragma: no cover - interface
        raise NotImplementedError

    def close(self) -> None:                                  # pragma: no cover - interface
        raise NotImplementedError


class MockLink(Link):
    """In-memory link for integration tests. NOT a physical transport and never treated as one."""
    kind = "mock"

    def __init__(self):
        self.sent: List[bytes] = []
        self.closed = False

    async def send(self, data: bytes) -> None:
        if self.closed:
            raise ConnectionError("closed")
        self.sent.append(data)

    def close(self) -> None:
        self.closed = True


class StreamLink(Link):
    kind = "tls"

    def __init__(self, writer: asyncio.StreamWriter):
        self._w = writer

    async def send(self, data: bytes) -> None:
        self._w.write(data)
        await self._w.drain()

    def close(self) -> None:
        try:
            self._w.close()
        except Exception:                                    # pragma: no cover
            pass


# --------------------------------------------------------------------------------------------------------------------- sessions and commands
class CmdState(str, Enum):
    SENT = "SENT"                  # written to the secure link; NOT known to be received
    RECEIVED = "RECEIVED"          # the device acknowledged receipt (NOT execution)
    EXECUTED = "EXECUTED"          # the device reports it took effect (NOT verified recovery: that is C5, from observed data)
    REJECTED = "REJECTED"
    ABORTED = "ABORTED"
    LINK_LOST = "LINK_LOST"        # the session ended first: unknown outcome, NEVER re-sent
    EXPIRED = "EXPIRED"            # ttl elapsed without an acknowledgement: not executed as far as we know, NEVER re-sent


_FINAL = (CmdState.EXECUTED, CmdState.REJECTED, CmdState.ABORTED, CmdState.LINK_LOST, CmdState.EXPIRED)
_TY = {ActionType.STOP: "STOP", ActionType.START: "START", ActionType.SET_SPEED: "SET_SPEED", ActionType.REDUCE_SPEED: "SET_SPEED", ActionType.RUN_TEST: "RUN_TEST",
       ActionType.ABORT_TEST: "ABORT_TEST", ActionType.HEARTBEAT: "HEARTBEAT", ActionType.RESET_ESTOP: "RESET_ESTOP"}


@dataclass
class CommandRecord:
    cid: str
    dev: str
    sid: str
    n: int
    action: str
    sent_at: float
    ttl_ms: int
    physical: bool
    state: CmdState = CmdState.SENT
    reason: str = ""


@dataclass
class Session:
    dev: str
    sid: str
    link: Link
    started: float
    last_rx: float
    next_cmd_n: int = 1
    last_rx_n: int = 0
    pending: Dict[str, CommandRecord] = field(default_factory=dict)
    closed: bool = False
    close_reason: str = ""


@dataclass(frozen=True)
class PhysicalControlPolicy:
    """Physical actuation is a human commissioning decision. Default False; nothing in the repository sets it."""
    commissioning_approved: bool = False


class DeviceGateway:
    def __init__(self, registry: DeviceRegistry, policy: PhysicalControlPolicy = PhysicalControlPolicy(), idle_timeout_s: float = 10.0,
                 clock: Callable[[], float] = time.monotonic, log: Optional[Callable[[str, Dict[str, Any]], None]] = None):
        self.registry, self.policy, self.idle_timeout_s, self._clock = registry, policy, idle_timeout_s, clock
        self.sessions: Dict[str, Session] = {}
        self.records: Dict[str, CommandRecord] = {}
        self.latest_telemetry: Dict[str, Dict[str, Any]] = {}
        self.violations = 0
        self.stale_acks = 0
        self._log = log or (lambda event, detail: None)          # events carry codes and device ids, never keys, certificates or payload secrets

    # ---- sessions
    def open_session(self, dev: str, link: Link) -> Session:
        old = self.sessions.get(dev)
        if old is not None and not old.closed:
            self.close_session(old, "SUPERSEDED")                # a new connection ends the old session; the old session's commands are never valid again
        now = self._clock()
        s = Session(dev, secrets.token_hex(16), link, now, now)
        self.sessions[dev] = s
        self._log("session_open", {"dev": dev, "kind": link.kind})
        return s

    def close_session(self, s: Session, reason: str) -> None:
        if s.closed:
            return
        s.closed, s.close_reason = True, reason
        for rec in s.pending.values():
            if rec.state not in _FINAL:
                rec.state, rec.reason = CmdState.LINK_LOST, reason     # unknown outcome: never replayed on a later session
        try:
            s.link.close()
        except Exception:                                        # pragma: no cover
            pass
        self._log("session_close", {"dev": s.dev, "reason": reason})

    def revoke(self, dev: str) -> None:
        self.registry.revoke(dev)
        s = self.sessions.get(dev)
        if s is not None:
            self.close_session(s, "REVOKED")

    def fresh_session(self, dev: str) -> Optional[Session]:
        s = self.sessions.get(dev)
        if s is None or s.closed:
            return None
        if self._clock() - s.last_rx > self.idle_timeout_s:
            self.close_session(s, "IDLE_TIMEOUT")
            return None
        return s

    # ---- commands (supervisor-approved only)
    async def dispatch(self, approved: ApprovedAction, dev: str) -> CommandRecord:
        if not isinstance(approved, ApprovedAction):
            raise PermissionError("dispatch() accepts only supervisor-approved actions")
        ty = _TY.get(approved.action)
        if ty is None:
            raise ValueError(f"{approved.action} is not a device command")
        rec = self.registry.get(dev)
        if rec is None or rec.revoked:
            raise DispatchRefused("unknown_or_revoked_device")
        s = self.fresh_session(dev)
        if s is None:
            raise DeviceUnavailable(dev)
        physical = s.link.kind == "tls" and rec.physical
        if physical and not self.policy.commissioning_approved and ty != "STOP":
            raise DispatchRefused("physical_control_not_approved")      # real link + real device: needs the human commissioning decision (STOP can only make things safer)
        if s.link.kind not in ("tls", "mock"):
            raise DispatchRefused("unknown_link_kind")
        p = approved.params
        n = s.next_cmd_n
        s.next_cmd_n += 1
        cid = f"c{n}-{secrets.token_hex(4)}"
        p1 = p.get("rpm", p.get("duty_pct", p.get("test", 0.0)))
        p2 = p.get("fraction", p.get("duration_ms", 0.0))
        wire = {"t": "cmd", "dev": dev, "sid": s.sid, "cid": cid, "n": n, "ty": ty, "p": float(p1), "p2": float(p2), "p3": float(p.get("hold_ms", 0.0)), "ttl_ms": 5000}
        cr = CommandRecord(cid, dev, s.sid, n, ty, self._clock(), 5000, physical)
        s.pending[cid] = cr
        self.records[cid] = cr
        await s.link.send(encode(wire))                              # one write; no automatic retry exists
        return cr

    def expire(self) -> List[CommandRecord]:
        now, out = self._clock(), []
        for cr in self.records.values():
            if cr.state in (CmdState.SENT, CmdState.RECEIVED) and (now - cr.sent_at) * 1000 >= cr.ttl_ms:
                cr.state, cr.reason = CmdState.EXPIRED, "ttl"
                out.append(cr)
        return out

    # ---- inbound (already parsed by device_protocol.parse_message)
    def handle(self, s: Session, m: Message) -> None:
        """Raises ProtocolError on any violation; the caller closes the connection (fail closed)."""
        if s.closed:
            raise ProtocolError("SESSION_CLOSED")
        if m.dev != s.dev:
            self.violations += 1
            raise ProtocolError("WRONG_DEVICE")
        if m.sid != s.sid:
            self.violations += 1
            raise ProtocolError("WRONG_SESSION")
        if m.t in ("tel", "fault"):
            n = m.body["n"]
            if n <= s.last_rx_n:
                self.violations += 1
                raise ProtocolError("OUT_OF_ORDER", f"{n}<={s.last_rx_n}")
            s.last_rx_n = n
            if m.t == "tel":
                self.latest_telemetry[s.dev] = {**m.body, "received_at": self._clock(), "sid": s.sid, "provenance": "DEVICE_TELEMETRY_" + s.link.kind.upper()}
        elif m.t == "ack":
            cr = s.pending.get(m.body["cid"])
            if cr is None:
                self.stale_acks += 1
                raise ProtocolError("UNKNOWN_COMMAND")              # an ack for a command this session never sent
            st = m.body["st"]
            if cr.state in _FINAL:
                self.stale_acks += 1                                # duplicate / late ack: never changes a finished command
            elif st == "received":
                if cr.state == CmdState.SENT:
                    cr.state = CmdState.RECEIVED
            elif st in TERMINAL_ACK_STATES:
                cr.state = {"executed": CmdState.EXECUTED, "rejected": CmdState.REJECTED, "aborted": CmdState.ABORTED}[st]
                cr.reason = m.body["reason"]
        elif m.t == "bye":
            self.close_session(s, "BYE")
            return
        else:
            self.violations += 1
            raise ProtocolError("UNEXPECTED_TYPE", m.t)
        s.last_rx = self._clock()

    # ---- what the UI may show
    def device_state(self, dev: str) -> Dict[str, Any]:
        rec = self.registry.get(dev)
        s = self.fresh_session(dev)
        tel = self.latest_telemetry.get(dev)
        fresh_tel = bool(tel and s is not None and tel["sid"] == s.sid and self._clock() - tel["received_at"] <= self.idle_timeout_s)
        return {"device": dev, "registered": rec is not None, "revoked": bool(rec and rec.revoked), "connected": s is not None,
                "link_kind": s.link.kind if s else None, "physical": bool(rec and rec.physical and s and s.link.kind == "tls"),
                "telemetry_fresh": fresh_tel, "healthy": None if not fresh_tel else True,           # a disconnected device is NEVER shown as healthy
                "physical_control_approved": self.policy.commissioning_approved}


# --------------------------------------------------------------------------------------------------------------------- TLS server
def _cert_cn(cert: Dict[str, Any]) -> str:
    for rdn in cert.get("subject", ()):
        for k, v in rdn:
            if k == "commonName":
                return v
    return ""


class TlsDeviceServer:
    def __init__(self, gateway: DeviceGateway, ctx: ssl.SSLContext, host: str = "127.0.0.1", port: int = 0, handshake_timeout_s: float = 5.0,
                 idle_timeout_s: float = 10.0):
        self.gw, self.ctx, self.host, self.port = gateway, ctx, host, port
        self.handshake_timeout_s, self.idle_timeout_s = handshake_timeout_s, idle_timeout_s
        self._server: Optional[asyncio.AbstractServer] = None
        self.rejected: List[str] = []                       # reason codes of refused connections (no secrets)

    async def start(self) -> int:
        self._server = await asyncio.start_server(self._handle, self.host, self.port, ssl=self.ctx, ssl_handshake_timeout=self.handshake_timeout_s, limit=MAX_MSG_BYTES + 2)
        self.port = self._server.sockets[0].getsockname()[1]
        return self.port

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        sess: Optional[Session] = None
        try:
            ssl_obj = writer.get_extra_info("ssl_object")
            der = ssl_obj.getpeercert(binary_form=True) if ssl_obj else None
            cert = ssl_obj.getpeercert() if ssl_obj else None
            if not der or not cert:
                self.rejected.append("NO_CLIENT_CERT")
                return
            try:
                line = await asyncio.wait_for(reader.readline(), self.handshake_timeout_s)       # authentication timeout: the device must introduce itself promptly
                hello = parse_message(line)
            except asyncio.TimeoutError:
                self.rejected.append("AUTH_TIMEOUT")
                return
            except (ProtocolError, ValueError, asyncio.LimitOverrunError) as e:
                self.rejected.append(getattr(e, "code", "MALFORMED"))
                return
            if hello.t != "hello":
                self.rejected.append("EXPECTED_HELLO")
                return
            why = self.gw.registry.authorise(hello.dev, der, _cert_cn(cert))
            if why:
                self.rejected.append(why)
                return
            sess = self.gw.open_session(hello.dev, StreamLink(writer))
            await sess.link.send(encode({"t": "session", "dev": sess.dev, "sid": sess.sid}))
            while not sess.closed:
                try:
                    line = await asyncio.wait_for(reader.readline(), self.idle_timeout_s)
                except asyncio.TimeoutError:
                    self.gw.close_session(sess, "IDLE_TIMEOUT")
                    break
                if not line:
                    self.gw.close_session(sess, "DISCONNECTED")
                    break
                try:
                    self.gw.handle(sess, parse_message(line))
                except ProtocolError as e:
                    self.rejected.append(e.code)
                    self.gw.close_session(sess, "PROTOCOL_" + e.code)
                    break
        except (ConnectionError, ssl.SSLError, ValueError, asyncio.IncompleteReadError):
            if sess is not None:
                self.gw.close_session(sess, "LINK_ERROR")
        finally:
            if sess is not None and not sess.closed:
                self.gw.close_session(sess, "LINK_CLOSED")
            try:
                writer.close()
            except Exception:                                # pragma: no cover
                pass
