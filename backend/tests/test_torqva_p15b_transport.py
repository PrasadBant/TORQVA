"""Phase 15B: device protocol and secure transport foundation. TLS tests perform REAL handshakes against the real TlsDeviceServer with ephemeral TEST-ONLY certificates
(tests/pki_helper.py). The device side is a Python stand-in (PythonMockDevice): it is NOT the firmware, and no firmware network stack exists yet. No hardware is involved."""
import asyncio
import datetime as dt
import json
import ssl
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent))

pytest.importorskip("cryptography")

import pki_helper as pki
from torqva.device_protocol import MAX_MSG_BYTES, ProtocolError, encode, parse_message
from torqva.device_transport import (CmdState, DeviceGateway, DeviceRegistry, DeviceUnavailable, DispatchRefused, MockLink, PhysicalControlPolicy, SecurityConfigError,
                                     TlsDeviceServer, TlsPolicy, build_server_context)
from torqva.schemas import ActionType, Connection, DecisionVerdict, DeviceSafetyState, Mode, ProposalSource, ProposedAction, Role
from torqva.supervisor import SafetySupervisor, SupervisorContext, SupervisorLimits


def approved(action=ActionType.SET_SPEED, params=None, role=Role.OPERATOR):
    sup = SafetySupervisor(SupervisorLimits(vib_rms_stop_g=2.0, max_rpm=3000.0))
    ctx = SupervisorContext(mode=Mode.SIMULATION, hardware_control_enabled=True, connection=Connection.CONNECTED, device_state=DeviceSafetyState.OK, telemetry_age_s=0.0,
                            sensors_valid=True, motor_running=True, current_setpoint_rpm=1800.0)
    d = sup.check(ProposedAction(action=action, source=ProposalSource.HUMAN, role=role, params=params if params is not None else {"rpm": 1500.0}, human_approved=True), ctx)
    assert d.verdict == DecisionVerdict.ALLOW, d.reasons
    return d.approved


# ===================================================================================================== protocol (pure)
GOOD = {"v": "tqv1", "t": "tel", "dev": "rig-1", "sid": "a" * 32, "n": 1, "ts": 5, "rpm": 100.0, "duty": 10.0, "v_bus": 24.0, "i_a": 1.0, "housing_c": 30.0, "q": 63}


def test_valid_messages_of_every_type_parse():
    assert parse_message(json.dumps(GOOD)).body["rpm"] == 100.0
    assert parse_message(json.dumps({"v": "tqv1", "t": "hello", "dev": "rig-1", "fw": "3.0.0"})).t == "hello"
    assert parse_message(json.dumps({"v": "tqv1", "t": "session", "dev": "rig-1", "sid": "b" * 32})).sid == "b" * 32
    assert parse_message(json.dumps({"v": "tqv1", "t": "cmd", "dev": "rig-1", "sid": "a" * 32, "cid": "c1", "n": 1, "ty": "STOP", "p": 0, "p2": 0, "p3": 0, "ttl_ms": 1000})).t == "cmd"
    assert parse_message(json.dumps({"v": "tqv1", "t": "ack", "dev": "rig-1", "sid": "a" * 32, "cid": "c1", "st": "received"})).body["st"] == "received"
    assert parse_message(json.dumps({"v": "tqv1", "t": "fault", "dev": "rig-1", "sid": "a" * 32, "n": 2, "code": "HEARTBEAT_LOST"})).t == "fault"


