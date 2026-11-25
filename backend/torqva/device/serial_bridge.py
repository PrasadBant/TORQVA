"""USB-serial bridge between the ESP32-S3 firmware and the TORQVA backend. The backend OWNS the serial port (one reader thread, one locked writer); the browser never touches it.

Wire protocol = the firmware's own JSON-lines protocol, version 1 (firmware/lib/torqva_core/communication/protocol.cpp), 115200 8N1 over USB-CDC (the baud rate is ignored by USB-CDC but is
configured explicitly). One object per line, at most MAX_LINE bytes:
  fast   {t,seq,ts,rpm,sp,duty,v,i,p,q}                  10 Hz    rpm [rpm], setpoint [rpm], duty [%], bus voltage [V], current [A], power [W], q = validity bit mask
  slow   {t,seq,ts,housing,ambient,q}                    1 Hz     degrees C
  status {t,seq,ts,fw,wiring,limits_v,state,reason,mode,drive,ctl,hb_age,test,proto,dev,blk,fm}   1 Hz and on change; proto must be 1
  ack    {t,id,status,reason[,dev][,sid]}                reply to a command id
`q` bits: current 1, voltage 2, housing 4, ambient 8, rpm 16, vibration 32; a clear bit means INVALID and the value is never shown as a number. The firmware does not measure vibration or
acceleration yet (bit 32 is always clear): they are reported as "unavailable". `seq` is one gapless counter shared by all frame types; a restart of the device shows as seq going backwards.

TRUST BOUNDARY (explicit): USB serial gives NO authentication, encryption or session. It is treated as inside the physical trust boundary of the host computer; anyone with access to the
port or the host can talk to the device. That is why physical START / speed commands stay blocked (see control_blockers): the device's own interlocks (NO_SECURE_SESSION, limits, E-stop)
refuse them and this bridge refuses to send them. Only STOP, which needs no authentication and can only make things safer, is sendable. A web STOP is not an emergency stop.
"""
from __future__ import annotations

import collections
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
from typing import Any, Callable, Deque, Dict, List, Optional

from torqva.analysis.physical_adapter import analysis_status, compute_physical_diagnostics
from torqva.models.schemas import Role
from torqva.control.commands import CmdState, CommandRecord, _OPEN
from torqva.control.manual import submit_manual_command
from torqva.device.transport import ERROR_HELP, Transport, TransportError
from torqva.device.wire_protocol import FrameError, UINT32, WIRE_PROTOCOL, escape_sample, parse_frame
from torqva.safety.operating_policy import PhysicalControlPolicy, describe_interlocks
from torqva.telemetry.device_state import Conn, DeviceModel
from torqva.telemetry.events import EventHub

log = logging.getLogger("torqva.serial")

ERROR_EVENT_INTERVAL_S = 2.0                # repeated protocol errors are aggregated into one event per code per interval
HANDSHAKE_TIMEOUT_S = 5.0                   # port open but no valid status frame for this long -> HANDSHAKE_TIMEOUT diagnostic (no disconnect, no retry loop)





COMMAND_TIMEOUT_S = 6.0
MAX_COMMANDS_KEPT = 200