@pytest.mark.parametrize("raw,code", [
    (b"x" * (MAX_MSG_BYTES + 1), "OVERSIZE"), (b"not json", "MALFORMED"), (b"[1,2]", "MALFORMED"), (b"\xff\xfe", "MALFORMED"), (b"", "MALFORMED"),
    (json.dumps({**GOOD, "v": "tqv2"}).encode(), "UNSUPPORTED_VERSION"), (json.dumps({k: v for k, v in GOOD.items() if k != "v"}).encode(), "UNSUPPORTED_VERSION"),
    (json.dumps({**GOOD, "t": "weird"}).encode(), "UNKNOWN_TYPE"), (json.dumps({**GOOD, "dev": "bad id!"}).encode(), "BAD_IDENTIFIER"),
    (json.dumps({**GOOD, "sid": "short"}).encode(), "BAD_SESSION_ID"), (json.dumps({**GOOD, "n": -1}).encode(), "BAD_FIELD"), (json.dumps({**GOOD, "n": True}).encode(), "BAD_FIELD"),
    (json.dumps({**GOOD, "rpm": 1e9}).encode(), "OUT_OF_RANGE"), (json.dumps({**GOOD, "q": 64}).encode(), "BAD_FIELD"),
    (b'{"v":"tqv1","t":"tel","dev":"rig-1","sid":"' + b"a" * 32 + b'","n":1,"ts":1,"rpm":NaN,"duty":1,"v_bus":1,"i_a":1,"housing_c":1,"q":1}', "NON_FINITE_NUMBER"),
    (b'{"v":"tqv1","t":"tel","dev":"rig-1","sid":"' + b"a" * 32 + b'","n":1,"ts":1,"rpm":Infinity,"duty":1,"v_bus":1,"i_a":1,"housing_c":1,"q":1}', "NON_FINITE_NUMBER"),
    (json.dumps({"v": "tqv1", "t": "cmd", "dev": "rig-1", "sid": "a" * 32, "cid": "c1", "n": 1, "ty": "FORMAT_DISK", "p": 0, "p2": 0, "p3": 0, "ttl_ms": 1000}).encode(), "UNSUPPORTED_COMMAND"),
    (json.dumps({"v": "tqv1", "t": "cmd", "dev": "rig-1", "sid": "a" * 32, "cid": "c1", "n": 1, "ty": "STOP", "p": 0, "p2": 0, "p3": 0, "ttl_ms": 10 ** 9}).encode(), "BAD_FIELD"),
    (json.dumps({"v": "tqv1", "t": "ack", "dev": "rig-1", "sid": "a" * 32, "cid": "c1", "st": "done"}).encode(), "BAD_ACK_STATE"),
])
def test_invalid_messages_fail_closed_with_a_specific_code(raw, code):
    with pytest.raises(ProtocolError) as e:
        parse_message(raw)
    assert e.value.code == code


def test_encoder_refuses_non_finite_and_oversized_output():
    with pytest.raises(ValueError):
        encode({"t": "x", "p": float("nan")})
    with pytest.raises(ProtocolError):
        encode({"t": "x", "blob": "a" * (MAX_MSG_BYTES + 10)})


# ===================================================================================================== TLS configuration fails closed
def test_server_context_refuses_missing_security_material_and_development_trust_in_production(tmp_path):
    ca = pki.CA(); sc, sk = ca.issue("localhost", server=True)
    cert, key = pki.files(tmp_path, ca, sc, sk, "srv"); cafile = pki.ca_file(tmp_path, ca); crl = pki.crl_file(tmp_path, ca)
    with pytest.raises(SecurityConfigError):
        build_server_context(str(tmp_path / "nope.crt"), key, cafile, crl, TlsPolicy(production=False))
    with pytest.raises(SecurityConfigError):
        build_server_context(cert, key, cafile, None, TlsPolicy(production=False))                       # no CRL -> refuse
    with pytest.raises(SecurityConfigError):
        build_server_context(cert, key, cafile, crl, TlsPolicy(production=True))                         # TORQVA-TEST CA under a production policy
    ctx = build_server_context(cert, key, cafile, crl, TlsPolicy(production=False))
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.minimum_version == ssl.TLSVersion.TLSv1_2
    assert build_server_context(cert, key, cafile, crl, TlsPolicy(production=False, require_tls13=True)).minimum_version == ssl.TLSVersion.TLSv1_3


# ===================================================================================================== real TLS integration
class Rig:
    """One CA, one server, a registry and a gateway, running a real TLS server on localhost."""

    def __init__(self, tmp, policy=TlsPolicy(production=False), gw_policy=PhysicalControlPolicy(), revoked_dev=False, idle=5.0, handshake=2.0, clock=None):
        self.tmp, self.ca = tmp, pki.CA()
        self.srv_cert, self.srv_key = self.ca.issue("localhost", server=True)
        self.dev_cert, self.dev_key = self.ca.issue("rig-1")
        self.registry = DeviceRegistry(); self.registry.register("rig-1", pki.der(self.dev_cert))
        kw = {"clock": clock} if clock else {}
        self.gw = DeviceGateway(self.registry, gw_policy, idle_timeout_s=idle, **kw)
        self.policy, self.idle, self.handshake = policy, idle, handshake
        self.server = None

    def server_ctx(self, revoked=()):
        cert, key = pki.files(self.tmp, self.ca, self.srv_cert, self.srv_key, "srv")
        return build_server_context(cert, key, pki.ca_file(self.tmp, self.ca), pki.crl_file(self.tmp, self.ca, revoked), self.policy)

    async def start(self, revoked=()):
        self.server = TlsDeviceServer(self.gw, self.server_ctx(revoked), handshake_timeout_s=self.handshake, idle_timeout_s=self.idle)
        return await self.server.start()

    async def stop(self):
        await self.server.stop()

    def client_ctx(self, cert=None, key=None, trust=None, minv=None, maxv=None, ciphers=None, with_cert=True):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.load_verify_locations(trust or pki.ca_file(self.tmp, self.ca))
        if with_cert:
            c, k = pki.files(self.tmp, self.ca, cert or self.dev_cert, key or self.dev_key, "cli%d" % id(cert or self))
            ctx.load_cert_chain(c, k)
        if minv: ctx.minimum_version = minv
        if maxv: ctx.maximum_version = maxv
        if ciphers: ctx.set_ciphers(ciphers)
        return ctx


class PythonMockDevice:
    """Stand-in for the device end of the protocol (NOT firmware). Applies the device-side rules: a command must carry the CURRENT session id."""

    def __init__(self, rig, dev="rig-1", **ctx_kw):
        self.rig, self.dev, self.ctx_kw = rig, dev, ctx_kw
        self.sid = None
        self.n = 0
        self.r = self.w = None

    async def connect(self, hello=True, dev_in_hello=None):
        self.r, self.w = await asyncio.open_connection("127.0.0.1", self.rig.server.port, ssl=self.rig.client_ctx(**self.ctx_kw), server_hostname="localhost")
        if hello:
            self.w.write(encode({"t": "hello", "dev": dev_in_hello or self.dev, "fw": "3.0.0-test"})); await self.w.drain()
            line = await asyncio.wait_for(self.r.readline(), 2)
            if not line:
                return None
            self.sid = parse_message(line).sid
        return self.sid

    async def send(self, **m):
        self.w.write(encode({"dev": self.dev, "sid": self.sid, **m})); await self.w.drain()

    async def tel(self, n=None):
        self.n = n if n is not None else self.n + 1
        await self.send(t="tel", n=self.n, ts=self.n, rpm=100.0, duty=10.0, v_bus=24.0, i_a=1.0, housing_c=30.0, q=63)

    async def next_cmd(self):
        line = await asyncio.wait_for(self.r.readline(), 2)
        return parse_message(line)

    async def closed_by_server(self, wait=0.6):
        try:
            data = await asyncio.wait_for(self.r.read(1), wait)
            return data == b""
        except (asyncio.TimeoutError, ConnectionError, ssl.SSLError):
            return False if False else True if wait is None else await self._probe()

    async def _probe(self):
        try:
            self.w.write(b"\n"); await self.w.drain(); await asyncio.wait_for(self.r.read(1), 0.5)
            return True
        except Exception:
            return True

    async def close(self):
        try:
            self.w.close()
        except Exception:
            pass


def run(coro):
    return asyncio.run(coro)


def test_valid_mutual_tls_handshake_issues_a_fresh_session_and_nothing_is_physical_without_commissioning(tmp_path):
    async def go():
        rig = Rig(tmp_path); await rig.start()
        d1, d2 = PythonMockDevice(rig), PythonMockDevice(rig)
        s1 = await d1.connect()
        assert s1 and len(s1) == 32 and rig.gw.fresh_session("rig-1").sid == s1
        s2 = await d2.connect()                                       # a second connection supersedes the first: new random session id
        assert s2 != s1 and rig.gw.fresh_session("rig-1").sid == s2
        assert rig.gw.sessions["rig-1"].link.kind == "tls"
        with pytest.raises(DispatchRefused) as e:
            await rig.gw.dispatch(approved(), "rig-1")                # real link + real device: refused until commissioning is approved
        assert e.value.reason == "physical_control_not_approved"
        await d1.close(); await d2.close(); await rig.stop()
    run(go())


def test_connection_without_a_client_certificate_never_gets_a_session(tmp_path):
    async def go():
        rig = Rig(tmp_path); await rig.start()
        d = PythonMockDevice(rig, with_cert=False)
        try:
            got = await d.connect()
        except (ssl.SSLError, ConnectionError, asyncio.IncompleteReadError):
            got = None
        assert not got and rig.gw.fresh_session("rig-1") is None
        await rig.stop()
    run(go())