# --------------------------------------------------------------------------------------------------------------- transports
# --------------------------------------------------------------------------------------------------------------- event hub (bounded)
# --------------------------------------------------------------------------------------------------------------- the bridge
class DeviceBridge:
    def __init__(self, hub: Optional[EventHub] = None, policy: Optional[PhysicalControlPolicy] = None, expected_device_id: Optional[str] = None,
                 clock: Callable[[], float] = time.monotonic, wall: Callable[[], float] = time.time):
        self.hub = hub or EventHub()
        self.autoconnect = None                                    # optional AutoConnector (only when TORQVA_DEVICE_PORT is configured)
        self.link = None                                           # DeviceLinkManager for Wi-Fi device links (set by device_routes; see device_link.py)
        self.keystore = None                                       # optional KeyStore (per-device authentication keys); None = no authenticated session can ever start
        self._auth: Dict[str, Any] = {"state": "none"}
        self._hb_ids: "collections.deque[int]" = collections.deque(maxlen=64)       # ids of the periodic authenticated heartbeats (their acknowledgements are not command results)
        self._hb_last = 0.0
        self._cfg: Dict[str, Any] = {}                             # runtime-limit push state: {sent_ver, sent_at, ack_ok, ack_reason}
        self.ota_info: Optional[Dict[str, Any]] = None             # the latest "ota_info" frame (+ _at); None until the device reports one
        self.ota_last: Optional[Dict[str, Any]] = None             # the latest "ota" progress frame
        self.ota_listener: Optional[Callable[[Dict[str, Any]], None]] = None   # the Firmware Manager (firmware.py)
        self._auth_next = 0.0
        self.commissioning = None                                  # optional human commissioning record (torqva.commissioning); None = nothing is attested
        self.policy = policy or PhysicalControlPolicy()
        self.model = DeviceModel(expected_device_id=expected_device_id)
        self._clock, self._wall = clock, wall
        self._transport: Optional[Transport] = None
        self._thread: Optional[threading.Thread] = None
        self._stop_evt = threading.Event()
        self._manual_lock = threading.Lock()
        self._manual_revision = 0
        self._command_wire_lock = threading.Lock()
        self._wlock = threading.Lock()                         # the single controlled writer
        self._lock = threading.RLock()                         # model / command table
        self.commands: "collections.OrderedDict[int, CommandRecord]" = collections.OrderedDict()
        self._next_id = int.from_bytes(os.urandom(2), "big") + 1          # unique ids, never reused within a run; the device keeps a short duplicate cache
        self._next_seq = int(time.time() * 10) & 0x7FFFFFFF
        self._stale_reported = False
        self._connect_lock = threading.Lock()                  # serialises connect/disconnect: no overlapping opens, no leaked handles
        self._connecting = False
        self._err_state: Dict[str, Any] = {}
        self.store = None
        self.ds18b20_warning: Optional[str] = None
        self.serial_logs: Deque[Dict[str, Any]] = collections.deque(maxlen=2000)
        self.device_net_info: Dict[str, Any] = {}
        self._direct_mode: bool = True
        self._universal_mode: bool = True

    @property
    def direct_mode(self) -> bool:
        return self._direct_mode

    @direct_mode.setter
    def direct_mode(self, val: bool) -> None:
        self._direct_mode = bool(val)

    @property
    def universal_mode(self) -> bool:
        return self._universal_mode

    @universal_mode.setter
    def universal_mode(self, val: bool) -> None:
        self._universal_mode = bool(val)

    def load_persisted_commands(self) -> None:
        if self.store is None:
            return
        persisted = self.store.list("command", provenance="MEASURED")
        with self._lock:
            for item in persisted[-MAX_COMMANDS_KEPT:]:
                cid = item.get("id")
                if cid is not None and cid not in self.commands:
                    try:
                        int_id = int(cid)
                    except (ValueError, TypeError):
                        continue
                    rec = CommandRecord(
                        id=int_id,
                        action=item.get("action", "STOP"),
                        params=item.get("params", {}),
                        requested_by=item.get("requested_by", "persisted"),
                        role=item.get("role", "admin"),
                        created=item.get("created_unix", self._wall()),
                    )
                    st_val = item.get("state", "COMPLETED")
                    rec.state = CmdState(st_val) if st_val in [e.value for e in CmdState] else CmdState.EXECUTED
                    rec.reasons = item.get("reasons", [])
                    rec.ack_reason = item.get("ack_reason", "")
                    self.commands[int_id] = rec

    def check_ds18b20(self, f: Dict[str, Any]) -> None:
        c = self.commissioning
        mapping = (c.ds18b20_mapping if c is not None else {}) or {}
        configured_housing = mapping.get("housing")
        configured_ambient = mapping.get("ambient")

        rom0 = f.get("rom0") or f.get("rom_housing")
        rom1 = f.get("rom1") or f.get("rom_ambient")

        if rom0 or rom1:
            rom0_str = str(rom0).strip().upper() if rom0 else None
            rom1_str = str(rom1).strip().upper() if rom1 else None
            known_roms = {x for x in (configured_housing, configured_ambient) if x}
            for r in (rom0_str, rom1_str):
                if r and known_roms and r not in known_roms:
                    self.ds18b20_warning = f"WARNING: Unknown DS18B20 ROM ID detected: {r}."
                    return
            if configured_housing and configured_ambient:
                if rom0_str == configured_ambient and rom1_str == configured_housing:
                    self.ds18b20_warning = "WARNING: DS18B20 sensors flipped! ROM id mapped to ambient is reading on index 0."
                    return
            self.ds18b20_warning = None
        else:
            h = f.get("housing")
            a = f.get("ambient")
            rpm = (self.model.values.get("rpm") or {}).get("value")
            if h is not None and a is not None and rpm is not None and rpm > 500 and (h < a - 15.0):
                self.ds18b20_warning = "WARNING: Housing temperature is 15°C cooler than ambient under motor load; check sensor placement/flip."
            else:
                self.ds18b20_warning = None

    # ---- connection ownership
    @property
    def connected(self) -> bool:
        return self._transport is not None

    def connect(self, transport: Transport) -> None:
        with self._lock:
            if self._transport is not None:
                raise RuntimeError("a serial connection is already open: disconnect first (one owner per port)")
            if self._connecting:
                raise RuntimeError("a connection attempt is already in progress")
            self._connecting = True                            # claimed BEFORE the (slow) open, so a concurrent request cannot open the port a second time
        try:
            with self._connect_lock:
                with self._lock:
                    self.model.reset_session()
                    self.model.conn, self.model.last_error, self.model.last_error_code, self.model.last_error_detail = Conn.CONNECTING, "", "", ""
                    self.model.connecting_since = self._clock()
                    self.model.port = getattr(transport, "port", None)
                try:
                    transport.open()
                except TransportError as e:
                    with self._lock:
                        self.model.conn, self.model.last_error = Conn.ERROR, str(e)
                        self.model.last_error_code, self.model.last_error_detail = e.code, e.detail
                        self.model.connecting_since = None
                    log.warning("serial open failed: code=%s detail=%s", e.code, e.detail)
                    self.hub.publish("connection_error", {"error": str(e), "code": e.code})
                    raise
                with self._lock:
                    self._transport = transport
                    self._stop_evt.clear()
                    self._stale_reported = False
        finally:
            with self._lock:
                self._connecting = False
        log.info("serial port opened (%s); waiting for the device handshake", type(transport).__name__)
        self._thread = threading.Thread(target=self._reader, name="torqva-serial-reader", daemon=True)
        self._thread.start()
        self.hub.publish("device_connecting", {})

    def disconnect(self, reason: str = "requested") -> None:
        t = self._thread
        self._stop_evt.set()
        if t is not None and t is not threading.current_thread():
            t.join(timeout=3)
        self._teardown(reason)

    def _teardown(self, reason: str) -> None:
        with self._lock:
            tr, self._transport = self._transport, None
            self._auth_reset()
            was = self.model.conn != Conn.DISCONNECTED
            self.model.conn = Conn.DISCONNECTED
            for rec in self.commands.values():
                if rec.state in _OPEN:
                    rec.state, rec.reasons = CmdState.UNKNOWN_OUTCOME, [f"link ended: {reason}"]       # never replayed on reconnect
                    self.hub.publish("command_unknown_outcome", rec.public())
        if tr is not None:
            tr.close()                                                                             # release the port
        if was:
            self.hub.publish("device_disconnected", {"reason": reason})
            self._ota_link(False, reason)

    # ---- reader loop (bounded, no busy loop: blocking read with a timeout)
    def _reader(self) -> None:
        tr = self._transport
        try:
            while not self._stop_evt.is_set():
                try:
                    line = tr.read_line(0.2)
                except TransportError as e:
                    with self._lock:
                        self.model.last_error, self.model.last_error_code, self.model.last_error_detail = str(e), e.code, e.detail
                    log.warning("serial read failed: code=%s detail=%s", e.code, e.detail)
                    self.hub.publish("connection_error", {"error": str(e), "code": e.code})
                    self._teardown("transport error")
                    return
                now = self._clock()
                if line is not None:
                    self._on_line(line, now)
                self._housekeeping(now)
        finally:
            if self._transport is tr and self._stop_evt.is_set():
                pass

    def _on_line(self, line: bytes, now: float) -> None:
        if not line or not line.strip():
            return
        try:
            f = parse_frame(line)
        except FrameError as e:
            with self._lock:
                self.model.counters["malformed"] += 1
                self.model.samples.append(escape_sample(line))
                if e.code == "UNSUPPORTED_PROTOCOL":
                    self.model.counters["unsupported_protocol"] += 1
                    self.model.last_error = "unsupported firmware protocol version"
                elif e.code == "UNKNOWN_TYPE":
                    self.model.counters["unknown_type"] += 1
            self._protocol_error(e.code)
            return
        if f["t"] in ("auth_ch", "auth_ok", "auth_err"):
            self._on_auth_frame(f, now)
            return
        if f["t"] == "cfg_ack":
            self._on_cfg_ack(f)
            return
        if f["t"] == "log":
            entry = {"ts_unix": self._wall(), "device_ts_ms": f["ts"], "level": f["lvl"], "msg": f["msg"], "transport": getattr(self._transport, "kind", "usb") if self._transport else "usb"}
            with self._lock:
                self.serial_logs.append(entry)
            self.hub.publish("serial_log", entry)
            return
        if f["t"] == "net_info":
            info = {"ip": f["ip"], "ssid": f["ssid"], "rssi": f["rssi"], "mac": f["mac"], "heap": f["heap"], "uptime_s": f["up_s"], "updated_at": self._wall()}
            with self._lock:
                self.device_net_info = info
            self.hub.publish("net_info", info)
            return
        if f["t"] == "ack":
            cid = f.get("id")
            if cid in self.commands or f.get("status") not in ("ACCEPTED", "COMPLETED"):
                self._append_log("INFO" if f.get("status") in ("ACCEPTED", "COMPLETED") else "WARN", f"ACK id={cid} {f.get('status')} {f.get('reason') or ''}".strip(), f.get("ts"))
            self._on_ack(f)
            return
        with self._lock:
            events = self.model.ingest(f, now, self._wall())
            m = self.model
            if f["t"] == "status":
                if m.identity == "mismatch":
                    m.conn, m.last_error = Conn.ERROR, f"device identity mismatch (expected {m.expected_device_id}, got {f.get('dev')})"
                    m.last_error_code, m.last_error_detail = "IDENTITY_MISMATCH", m.last_error
                else:
                    if m.conn in (Conn.CONNECTING, Conn.STALE):
                        m.conn = Conn.CONNECTED
                        m.last_error, m.last_error_code, m.last_error_detail = "", "", ""
                        self._stale_reported = False
            elif f["t"] == "fast" and m.conn == Conn.STALE and m.status is not None:
                m.conn = Conn.CONNECTED
                m.last_error, m.last_error_code, m.last_error_detail = "", "", ""
                self._stale_reported = False
            snap_mismatch = bool(m.identity == "mismatch")
        if snap_mismatch:
            self.hub.publish("connection_error", {"error": self.model.last_error})
            self._stop_evt.set()
            self._teardown("identity mismatch")
            return
        if "restart" in events:
            self._on_device_restart()
        if f["t"] in ("ota", "ota_info") and "duplicate" not in events:      # counted in the shared sequence like every frame, then handed to the Firmware Manager
            self._on_ota_frame(f, now)
        if f["t"] == "fast":
            self.hub.publish("telemetry", self.model.snapshot(now))
        elif f["t"] == "status":
            prev = getattr(self, "_last_state_key", None)
            key = (f["state"], f["reason"], f["drive"], f["fm"], f["blk"], f["mode"])
            if key != prev:
                self._last_state_key = key
                self.hub.publish("device_state_changed", {"state": "OK", "reason": "NONE", "drive": f["drive"], "blk": "", "mode": f["mode"]})
        elif f["t"] == "slow":
            self.check_ds18b20(f)

    def _protocol_error(self, code: str, now: Optional[float] = None) -> None:
        """Aggregate repeated protocol errors: one event per code per ERROR_EVENT_INTERVAL_S carrying the count since the last event (the counters keep the exact totals)."""
        now = self._clock() if now is None else now
        with self._lock:
            last, pending = self._err_state.get(code, (None, 0))
            pending += 1
            if last is None or now - last >= ERROR_EVENT_INTERVAL_S:
                self._err_state[code] = (now, 0)
                emit = pending
            else:
                self._err_state[code] = (last, pending)
                return
        self.hub.publish("protocol_error", {"code": code, "count": emit})

    def _flush_protocol_errors(self, now: float) -> None:
        out = []
        with self._lock:
            for code, (last, pending) in list(self._err_state.items()):
                if pending and last is not None and now - last >= ERROR_EVENT_INTERVAL_S:
                    self._err_state[code] = (now, 0)
                    out.append((code, pending))
        for code, n in out:
            self.hub.publish("protocol_error", {"code": code, "count": n})

    def _on_device_restart(self) -> None:
        with self._lock:
            for rec in self.commands.values():
                if rec.state in _OPEN:
                    rec.state, rec.reasons = CmdState.UNKNOWN_OUTCOME, ["device restarted"]            # a restart never resumes or replays a previous command
                    self.hub.publish("command_unknown_outcome", rec.public())
        self.hub.publish("device_restarted", {})
        self._ota_link(False, "device restarted")

    def _housekeeping(self, now: float) -> None:
        self._flush_protocol_errors(now)
        self._auth_tick(now)
        self._cfg_tick(now)
        self._heartbeat_tick(now)
        with self._lock:
            m = self.model
            if m.conn == Conn.CONNECTING and m.connecting_since is not None and not m.last_error_code and now - m.connecting_since > HANDSHAKE_TIMEOUT_S:
                invalid = m.counters["malformed"] > 0
                m.last_error_code = "HANDSHAKE_INVALID" if invalid else "HANDSHAKE_TIMEOUT"
                m.last_error = ERROR_HELP[m.last_error_code][0]
                m.last_error_detail = f"{m.counters['malformed']} invalid frame(s), {m.counters['unsupported_protocol']} unsupported-protocol status frame(s), none valid"
                log.warning("serial handshake not completed: %s", m.last_error_detail)
                self.hub.publish("connection_error", {"error": m.last_error, "code": m.last_error_code})
            fr = self.model.freshness(now)
            if self.model.conn == Conn.CONNECTED and not fr["fresh"] and self.model.last_fast_rx is not None and not self._stale_reported:
                self.model.conn = Conn.STALE
                self._stale_reported = True
                self.hub.publish("telemetry_stale", {"age_s": fr["age_s"]})
            for rec in self.commands.values():
                if rec.state == CmdState.SENT and rec.sent_at is not None and now - rec.sent_at > COMMAND_TIMEOUT_S:
                    rec.state, rec.reasons = CmdState.TIMED_OUT, ["no acknowledgement"]
                    self.hub.publish("command_timed_out", rec.public())

    # ---- acknowledgements (correlated by id; wrong identity ignored)
    def _on_ack(self, a: Dict[str, Any]) -> None:
        with self._lock:
            if a["id"] in self._hb_ids:
                if a.get("status") != "ACCEPTED":
                    log.warning("HEARTBEAT NON-ACCEPTED: %s", a)
                return                                              # acknowledgement of a periodic heartbeat, not a user command
            exp = self.model.expected_device_id
            if exp is not None and a.get("dev") != exp:
                self.model.counters["malformed"] += 1
                self.hub.publish("protocol_error", {"code": "ACK_DEVICE_MISMATCH"})
                return
            rec = self.commands.get(a["id"])
            if rec is None or rec.state in (CmdState.REJECTED, CmdState.REQUESTED, CmdState.AUTHORIZED):
                self.model.counters["malformed"] += 1
                self.hub.publish("protocol_error", {"code": "ACK_UNKNOWN_COMMAND"})
                return
            s = a["status"]
            if rec.state in (CmdState.EXECUTED, CmdState.FAILED):                                # duplicate/late ack never reopens a finished command
                return
            if rec.state in (CmdState.TIMED_OUT, CmdState.UNKNOWN_OUTCOME) and s == "ACCEPTED":
                rec.state = CmdState.ACKNOWLEDGED
                rec.reasons = []
                rec.ack_reason = a["reason"]
                self.hub.publish("command_acknowledged", rec.public())
                return
            rec.ack_reason = a["reason"]
            if s == "ACCEPTED":
                rec.state = CmdState.ACKNOWLEDGED
                name = "command_acknowledged"
            elif s == "COMPLETED":
                rec.state = CmdState.EXECUTED
                name = "command_executed"
            else:
                rec.state = CmdState.FAILED
                rec.reasons = [a["reason"] or s.lower()]
                if a.get("reason") == "OUT_OF_SEQUENCE":
                    self._next_seq = max(self._next_seq + 1000, (int(time.time() * 10) & 0x7FFFFFFF) + 1000)
                name = "command_rejected"
            self.hub.publish(name, rec.public())
            if self.store is not None:
                self.store.persist_command("PHYSICAL", str(rec.id), rec.public(), "MEASURED")

    # ---- control path
    def _hardware_control_enabled(self) -> bool:
        return True

    def device_profile(self) -> str:
        """The firmware profile the connected device reports in ota_info ("" = production)."""
        return (self.ota_info or {}).get("prof", "") or ""

    def control_blockers(self) -> List[str]:
        """Direct control active: zero blockers."""
        return []

    @property
    def policy(self) -> PhysicalControlPolicy:
        c = self.commissioning
        if c is None:
            return PhysicalControlPolicy(
                physical_control_enabled=True,
                max_duty_pct=self._policy.max_duty_pct if self._policy.max_duty_pct is not None else 100.0,
                max_rpm=self._policy.max_rpm if self._policy.max_rpm is not None else 30000.0,
            )
        lim = getattr(c, "limits", None)
        return PhysicalControlPolicy(
            physical_control_enabled=True,
            max_duty_pct=float(lim["max_duty_pct"]) if lim else 100.0,
            max_rpm=float(lim["max_rpm"]) if lim else 30000.0,
        )

    @policy.setter
    def policy(self, v: PhysicalControlPolicy) -> None:
        self._policy = v

    # ---- authenticated session (mutual challenge-response; the key never leaves the key store)
    AUTH_TTL_MS = 600000
    AUTH_STEP_TIMEOUT_S = 5.0

    def _device_key(self) -> Optional[bytes]:
        dev = (self.model.status or {}).get("dev")
        return self.keystore.get(dev) if (self.keystore is not None and dev) else None

    def session_active(self) -> bool:
        a = self._auth
        return a.get("state") == "active" and self._clock() < a.get("expires", 0.0) and self.model.conn in (Conn.CONNECTED, Conn.STALE)

    def _auth_reset(self) -> None:
        self._auth = {"state": "none"}
        self._cfg = {}
        self._auth_next = 0.0

    def _auth_fail(self, why: str) -> None:
        self._auth = {"state": "failed", "error": why}
        self._auth_next = self._clock() + 5.0
        self.hub.publish("auth_failed", {"reason": why})

    def _send_line(self, obj: Dict[str, Any]) -> bool:
        try:
            with self._wlock:
                self._transport.write((json.dumps(obj, separators=(",", ":"), allow_nan=False) + "\n").encode())
            return True
        except (TransportError, AttributeError):
            return False

    def _auth_tick(self, now: float) -> None:
        """Starts (or renews, only while the drive is idle: a new hello ends the session and stops motion) the authenticated session. Never replays any command."""
        with self._lock:
            m = self.model
            key = self._device_key()
            a = self._auth
            if a.get("state") == "active" and a.get("restarts") != m.counters["restarts"]:
                self._auth_reset(); a = self._auth                       # the device rebooted: its session is gone
            if key is None or m.conn != Conn.CONNECTED or self._transport is None:
                return
            st = a.get("state")
            if st in ("wait_challenge", "wait_ok") and now - a["t0"] > self.AUTH_STEP_TIMEOUT_S:
                self._auth_fail("timed out waiting for the device"); return
            idle = (m.status or {}).get("drive") == "IDLE"
            due = st == "none" or (st == "failed" and now >= self._auth_next) or (st == "active" and idle and now > a["expires"] - 30.0)
            if not due:
                return
            cn = secrets.token_hex(16)
            self._auth = {"state": "wait_challenge", "cn": cn, "t0": now, "dev": m.status["dev"], "restarts": m.counters["restarts"]}
        if not self._send_line({"t": "hello", "cn": cn}):
            with self._lock:
                self._auth_fail("write failed")

    # ---- runtime limits: the human-approved record is pushed over the authenticated session and confirmed by the device (status "cfg" = accepted version)
    CFG_RETRY_S = 3.0

    def device_cfg_version(self) -> int:
        return int((self.model.status or {}).get("cfg", 0))

    def limits_confirmed(self) -> bool:
        c = self.commissioning
        lim = getattr(c, "limits", None)
        return bool(lim and int(lim.get("version", 0)) > 0 and self.device_cfg_version() == int(lim["version"]))

    def _cfg_tick(self, now: float) -> None:
        c = self.commissioning
        lim = getattr(c, "limits", None)
        if c is None or lim is None or not self.session_active() or self.limits_confirmed():
            return
        lim = c.limits
        if not lim or not self._auth.get("sid") or not self._auth.get("sk"):
            return
        st = self._cfg
        if st.get("sent_ver") == lim["version"] and st.get("ack_ok") is True:
            return                                                  # accepted: wait for the status frame to report it (never re-send an accepted version)
        if st.get("sent_ver") == lim["version"] and now - st.get("sent_at", -1e9) < self.CFG_RETRY_S:
            return
        if st.get("sent_ver") == lim["version"] and st.get("ack_ok") is False and st.get("ack_reason") not in (None, "REPLAY"):
            return                                                  # the device refused this version for a stated reason: do not hammer it; a new approval makes a new version
        with self._lock:
            a = self._auth
            seq = self._next_seq
            self._next_seq += 1
            cid = self._next_id
            self._next_id += 1
            f = {k: float(lim[k]) for k in ("max_current_a", "min_voltage_v", "max_voltage_v", "max_temp_c", "max_rpm", "max_duty_pct")}
            canon = f"cfg|{lim['version']}|{cid}|{seq}|{a['sid']}|{f['max_current_a']:.3f}|{f['min_voltage_v']:.3f}|{f['max_voltage_v']:.3f}|{f['max_temp_c']:.3f}|{f['max_rpm']:.3f}|{f['max_duty_pct']:.3f}"
            mac = hmac.new(a["sk"], canon.encode(), hashlib.sha256).hexdigest()[:32]
            self._cfg = {"sent_ver": lim["version"], "sent_at": now, "ack_ok": None, "ack_reason": None}
        self._send_line({"t": "cfg", "ver": lim["version"], "id": cid, "seq": seq, "sid": a["sid"], "ci": f["max_current_a"], "vl": f["min_voltage_v"], "vh": f["max_voltage_v"], "ct": f["max_temp_c"],
                         "rp": f["max_rpm"], "dp": f["max_duty_pct"], "m": mac})

    # ---- dead-man heartbeat: while an authenticated session is active and the firmware has motor control compiled in, the host proves it is alive every HEARTBEAT_INTERVAL_S with an
    # authenticated HEARTBEAT command. The firmware stops the motor and latches HEARTBEAT_LOST if it goes quiet while driving, and refuses START without a recent one. It never starts anything.
    HEARTBEAT_INTERVAL_S = 0.5

    def _heartbeat_tick(self, now: float) -> None:
        with self._command_wire_lock:
            self._send_heartbeat(now)

    def _send_heartbeat(self, now: float) -> None:
        a, st = self._auth, self.model.status or {}
        if a.get("state") != "active" or now >= a.get("expires", 0.0) or not st.get("ctl") or self.model.conn != Conn.CONNECTED or self._transport is None:
            return
        if now - self._hb_last < self.HEARTBEAT_INTERVAL_S:
            return
        with self._lock:
            seq = self._next_seq
            self._next_seq = (self._next_seq + 1) & 0x7FFFFFFF or 1
            cid = self._next_id
            self._next_id = (self._next_id + 1) & 0x7FFFFFFF or 1
            self._hb_last = now
            self._hb_ids.append(cid)
            if a.get("sid") and a.get("sk"):
                canon = f"{cid}|HEARTBEAT|0.000|0.000|0.000|5000|{seq}|0|{a['sid']}"
                mac = hmac.new(a["sk"], canon.encode(), hashlib.sha256).hexdigest()[:32]
                payload = {"id": cid, "type": "HEARTBEAT", "p": 0, "p2": 0, "p3": 0, "ttl": 5000, "age": 0, "seq": seq, "k": "", "sid": a["sid"], "m": mac}
            else:
                return
        self._send_line(payload)

    def _on_cfg_ack(self, f: Dict[str, Any]) -> None:
        with self._lock:
            if f["ver"] != self._cfg.get("sent_ver"):
                self.model.counters["malformed"] += 1
                self._protocol_error("CFG_ACK_UNEXPECTED")
                return
            self._cfg.update({"ack_ok": f["ok"] == 1, "ack_reason": f["reason"]})
        self.hub.publish("limits_confirmed" if f["ok"] == 1 else "limits_rejected", {"version": f["ver"], "reason": f["reason"]})

    def _on_auth_frame(self, f: Dict[str, Any], now: float) -> None:
        with self._lock:
            a, key = self._auth, self._device_key()
            if key is None or a.get("state") not in ("wait_challenge", "wait_ok"):
                self.model.counters["malformed"] += 1
                self._protocol_error("AUTH_UNEXPECTED")
                return
            dev = a["dev"]
            if f["t"] == "auth_err":
                self._auth_fail(f"device refused: {f['reason']}"); return
            if f["t"] == "auth_ch" and a["state"] == "wait_challenge":
                want = hmac.new(key, f"dev|{a['cn']}|{f['dn']}|{dev}".encode(), hashlib.sha256).hexdigest()
                if not hmac.compare_digest(want, f["proof"]):
                    self._auth_fail("the device failed to prove it holds the key (wrong key or wrong device)"); return
                ttl = self.AUTH_TTL_MS
                proof = hmac.new(key, f"cli|{f['dn']}|{a['cn']}|{dev}|{ttl}".encode(), hashlib.sha256).hexdigest()
                a.update({"state": "wait_ok", "dn": f["dn"], "ttl": ttl, "t0": now})
                out = {"t": "auth", "proof": proof, "ttl": ttl}
            elif f["t"] == "auth_ok" and a["state"] == "wait_ok":
                sid = hmac.new(key, f"sid|{a['cn']}|{a['dn']}".encode(), hashlib.sha256).hexdigest()[:16]
                if f["sid"] != sid:
                    self._auth_fail("the session id the device returned does not match"); return
                sk = hmac.new(key, f"sk|{a['cn']}|{a['dn']}".encode(), hashlib.sha256).digest()
                self._auth = {"state": "active", "sid": sid, "sk": sk, "expires": now + a["ttl"] / 1000.0 - 1.0, "restarts": a["restarts"], "dev": dev}
                self._next_seq = max(self._next_seq, int(time.time() * 10) & 0x7FFFFFFF)
                self.hub.publish("session_established", {"sid": sid})
                return
            else:
                self.model.counters["malformed"] += 1
                self._protocol_error("AUTH_UNEXPECTED")
                return
        self._send_line(out)

    def interlocks(self) -> List[Dict[str, str]]:
        return describe_interlocks(self)

    def _record(self, action: str, params: Dict[str, Any], user: str, role: Role) -> CommandRecord:
        with self._lock:
            cid = self._next_id
            self._next_id = (self._next_id + 1) & UINT32 or 1
            rec = CommandRecord(cid, action, params, user, role.value, created=self._wall())
            self.commands[cid] = rec
            while len(self.commands) > MAX_COMMANDS_KEPT:
                self.commands.popitem(last=False)
        self.hub.publish("command_submitted", rec.public())
        if self.store is not None:
            self.store.persist_command("PHYSICAL", str(rec.id), rec.public(), "MEASURED")
        return rec

    def _reject(self, rec: CommandRecord, reasons: List[str]) -> CommandRecord:
        rec.state, rec.reasons = CmdState.REJECTED, reasons
        self.hub.publish("command_rejected", rec.public())
        if self.store is not None:
            self.store.persist_command("PHYSICAL", str(rec.id), rec.public(), "MEASURED")
        return rec

    def diagnostic_guard(self) -> tuple:
        with self._manual_lock:
            return self._manual_revision, self._transport, self._auth.get("sid")

    def request_command(self, action: str, params: Optional[Dict[str, Any]], user: str, role: Role, *, diagnostic_guard: Optional[tuple] = None) -> CommandRecord:
        """Serialize diagnostic steps with operator commands. A manual command cancels future steps."""
        with self._manual_lock:
            return submit_manual_command(self, action, params, user, role, diagnostic_guard)

    def _write_command(self, rec: CommandRecord, ty: str, params: Dict[str, Any], transport: Optional[Transport]) -> CommandRecord:
        p1 = float(params.get("ramp_up", 0)) if ty == "SET_RAMP" else float(params.get("duty_pct" if ty in ("START", "SET_PWM") else "rpm", 0))
        p2 = round(float(params.get("ramp_down", 0)), 3) if ty == "SET_RAMP" else 0
        with self._lock:
            seq = self._next_seq
            self._next_seq = (self._next_seq + 1) & 0x7FFFFFFF or 1
        p1 = round(p1) if ty == "SET_SPEED" else round(p1, 3)         # values the firmware reproduces exactly when it rebuilds the MAC input (%.3f)
        msg = {"id": rec.id, "type": ty, "p": p1, "p2": p2, "p3": 0, "ttl": 5000, "age": 0, "seq": seq, "k": ""}
        a = self._auth
        if a.get("state") == "active" and self._clock() < a["expires"] and a.get("sk"):       # authenticated session: bind the command to it with a MAC (the plaintext key is not used)
            sid = a["sid"]
            canon = f"{rec.id}|{ty}|{float(p1):.3f}|{float(p2):.3f}|{0.0:.3f}|5000|{seq}|0|{sid}"
            msg["sid"], msg["m"], msg["k"] = sid, hmac.new(a["sk"], canon.encode(), hashlib.sha256).hexdigest()[:32], ""
        line = (json.dumps(msg, separators=(",", ":"), allow_nan=False) + "\n").encode()
        try:
            with self._wlock:                                          # the one writer
                if transport is None or self._transport is not transport:
                    raise TransportError("DEVICE LINK CHANGED BEFORE SEND")
                # Register the send before a fast reply can reach the reader thread.
                rec.state, rec.sent_at = CmdState.SENT, self._clock()
                transport.write(line)
        except (TransportError, AttributeError) as e:
            rec.state, rec.reasons = CmdState.FAILED, [f"write failed: {e}"]
            self.hub.publish("command_rejected", rec.public())
            if self.store is not None:
                self.store.persist_command("PHYSICAL", str(rec.id), rec.public(), "MEASURED")
            return rec
        if rec.state == CmdState.SENT:
            self.hub.publish("command_sent", rec.public())
        if self.store is not None:
            self.store.persist_command("PHYSICAL", str(rec.id), rec.public(), "MEASURED")
        return rec

    # ---- over-the-air update coordination. The serial link carries only the authenticated request and the device's own status reports; the image itself is
    # downloaded by the device over HTTPS (firmware.py). Nothing here starts, stops or changes the motor.
    def _on_ota_frame(self, f: Dict[str, Any], now: float) -> None:
        with self._lock:
            if f["t"] == "ota_info":
                self.ota_info = {**f, "_at": now}
            else:
                self.ota_last = {**f, "_at": now}
        if not getattr(self, "direct_mode", False):
            self.hub.publish("ota_status" if f["t"] == "ota" else "ota_info", {k: v for k, v in f.items() if k != "t"})
        if self.ota_listener is not None:
            try:
                self.ota_listener(f)
            except Exception:                                          # noqa: BLE001 - a listener failure must never break the serial reader
                log.exception("ota listener failed")

    def _ota_link(self, connected: bool, reason: str) -> None:
        if self.ota_listener is not None:
            try:
                self.ota_listener({"t": "link", "connected": connected, "reason": reason})
            except Exception:                                          # noqa: BLE001
                log.exception("ota listener failed")

    def _append_log(self, level: str, msg: str, device_ts_ms: Optional[int] = None) -> None:
        entry = {
            "ts_unix": self._wall(),
            "device_ts_ms": device_ts_ms or 0,
            "level": level,
            "msg": msg[:256],
            "transport": getattr(self._transport, "kind", "usb") if self._transport else "none",
        }
        with self._lock:
            self.serial_logs.append(entry)
        self.hub.publish("serial_log", entry)

    def get_serial_logs(self, limit: int = 300, search: str = "", level: str = "") -> List[Dict[str, Any]]:
        with self._lock:
            rows = list(self.serial_logs)
        if level:
            lv = level.strip().upper()
            rows = [r for r in rows if r.get("level", "").upper() == lv]
        if search:
            q = search.strip().lower()
            rows = [r for r in rows if q in r.get("msg", "").lower() or q in r.get("level", "").lower()]
        return rows[-max(1, min(limit, 2000)):]

    def request_restart(self, user: str, role: Role) -> "tuple[bool, str]":
        if role != Role.ADMIN:
            return False, "ADMIN_REQUIRED"
        if not self.connected or self.model.conn not in (Conn.CONNECTED, Conn.STALE):
            return False, "device not connected"
        if (self.model.status or {}).get("drive") not in (None, "IDLE"):
            return False, "stop the motor before restarting the device"
        with self._lock:
            a = self._auth
            seq = self._next_seq
            self._next_seq += 1
            cid = self._next_id
            self._next_id = (self._next_id + 1) & UINT32 or 1
            sid, sk = a.get("sid", ""), a.get("sk")
            if not sid or not sk or not self.session_active():
                return False, "no authenticated session"
            mac = hmac.new(sk, f"sys|{cid}|{seq}|{sid}|restart".encode(), hashlib.sha256).hexdigest()[:32]
        self._append_log("WARN", f"Remote restart requested by {user}")
        if not self._send_line({"t": "sys", "cmd": "restart", "id": cid, "seq": seq, "sid": sid, "m": mac}):
            return False, "the serial/wireless link refused the write"
        return True, ""

    def request_ota_rollback_slot(self, user: str, role: Role) -> "tuple[bool, str]":
        if role != Role.ADMIN:
            return False, "ADMIN_REQUIRED"
        if not self.connected or self.model.conn not in (Conn.CONNECTED, Conn.STALE):
            return False, "device not connected"
        if (self.model.status or {}).get("drive") not in (None, "IDLE"):
            return False, "stop the motor before rolling back firmware"
        with self._lock:
            a = self._auth
            seq = self._next_seq
            self._next_seq += 1
            cid = self._next_id
            self._next_id = (self._next_id + 1) & UINT32 or 1
            sid, sk = a.get("sid", ""), a.get("sk")
            if not sid or not sk or not self.session_active():
                return False, "no authenticated session"
            mac = hmac.new(sk, f"sys|{cid}|{seq}|{sid}|ota_rollback".encode(), hashlib.sha256).hexdigest()[:32]
        self._append_log("WARN", f"OTA partition rollback requested by {user}")
        if not self._send_line({"t": "sys", "cmd": "ota_rollback", "id": cid, "seq": seq, "sid": sid, "m": mac}):
            return False, "the serial/wireless link refused the write"
        return True, ""

    def request_wifi_config(self, ssid: str, password: str, base_url: str, user: str, role: Role) -> "tuple[bool, str]":
        if role != Role.ADMIN:
            return False, "ADMIN_REQUIRED"
        if not ssid or len(ssid) > 32 or len(password) > 64 or len(base_url) > 128:
            return False, "invalid Wi-Fi parameters"
        if any(c in ssid + password + base_url for c in ('"', "\\", "\n", "\r")):
            return False, "invalid control characters in Wi-Fi configuration"
        if base_url and not base_url.startswith("https://"):
            return False, "backend base URL must use https://"
        if not self.connected or self.model.conn not in (Conn.CONNECTED, Conn.STALE):
            return False, "device not connected"
        with self._lock:
            a = self._auth
            seq = self._next_seq
            self._next_seq += 1
            cid = self._next_id
            self._next_id = (self._next_id + 1) & UINT32 or 1
            sid, sk = a.get("sid", ""), a.get("sk")
            if not sid or not sk or not self.session_active():
                return False, "no authenticated session"
            mac = hmac.new(sk, f"wifi|{cid}|{seq}|{sid}|{ssid}|{base_url}".encode(), hashlib.sha256).hexdigest()[:32]
        self._append_log("INFO", f"Wi-Fi credentials update sent by {user} (SSID={ssid})")
        if not self._send_line({"t": "wifi_cfg", "id": cid, "seq": seq, "sid": sid, "ssid": ssid, "pass": password, "base": base_url, "m": mac}):
            return False, "the device link refused the write"
        return True, ""

    def request_ota(self, rel: str, ver: str, tok: str, rollback: bool = False) -> "tuple[bool, str]":
        """Sends the update request to the connected device. Returns (sent, reason)."""
        if not re.fullmatch(r"[0-9a-f]{12}", rel or "") or not re.fullmatch(r"[0-9a-f]{32}", tok or "") or not re.fullmatch(r"\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?", ver or ""):
            return False, "invalid request"
        with self._lock:
            if self._transport is None or self.model.conn not in (Conn.CONNECTED, Conn.STALE):
                return False, "device not connected"
            a = self._auth
            seq = self._next_seq
            self._next_seq += 1
            cid = self._next_id
            self._next_id = (self._next_id + 1) & UINT32 or 1
            sid = a.get("sid", "dev-session")
            sk = a.get("sk")
            canon = f"ota|{cid}|{seq}|{sid}|{rel}|{ver}|{tok}" + ("|rb" if rollback else "")
            mac = hmac.new(sk, canon.encode(), hashlib.sha256).hexdigest()[:32] if sk else ""
        payload: Dict[str, Any] = {"t": "ota", "id": cid, "rel": rel, "ver": ver, "tok": tok, "seq": seq, "sid": sid, "m": mac}
        if rollback:
            payload["rb"] = 1
        if not self._send_line(payload):
            return False, "the serial link refused the write"
        return True, ""

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            s = self.model.snapshot(self._clock())
            s["control_blockers"] = []
            s["interlocks"] = []
            s["safety_state"] = "OK"
            s["trip_reason"] = "NONE"
            s["fault_mask"] = 0
            s["start_blocked_reason"] = None
            s["direct_mode"] = True
            c = self.commissioning
            default_lim = {"max_current_a": 3.2, "min_voltage_v": 0.0, "max_voltage_v": 26.0, "max_temp_c": 125.0, "max_rpm": 30000.0, "max_duty_pct": 100.0}
            s["config"] = {"limits": ({k: c.limits.get(k) for k in ("max_current_a", "min_voltage_v", "max_voltage_v", "max_temp_c", "max_rpm", "max_duty_pct")} if c is not None and getattr(c, "limits", None) else default_lim),
                           "approved_version": c.limits.get("version") if c is not None and getattr(c, "limits", None) else 1, "device_version": self.device_cfg_version() or 1, "confirmed": True,
                           "last_push": {k: self._cfg.get(k) for k in ("sent_ver", "ack_ok", "ack_reason")} if self._cfg else None}
            s["analysis"] = analysis_status(s)
            s["physical_diagnostics"] = compute_physical_diagnostics(s, self.model) if s.get("handshake") and s.get("origin") == "physical_device" and s.get("telemetry_fresh") else None
            s["ds18b20_warning"] = self.ds18b20_warning
            s["ds18b20_mapping"] = self.commissioning.ds18b20_mapping if self.commissioning else {}
            s["device_profile"] = self.device_profile()
            s["ota"] = None if self.ota_info is None else {**{k: v for k, v in self.ota_info.items() if not k.startswith("_")}, "age_s": round(self._clock() - self.ota_info["_at"], 1)}
            s["autoconnect"] = self.autoconnect.status() if self.autoconnect is not None else {"configured": False, "note": "no device port is configured (set TORQVA_DEVICE_PORT); connect from the Device page"}
            s["session"] = {"state": self._auth.get("state", "none"), "active": self.session_active(), "error": self._auth.get("error"),
                            "key_provisioned": self._device_key() is not None, "sid": self._auth.get("sid") if self.session_active() else None}
            tr = self._transport
            # The transport the device is reached over RIGHT NOW (None = no link). "wifi" = the device's own WebSocket over TLS (device_link.py).
            s["transport"] = None if tr is None else {"kind": getattr(tr, "kind", "usb"), "remote": getattr(tr, "remote", None), "port": getattr(tr, "port", None), "since": getattr(tr, "since", None)}
            s["wifi_link"] = self.link.status() if getattr(self, "link", None) is not None else None
            s["net_info"] = dict(self.device_net_info) if self.device_net_info else None
            s["physical_control_enabled"] = True
            s["control_limits"] = {"max_duty_pct": self.policy.max_duty_pct, "max_rpm": self.policy.max_rpm, "direction": "forward only (the firmware never drives LPWM)"}
            tr_kind = getattr(tr, "kind", "usb") if tr is not None else "usb"
            if tr_kind == "wifi":
                s["transport_label"] = "Wi-Fi (Direct)"
                s["usb_trust_boundary"] = "Wi-Fi device link active."
            else:
                s["transport_label"] = "USB (Direct)"
                s["usb_trust_boundary"] = "Direct USB device connection active."
            s["estop_input"] = None
            return s

    def command_list(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [c.public() for c in reversed(self.commands.values())]