def test_client_certificate_from_another_ca_expired_or_revoked_never_gets_a_session(tmp_path):
    async def go():
        rig = Rig(tmp_path)
        other = pki.CA("TORQVA-TEST-OTHER-CA"); bad_cert, bad_key = other.issue("rig-1")
        old_cert, old_key = rig.ca.issue("rig-1", not_before=pki.NOW - dt.timedelta(days=3), not_after=pki.NOW - dt.timedelta(days=2))
        rig.registry.rotate("rig-1", pki.der(old_cert)); rig.registry.rotate("rig-1", pki.der(bad_cert))
        revoked_cert, revoked_key = rig.ca.issue("rig-1"); rig.registry.rotate("rig-1", pki.der(revoked_cert))
        await rig.start(revoked=[revoked_cert.serial_number])                                     # the CRL lists the third certificate
        for c, k in ((bad_cert, bad_key), (old_cert, old_key), (revoked_cert, revoked_key)):
            d = PythonMockDevice(rig, cert=c, key=k)
            try:
                got = await d.connect()
            except (ssl.SSLError, ConnectionError, asyncio.IncompleteReadError):
                got = None
            assert not got
            await d.close()
        assert rig.gw.fresh_session("rig-1") is None
        await rig.stop()
    run(go())


def test_a_client_that_does_not_trust_the_server_certificate_refuses_to_connect(tmp_path):
    async def go():
        rig = Rig(tmp_path); await rig.start()
        stranger = pki.CA("TORQVA-TEST-STRANGER")
        trust = pki.write(tmp_path / "stranger.pem", pki.pem(stranger.cert))
        d = PythonMockDevice(rig, trust=trust)
        with pytest.raises(ssl.SSLCertVerificationError):
            await d.connect()
        assert rig.gw.fresh_session("rig-1") is None
        await rig.stop()
    run(go())


def test_identity_binding_unknown_device_mismatch_unpinned_certificate_and_rotation(tmp_path):
    async def go():
        rig = Rig(tmp_path); await rig.start()
        # certificate CN rig-1 but the hello claims another registered device -> mismatch
        rig.registry.register("rig-2", pki.der(rig.ca.issue("rig-2")[0]))
        d = PythonMockDevice(rig); assert not await d.connect(dev_in_hello="rig-2"); await d.close()
        # valid CA, CN rig-9, never registered
        c9, k9 = rig.ca.issue("rig-9")
        d = PythonMockDevice(rig, dev="rig-9", cert=c9, key=k9); assert not await d.connect(); await d.close()
        # valid CA and CN rig-1 but a different certificate than the pinned one
        cu, ku = rig.ca.issue("rig-1")
        d = PythonMockDevice(rig, cert=cu, key=ku); assert not await d.connect(); await d.close()
        assert {"IDENTITY_MISMATCH", "UNKNOWN_DEVICE", "CERT_NOT_PINNED"} <= set(rig.server.rejected)
        # rotation: pin the new certificate additionally -> it connects; then retire the old one -> the old certificate is refused
        rig.registry.rotate("rig-1", pki.der(cu))
        d = PythonMockDevice(rig, cert=cu, key=ku); assert await d.connect(); await d.close()
        rig.registry.retire_all_but("rig-1", pki.der(cu))
        d = PythonMockDevice(rig); assert not await d.connect(); await d.close()
        await rig.stop()
    run(go())


def test_runtime_revocation_closes_the_session_and_blocks_reconnection(tmp_path):
    async def go():
        rig = Rig(tmp_path); await rig.start()
        d = PythonMockDevice(rig); assert await d.connect()
        rig.gw.revoke("rig-1")
        assert rig.gw.fresh_session("rig-1") is None and rig.gw.sessions["rig-1"].close_reason == "REVOKED"
        d2 = PythonMockDevice(rig); assert not await d2.connect()
        with pytest.raises(DispatchRefused):
            await rig.gw.dispatch(approved(), "rig-1")
        await d.close(); await d2.close(); await rig.stop()
    run(go())


def test_tls_version_and_cipher_policy_no_silent_downgrade(tmp_path):
    async def go():
        rig = Rig(tmp_path)                                                                          # default policy: TLS 1.2 minimum, ECDHE + AEAD only
        await rig.start()
        d = PythonMockDevice(rig, maxv=ssl.TLSVersion.TLSv1_2, ciphers="ECDHE+AESGCM"); assert await d.connect(); await d.close()          # what the installed ESP32 framework can do
        d = PythonMockDevice(rig, maxv=ssl.TLSVersion.TLSv1_2, ciphers="AES128-SHA:@SECLEVEL=0")                                          # static RSA key exchange + CBC
        try:
            got = await d.connect()
        except (ssl.SSLError, ConnectionError, asyncio.IncompleteReadError):
            got = None
        assert not got; await d.close()
        await rig.stop()
        strict = Rig(tmp_path, policy=TlsPolicy(production=False, require_tls13=True)); await strict.start()
        d = PythonMockDevice(strict, maxv=ssl.TLSVersion.TLSv1_2)                                    # a TLS 1.2-only device is refused when TLS 1.3 is required
        try:
            got = await d.connect()
        except (ssl.SSLError, ConnectionError, asyncio.IncompleteReadError):
            got = None
        assert not got; await d.close()
        d = PythonMockDevice(strict, minv=ssl.TLSVersion.TLSv1_3); assert await d.connect(); await d.close()
        await strict.stop()
    run(go())


def test_authentication_timeout_a_connection_that_never_introduces_itself_gets_no_session(tmp_path):
    async def go():
        rig = Rig(tmp_path, handshake=0.3); await rig.start()
        d = PythonMockDevice(rig)
        await d.connect(hello=False)
        await asyncio.sleep(0.8)
        assert "AUTH_TIMEOUT" in rig.server.rejected and rig.gw.fresh_session("rig-1") is None
        await d.close(); await rig.stop()
    run(go())


def test_command_lifecycle_received_is_not_executed_and_the_command_is_bound_to_the_session(tmp_path):
    async def go():
        rig = Rig(tmp_path, gw_policy=PhysicalControlPolicy(commissioning_approved=True))        # test-only: simulate the human commissioning decision
        await rig.start()
        d = PythonMockDevice(rig); sid = await d.connect()
        cr = await rig.gw.dispatch(approved(), "rig-1")
        assert cr.state == CmdState.SENT and cr.physical is True
        cmd = await d.next_cmd()
        assert cmd.sid == sid and cmd.dev == "rig-1" and cmd.body["ty"] == "SET_SPEED" and cmd.body["p"] == 1500.0 and cmd.body["n"] == 1
        await d.send(t="ack", cid=cmd.body["cid"], st="received"); await asyncio.sleep(0.1)
        assert cr.state == CmdState.RECEIVED                                  # received is not executed
        await d.send(t="ack", cid=cmd.body["cid"], st="executed", reason="OK"); await asyncio.sleep(0.1)
        assert cr.state == CmdState.EXECUTED
        await d.send(t="ack", cid=cmd.body["cid"], st="received"); await asyncio.sleep(0.1)       # duplicate / late ack never changes a finished command
        assert cr.state == CmdState.EXECUTED and rig.gw.stale_acks == 1
        await d.close(); await rig.stop()
    run(go())


def test_protocol_violations_close_the_connection_and_never_change_command_state(tmp_path):
    async def go():
        rig = Rig(tmp_path, gw_policy=PhysicalControlPolicy(commissioning_approved=True)); await rig.start()
        for bad in ("replayed_tel", "wrong_session", "wrong_device", "unknown_cid", "malformed", "oversize", "bad_version"):
            d = PythonMockDevice(rig); await d.connect()
            cr = await rig.gw.dispatch(approved(), "rig-1"); await d.next_cmd()
            await d.tel(1); await asyncio.sleep(0.05)
            if bad == "replayed_tel": await d.tel(1)
            elif bad == "wrong_session": d.sid = "f" * 32; await d.tel(5)
            elif bad == "wrong_device": d.dev = "rig-2"; await d.tel(5)
            elif bad == "unknown_cid": await d.send(t="ack", cid="c99-zzzz", st="executed", reason="")
            elif bad == "malformed": d.w.write(b"{broken\n"); await d.w.drain()
            elif bad == "oversize": d.w.write(b"x" * (MAX_MSG_BYTES + 50) + b"\n"); await d.w.drain()
            elif bad == "bad_version": d.w.write(b'{"v":"tqv9","t":"tel"}\n'); await d.w.drain()
            await asyncio.sleep(0.2)
            s = rig.gw.sessions["rig-1"]
            assert s.closed, bad
            assert cr.state == CmdState.LINK_LOST, bad                           # the command's outcome is unknown, never "executed"
            await d.close()
        await rig.stop()
    run(go())


def test_old_session_traffic_is_invalid_after_reconnect_and_pending_commands_are_never_replayed(tmp_path):
    async def go():
        rig = Rig(tmp_path, gw_policy=PhysicalControlPolicy(commissioning_approved=True)); await rig.start()
        d1 = PythonMockDevice(rig); sid1 = await d1.connect()
        cr1 = await rig.gw.dispatch(approved(), "rig-1"); captured = await d1.next_cmd()          # an eavesdropper (or the old link) holds this command
        await d1.close(); await asyncio.sleep(0.2)
        assert cr1.state == CmdState.LINK_LOST                                                  # session ended: outcome unknown
        d2 = PythonMockDevice(rig); sid2 = await d2.connect()
        assert sid2 != sid1 and d2.sid != captured.sid                                           # device-side rule: a command for the OLD session id is not valid now
        cr2 = await rig.gw.dispatch(approved(ActionType.STOP, {}), "rig-1")
        fresh = await d2.next_cmd()
        assert fresh.body["cid"] == cr2.cid and fresh.body["ty"] == "STOP"                       # ONLY the new command arrives: nothing was re-sent on reconnect
        # an ack for the OLD command with the OLD session id is a violation and cannot touch the new command
        d2.sid = sid1; await d2.send(t="ack", cid=captured.body["cid"], st="executed", reason="OK"); await asyncio.sleep(0.2)
        assert rig.gw.sessions["rig-1"].closed and cr1.state == CmdState.LINK_LOST and cr2.state == CmdState.LINK_LOST
        await d2.close(); await rig.stop()
    run(go())


def test_device_reboot_is_a_new_session_and_server_restart_requires_reauthentication(tmp_path):
    async def go():
        rig = Rig(tmp_path, gw_policy=PhysicalControlPolicy(commissioning_approved=True)); await rig.start()
        d = PythonMockDevice(rig); sid1 = await d.connect(); await d.tel(1)
        await d.close()                                                                           # "reboot": counters and session are gone
        d = PythonMockDevice(rig); sid2 = await d.connect(); await d.tel(1); await asyncio.sleep(0.15)   # the counter restarts at 1 but the session id is new, so it is valid only here
        assert sid2 != sid1 and rig.gw.sessions["rig-1"].last_rx_n == 1
        await rig.stop()                                                                          # server restart: every session is gone
        await asyncio.sleep(0.2)
        assert rig.gw.fresh_session("rig-1") is None
        await rig.start()
        d3 = PythonMockDevice(rig); sid3 = await d3.connect()
        assert sid3 not in (sid1, sid2)
        await d.close(); await d3.close(); await rig.stop()
    run(go())


def test_idle_session_expires_and_a_disconnected_device_is_never_shown_healthy(tmp_path):
    t = [100.0]
    async def go():
        rig = Rig(tmp_path, idle=5.0, clock=lambda: t[0]); await rig.start()
        d = PythonMockDevice(rig); await d.connect(); await d.tel(1); await asyncio.sleep(0.2)
        st = rig.gw.device_state("rig-1")
        assert st["connected"] and st["telemetry_fresh"] and st["healthy"] is True and st["link_kind"] == "tls"
        t[0] += 6.0                                                                               # no traffic for longer than the idle timeout
        st = rig.gw.device_state("rig-1")
        assert not st["connected"] and st["healthy"] is None and st["telemetry_fresh"] is False
        with pytest.raises(DeviceUnavailable):
            await rig.gw.dispatch(approved(ActionType.STOP, {}), "rig-1")
        await d.close(); await rig.stop()
    run(go())


def test_stop_needs_only_a_fresh_authenticated_session_while_motion_needs_commissioning(tmp_path):
    async def go():
        rig = Rig(tmp_path); await rig.start()                                                    # commissioning NOT approved
        d = PythonMockDevice(rig); await d.connect()
        with pytest.raises(DispatchRefused):
            await rig.gw.dispatch(approved(ActionType.SET_SPEED), "rig-1")
        cr = await rig.gw.dispatch(approved(ActionType.STOP, {}, Role.VIEWER), "rig-1")           # a protective stop is allowed on the authenticated session
        assert (await d.next_cmd()).body["ty"] == "STOP" and cr.physical
        await d.close(); await rig.stop()
        with pytest.raises(DeviceUnavailable):                                                    # no session -> the gateway cannot stop; local firmware protection (not this path) remains
            await rig.gw.dispatch(approved(ActionType.STOP, {}), "rig-1")
    run(go())


# ===================================================================================================== gateway rules (mock link)
def test_mock_link_is_never_physical_and_simulation_cannot_masquerade_as_a_device(tmp_path):
    async def go():
        reg = DeviceRegistry(); reg.register("sim-1", b"unused-cert-der", physical=False); reg.register("rig-1", b"other-der", physical=True)
        gw = DeviceGateway(reg, PhysicalControlPolicy(commissioning_approved=False))
        link = MockLink(); s = gw.open_session("sim-1", link)
        cr = await gw.dispatch(approved(), "sim-1")                                              # mock/simulated devices work without credentials or approval
        assert cr.physical is False and gw.device_state("sim-1")["physical"] is False and gw.device_state("sim-1")["link_kind"] == "mock"
        link2 = MockLink(); gw.open_session("rig-1", link2)                                      # a mock link claiming a physical device id is still not physical
        cr2 = await gw.dispatch(approved(), "rig-1")
        assert cr2.physical is False
        # telemetry provenance records the link kind, so it can never be displayed as a physical-device observation
        from torqva.device_protocol import parse_message as pm
        gw.handle(s, pm(json.dumps({**GOOD, "dev": "sim-1", "sid": s.sid})))
        assert gw.latest_telemetry["sim-1"]["provenance"] == "DEVICE_TELEMETRY_MOCK"
    run(go())


def test_gateway_only_dispatches_supervisor_approved_actions_and_known_device_commands():
    async def go():
        reg = DeviceRegistry(); reg.register("sim-1", b"x", physical=False)
        gw = DeviceGateway(reg); gw.open_session("sim-1", MockLink())
        with pytest.raises(PermissionError):
            await gw.dispatch(object(), "sim-1")
        with pytest.raises(PermissionError):
            await gw.dispatch({"action": "STOP"}, "sim-1")
        with pytest.raises(DispatchRefused):
            await gw.dispatch(approved(), "nobody")
    run(go())


def test_commands_expire_without_acknowledgement_and_are_never_resent():
    async def go():
        t = [0.0]
        reg = DeviceRegistry(); reg.register("sim-1", b"x", physical=False)
        gw = DeviceGateway(reg, clock=lambda: t[0], idle_timeout_s=1000); link = MockLink(); gw.open_session("sim-1", link)
        cr = await gw.dispatch(approved(), "sim-1")
        t[0] += 6.0
        assert gw.expire() == [cr] and cr.state == CmdState.EXPIRED
        assert len(link.sent) == 1                                                                # one write, ever
    run(go())


def test_missing_security_configuration_means_no_transport_and_no_physical_control():
    reg = DeviceRegistry()
    gw = DeviceGateway(reg)
    assert gw.policy.commissioning_approved is False
    assert gw.device_state("rig-1") == {"device": "rig-1", "registered": False, "revoked": False, "connected": False, "link_kind": None, "physical": False,
                                        "telemetry_fresh": False, "healthy": None, "physical_control_approved": False}
    with pytest.raises(SecurityConfigError):
        build_server_context("", "", "", None)


def test_devices_endpoint_reports_unavailable_without_a_transport_and_never_a_healthy_fake():
    import hashlib
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from torqva.api import create_router
    from torqva.auth import TokenAuth
    from torqva.service import SimulationService
    svc = SimulationService()
    app = FastAPI(); app.include_router(create_router(svc, TokenAuth([{"sha256": hashlib.sha256(b"v").hexdigest(), "user": "v", "role": "viewer"}])))
    c = TestClient(app); H = {"Authorization": "Bearer v"}
    assert c.get("/api/torqva/devices").status_code == 401
    j = c.get("/api/torqva/devices", headers=H).json()
    assert j["physical_transport"] == "UNAVAILABLE" and j["devices"] == [] and j["physical_control_approved"] is False
    reg = DeviceRegistry(); reg.register("sim-1", b"x", physical=False)
    svc.gateway = DeviceGateway(reg); svc.gateway.open_session("sim-1", MockLink())
    j = c.get("/api/torqva/devices", headers=H).json()
    d = j["devices"][0]
    assert j["physical_transport"] == "CONFIGURED" and d["link_kind"] == "mock" and d["physical"] is False and d["healthy"] is None and j["physical_control_approved"] is False

