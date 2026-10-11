"""USB-serial bridge between the ESP32-S3 firmware and the TORQVA backend. The backend OWNS the serial port (one reader thread, one locked writer); the browser never touches it.

Wire protocol = the firmware's own JSON-lines protocol, version 1 (esp32/torqva_fw/lib/torqva_core/protocol.cpp), 115200 8N1 over USB-CDC (the baud rate is ignored by USB-CDC but is
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
import math
import os
import re
import secrets
import subprocess
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Deque, Dict, List, Optional

from .physical_adapter import analysis_status
from .schemas import ActionType, Connection, DecisionVerdict, DeviceSafetyState, Mode, ProposalSource, ProposedAction, Role
from .supervisor import ApprovedAction, SafetySupervisor, SupervisorContext, SupervisorLimits

log = logging.getLogger("torqva.serial")
MAX_LINE = 512
ERROR_EVENT_INTERVAL_S = 2.0                # repeated protocol errors are aggregated into one event per code per interval
HANDSHAKE_TIMEOUT_S = 5.0                   # port open but no valid status frame for this long -> HANDSHAKE_TIMEOUT diagnostic (no disconnect, no retry loop)
WIRE_PROTOCOL = 1
Q_BITS = {"current": 1, "voltage": 2, "housing": 4, "ambient": 8, "rpm": 16, "vibration": 32}
HISTORY_SAMPLES = 3600                       # 10 Hz -> 6 minutes; bounded memory
STALE_AFTER_S = 2.0                          # no fast frame for this long -> telemetry is stale (never presented as live)
COMMAND_TIMEOUT_S = 6.0
MAX_COMMANDS_KEPT = 200
UINT32 = 2 ** 32 - 1


LEGACY_MARKERS = ("OVERALL CONDITION", "[TCP", "[MOTOR]", "BTS7960", "Smart DC Motor", "BUZZER ")


def escape_sample(raw: bytes, limit: int = 120) -> str:
    """Printable, truncated rendering of a rejected line so an operator can recognise what the device is actually sending. Never parsed, never trusted."""
    return "".join(chr(b) if 32 <= b < 127 else "." for b in bytes(raw)[:limit]) + ("…" if len(raw) > limit else "")


class FrameError(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


# --------------------------------------------------------------------------------------------------------------- parsing and validation
def _const(name):
    raise FrameError("NON_FINITE_NUMBER", name)


def _num(o: Dict[str, Any], k: str, lo: float, hi: float) -> float:
    v = o.get(k)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise FrameError("BAD_FIELD", k)
    if not math.isfinite(v):
        raise FrameError("NON_FINITE_NUMBER", k)
    if not (lo <= v <= hi):
        raise FrameError("OUT_OF_RANGE", k)
    return float(v)


def _uint(o: Dict[str, Any], k: str, hi: int = UINT32) -> int:
    v = o.get(k)
    if isinstance(v, bool) or not isinstance(v, int) or not (0 <= v <= hi):
        raise FrameError("BAD_FIELD", k)
    return v


def _str(o: Dict[str, Any], k: str, maxlen: int = 64, allow_empty: bool = True) -> str:
    v = o.get(k)
    if not isinstance(v, str) or len(v) > maxlen or (not allow_empty and not v):
        raise FrameError("BAD_FIELD", k)
    return v


def _hex(o: Dict[str, Any], k: str, n: int) -> str:
    v = o.get(k)
    if not isinstance(v, str) or len(v) != n or not re.fullmatch(r"[0-9a-f]+", v):
        raise FrameError("BAD_FIELD", k)
    return v


def parse_frame(line: "bytes | str") -> Dict[str, Any]:
    """Validate ONE line from the device. Raises FrameError; never returns a partially valid frame."""
    raw = line if isinstance(line, (bytes, bytearray)) else line.encode("utf-8")
    if len(raw) > MAX_LINE:
        raise FrameError("OVERSIZE")
    try:
        o = json.loads(raw.decode("utf-8"), parse_constant=_const)
    except FrameError:
        raise
    except (UnicodeDecodeError, ValueError):
        raise FrameError("MALFORMED")
    if not isinstance(o, dict):
        raise FrameError("MALFORMED", "not an object")
    t = o.get("t")
    if t == "fast":
        return {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "rpm": _num(o, "rpm", 0, 35000), "sp": _num(o, "sp", 0, 35000), "duty": _num(o, "duty", 0, 100),
                "v": _num(o, "v", -1, 60), "i": _num(o, "i", -50, 50), "p": _num(o, "p", -3000, 3000), "q": _uint(o, "q", 63)}
    if t == "slow":
        return {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "housing": _num(o, "housing", -60, 200), "ambient": _num(o, "ambient", -60, 200), "q": _uint(o, "q", 63)}
    if t == "accel":
        ok = o.get("ok")
        if ok not in (0, 1) or isinstance(ok, bool):
            raise FrameError("BAD_FIELD", "ok")
        base = {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "ok": ok}
        if ok == 1:
            base.update({"ax": _num(o, "ax", -20, 20), "ay": _num(o, "ay", -20, 20), "az": _num(o, "az", -20, 20), "mag": _num(o, "mag", 0, 35)})
        elif any(k in o for k in ("ax", "ay", "az", "mag")):
            raise FrameError("BAD_FIELD", "numbers on an invalid accel frame")      # an invalid reading carries no numbers
        return base
    if t == "status":
        if o.get("proto") != WIRE_PROTOCOL:
            raise FrameError("UNSUPPORTED_PROTOCOL", str(o.get("proto"))[:12])
        st = _str(o, "state", 16, False)
        if st not in ("OK", "WARN", "EMERGENCY_STOP"):
            raise FrameError("BAD_FIELD", "state")
        mode = _str(o, "mode", 8, False)
        if mode not in ("SIM", "HW"):
            raise FrameError("BAD_FIELD", "mode")
        return {"t": t, "seq": _uint(o, "seq"), "ts": _uint(o, "ts"), "fw": _str(o, "fw", 32, False), "wiring": _str(o, "wiring", 32), "limits_v": _uint(o, "limits_v", 65535),
                "state": st, "reason": _str(o, "reason", 32, False), "mode": mode, "drive": _str(o, "drive", 16, False), "ctl": _uint(o, "ctl", 1), "hb_age": _uint(o, "hb_age"),
                "test": _uint(o, "test", 255), "proto": WIRE_PROTOCOL, "dev": _str(o, "dev", 64), "blk": _str(o, "blk", 48), "fm": _uint(o, "fm"),
                "cfg": _uint(o, "cfg", 65535) if "cfg" in o else 0, "es": _uint(o, "es", 3) if "es" in o else 0}
    if t == "ack":
        s = o.get("status")
        if s not in ("ACCEPTED", "REJECTED", "COMPLETED", "ABORTED"):
            raise FrameError("BAD_ACK_STATUS", str(s)[:16])
        out = {"t": t, "id": _uint(o, "id"), "status": s, "reason": _str(o, "reason", 48)}
        if "dev" in o:
            out["dev"] = _str(o, "dev", 64)
        if "sid" in o:
            out["sid"] = _str(o, "sid", 33)
        return out
    if t == "cfg_ack":
        ok = o.get("ok")
        if ok not in (0, 1) or isinstance(ok, bool):
            raise FrameError("BAD_FIELD", "ok")
        return {"t": t, "ver": _uint(o, "ver", 65535), "ok": ok, "reason": _str(o, "reason", 32)}
    if t == "auth_ch":                                           # device challenge response (authenticated session)
        return {"t": t, "dn": _hex(o, "dn", 32), "proof": _hex(o, "proof", 64)}
    if t == "auth_ok":
        return {"t": t, "sid": _hex(o, "sid", 16), "ttl": _uint(o, "ttl", 600000)}
    if t == "auth_err":
        return {"t": t, "reason": _str(o, "reason", 24)}
    raise FrameError("UNKNOWN_TYPE", str(t)[:16])


# --------------------------------------------------------------------------------------------------------------- device model
class Conn(str, Enum):
    DISCONNECTED = "DISCONNECTED"
    CONNECTING = "CONNECTING"            # port open, waiting for a valid status frame (handshake)
    CONNECTED = "CONNECTED"              # valid status frame with protocol 1 seen
    STALE = "STALE"                      # connected but telemetry stopped
    ERROR = "ERROR"


@dataclass
class DeviceModel:
    expected_device_id: Optional[str] = None
    conn: Conn = Conn.DISCONNECTED
    status: Optional[Dict[str, Any]] = None
    identity: str = "unknown"            # verified | unverified | mismatch | unknown
    last_seq: Optional[int] = None
    last_rx: Optional[float] = None      # monotonic time of the last valid frame
    last_fast_rx: Optional[float] = None
    last_rx_wall: Optional[float] = None
    values: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    history: Deque[Dict[str, Any]] = field(default_factory=lambda: collections.deque(maxlen=HISTORY_SAMPLES))
    counters: Dict[str, int] = field(default_factory=lambda: {"frames": 0, "malformed": 0, "duplicates": 0, "gaps": 0, "missing": 0, "restarts": 0, "unknown_type": 0, "unsupported_protocol": 0})
    last_error: str = ""
    last_error_code: str = ""
    last_error_detail: str = ""
    connecting_since: Optional[float] = None
    port: Optional[str] = None
    _rx_wall: Optional[float] = None
    accel: Optional[Dict[str, Any]] = None                                               # latest acceleration frame: raw axes (g) + TOTAL magnitude (gravity included, not vibration)
    accel_history: Deque[Any] = field(default_factory=lambda: collections.deque(maxlen=1800))
    samples: Deque[str] = field(default_factory=lambda: collections.deque(maxlen=5))     # the last few REJECTED lines, escaped and truncated (diagnostic only)

    def reset_session(self) -> None:
        self.status, self.identity, self.last_seq, self.last_rx, self.last_fast_rx, self.last_rx_wall = None, "unknown", None, None, None, None
        self.values = {}
        self.accel = None
        self.samples.clear()

    def _set(self, name: str, value: Optional[float], valid: bool, ts: int, now: float) -> None:
        self.values[name] = {"value": value if valid else None, "valid": valid, "device_ts_ms": ts, "received_at": now, "received_unix": self._rx_wall, "origin": "device_measurement"}

    def ingest(self, f: Dict[str, Any], now: float, wall: float) -> List[str]:
        """Apply one validated frame. Returns event names produced ('restart', 'duplicate', ...). Never substitutes a missing reading with a number."""
        ev: List[str] = []
        if f["t"] == "ack":
            return ev
        seq = f["seq"]
        if self.last_seq is not None:
            diff = (seq - self.last_seq) & UINT32
            if diff == 0:
                self.counters["duplicates"] += 1
                return ["duplicate"]
            if diff > UINT32 // 2:                                   # sequence went backwards: the device restarted (or something replayed)
                self.counters["restarts"] += 1
                ev.append("restart")
            elif diff > 1:
                self.counters["gaps"] += 1
                self.counters["missing"] += diff - 1
                ev.append("gap")
        self.last_seq, self.last_rx, self.last_rx_wall = seq, now, wall
        self._rx_wall = wall
        self.counters["frames"] += 1
        q = f.get("q", 0)
        if f["t"] == "fast":
            self.last_fast_rx = now
            ts = f["ts"]
            self._set("rpm", f["rpm"], bool(q & Q_BITS["rpm"]), ts, now)
            self._set("current", f["i"], bool(q & Q_BITS["current"]), ts, now)
            self._set("voltage", f["v"], bool(q & Q_BITS["voltage"]), ts, now)
            self._set("power", f["p"], bool(q & Q_BITS["current"] and q & Q_BITS["voltage"]), ts, now)     # derived by the firmware: valid only if both inputs are
            self.values["duty"] = {"value": f["duty"], "valid": True, "device_ts_ms": ts, "received_at": now, "origin": "device_command_state"}
            self.values["setpoint"] = {"value": f["sp"], "valid": True, "device_ts_ms": ts, "received_at": now, "origin": "device_command_state"}
            self.history.append({"t": wall, "device_ts_ms": ts, **{k: (self.values[k]["value"]) for k in ("rpm", "current", "voltage", "power", "duty")},
                                 "housing": (self.values.get("housing") or {}).get("value")})
        elif f["t"] == "accel":
            ok = f["ok"] == 1
            self.accel = {"valid": ok, "x_g": f.get("ax") if ok else None, "y_g": f.get("ay") if ok else None, "z_g": f.get("az") if ok else None,
                          "magnitude_g": f.get("mag") if ok else None, "received_at": now, "received_unix": wall, "device_ts_ms": f["ts"]}
            self.accel_history.append((wall, f.get("mag") if ok else None))
        elif f["t"] == "slow":
            self._set("housing", f["housing"], bool(q & Q_BITS["housing"]), f["ts"], now)
            self._set("ambient", f["ambient"], bool(q & Q_BITS["ambient"]), f["ts"], now)
        elif f["t"] == "status":
            self.status = f
            if self.expected_device_id is not None and f["dev"] != self.expected_device_id:
                self.identity = "mismatch"
            elif self.expected_device_id is not None:
                self.identity = "verified"
            else:
                self.identity = "unverified"
            if f["dev"] in ("", "UNPROVISIONED") and self.identity == "verified":
                self.identity = "unverified"
        return ev

    def freshness(self, now: float) -> Dict[str, Any]:
        age = None if self.last_fast_rx is None else now - self.last_fast_rx
        return {"fresh": age is not None and age <= STALE_AFTER_S, "age_s": age}

    def snapshot(self, now: float) -> Dict[str, Any]:
        fr = self.freshness(now)
        vals = {}
        for k in ("rpm", "current", "voltage", "power", "housing", "ambient", "duty", "setpoint"):
            v = self.values.get(k)
            vals[k] = None if v is None else {"value": v["value"], "valid": v["valid"], "stale": not fr["fresh"] if k not in ("housing", "ambient") else (now - v["received_at"] > 5.0), "origin": v["origin"],
                                                  "device_ts_ms": v.get("device_ts_ms"), "received_unix": v.get("received_unix")}
        vals["vibration"] = {"value": None, "valid": False, "stale": False, "origin": "unavailable", "note": "the firmware does not compute vibration RMS"}
        a = self.accel
        vals["acceleration"] = ({"value": None, "valid": False, "stale": False, "origin": "unavailable", "note": "no accelerometer frames received"} if a is None else
                                {"value": a["magnitude_g"], "x_g": a["x_g"], "y_g": a["y_g"], "z_g": a["z_g"], "valid": a["valid"], "stale": now - a["received_at"] > 2.0, "device_ts_ms": a["device_ts_ms"], "received_unix": a.get("received_unix"),
                                 "origin": "device_measurement", "note": "total acceleration magnitude INCLUDING gravity (about 1 g at rest); raw per-axis values in g; NOT vibration RMS"})
        UNITS = {"rpm": "rpm", "current": "A", "voltage": "V", "power": "W", "housing": "°C", "ambient": "°C", "duty": "%", "setpoint": "rpm", "acceleration": "g", "vibration": ""}
        st = self.status or {}
        for k, v in vals.items():                                       # every reading: unit, device identity, acquisition (device ms) and receipt (unix) time, source
            if v is not None and v.get("origin") != "unavailable":
                v.setdefault("unit", UNITS.get(k, ""))
                v.setdefault("device_id", st.get("dev"))
                v.setdefault("source", v.get("origin"))
        mode = st.get("mode")
        handshake = self.conn in (Conn.CONNECTED, Conn.STALE) and self.status is not None
        physical = bool(handshake and mode == "HW" and self.identity != "mismatch")
        return {"connection": self.conn.value, "handshake": handshake, "identity": self.identity, "device_id": st.get("dev"),
                "origin": "physical_device" if physical else ("device_firmware_simulation" if handshake else "none"),
                "label": "PHYSICAL DEVICE" if physical else ("DEVICE (FIRMWARE SIMULATION MODE)" if handshake else "SIMULATION"),
                "firmware": st.get("fw"), "wire_protocol": st.get("proto"), "firmware_mode": mode, "safety_state": st.get("state"), "trip_reason": st.get("reason"), "fault_mask": st.get("fm"),
                "drive": st.get("drive"), "control_enabled_in_firmware": None if not st else bool(st.get("ctl")), "start_blocked_reason": st.get("blk"),
                "telemetry_fresh": fr["fresh"], "telemetry_age_s": fr["age_s"], "last_rx_unix": self.last_rx_wall, "values": vals, "counters": dict(self.counters), "last_error": self.last_error, "error": self.error_info(),
                "port": self.port, "state_label": self.state_label(handshake, physical), "sensor_status": self.sensor_status(now)}

    ESTOP_LABELS = {0: "NOT MONITORED", 1: "ASSERTED (pressed, open circuit or broken wire)", 2: "RELEASED (circuit healthy)", 3: "UNKNOWN (not yet read)"}

    def state_label(self, handshake: bool, physical: bool) -> str:
        c = self.conn
        if c == Conn.DISCONNECTED:
            return "DISCONNECTED"
        if c == Conn.ERROR:
            return "CONNECTION ERROR"
        if c == Conn.STALE:
            return "TELEMETRY STALE"
        if c == Conn.CONNECTING:
            if self.last_error_code == "HANDSHAKE_INVALID":
                return "HANDSHAKE INVALID"
            return "PORT OPEN - WAITING FOR HANDSHAKE" + (" (receiving non-TORQVA data)" if self.counters["malformed"] and not handshake else "")
        return "PHYSICAL DEVICE CONNECTED" if physical else "DEVICE CONNECTED (FIRMWARE SIMULATION MODE)"

    def sensor_status(self, now: float) -> Dict[str, str]:
        """valid | invalid | stale | unavailable per sensor (unavailable = this firmware does not report it, or no frame yet)."""
        out: Dict[str, str] = {}
        for k in ("rpm", "current", "voltage", "power", "housing", "ambient"):
            v = self.values.get(k)
            old = v is not None and now - v["received_at"] > (5.0 if k in ("housing", "ambient") else STALE_AFTER_S)
            out[k] = "unavailable" if v is None else ("stale" if old else ("valid" if v["valid"] else "invalid"))
        a = self.accel
        out["acceleration"] = "unavailable" if a is None else ("stale" if now - a["received_at"] > 2.0 else ("valid" if a["valid"] else "invalid"))
        out["vibration_rms"] = "unavailable"
        return out

    def error_info(self) -> Optional[Dict[str, Any]]:
        if not self.last_error_code:
            return None
        summary, steps = ERROR_HELP.get(self.last_error_code, (self.last_error, []))
        steps = list(steps)
        if self.last_error_code in ("HANDSHAKE_INVALID", "HANDSHAKE_TIMEOUT") and any(m in s for s in self.samples for m in LEGACY_MARKERS):
            summary = "The attached board is running the legacy monitoring sketch, not TORQVA firmware."
            steps.insert(0, "Its serial output matches the legacy smart_motor_monitor sketch (human-readable status text). That sketch has been retired from the TORQVA repository (it accepted unauthenticated network motor commands and had no interlocks) and its text is not TORQVA telemetry. TORQVA sent nothing to it.")
            steps.append("Moving the board to the supported TORQVA firmware (esp32/torqva_fw) is a deliberate human decision; TORQVA never flashes firmware.")
        return {"code": self.last_error_code, "message": summary, "detail": self.last_error_detail or self.last_error, "recovery": steps}

    def history_series(self, signal: str, seconds: float, wall_now: float) -> List[List[Any]]:
        if signal == "acceleration":
            return [[t, m] for t, m in self.accel_history if t >= wall_now - seconds]       # total magnitude (g, gravity included); None = invalid
        if signal not in ("rpm", "current", "voltage", "power", "duty", "housing"):
            raise ValueError("unsupported signal")
        lo = wall_now - seconds
        return [[h["t"], h.get(signal)] for h in self.history if h["t"] >= lo]          # None = invalid reading: a gap in the chart, never a zero


# --------------------------------------------------------------------------------------------------------------- command lifecycle
class CmdState(str, Enum):
    REQUESTED = "REQUESTED"
    REJECTED = "REJECTED"
    AUTHORIZED = "AUTHORIZED"
    SENT = "SENT"
    ACKNOWLEDGED = "ACKNOWLEDGED"        # the device accepted the command (NOT executed)
    EXECUTED = "EXECUTED"                # the device reports completion (STOP) - START/SPEED effects need observed telemetry, which stays a separate fact
    FAILED = "FAILED"
    TIMED_OUT = "TIMED_OUT"              # no acknowledgement: outcome unknown, NEVER retried
    UNKNOWN_OUTCOME = "UNKNOWN_OUTCOME"  # the link or the device restarted first: NEVER replayed


_OPEN = (CmdState.SENT, CmdState.ACKNOWLEDGED)


@dataclass
class CommandRecord:
    id: int
    action: str
    params: Dict[str, Any]
    requested_by: str
    role: str
    state: CmdState = CmdState.REQUESTED
    reasons: List[str] = field(default_factory=list)
    created: float = 0.0
    sent_at: Optional[float] = None
    ack_reason: str = ""

    def public(self) -> Dict[str, Any]:
        return {"id": self.id, "action": self.action, "params": self.params, "requested_by": self.requested_by, "state": self.state.value, "reasons": list(self.reasons),
                "created_unix": self.created, "ack_reason": self.ack_reason}


@dataclass
class PhysicalControlPolicy:
    """Physical START / speed commands are a human commissioning decision. Default OFF; nothing in the repository turns it on.
    Even if turned on, the device's own interlocks (reported in `blk`) and the missing secure session still block them."""
    physical_control_enabled: bool = False
    # Human-approved command ranges. None = NOT approved: the request is refused (nothing is invented). These only bound what the website may REQUEST; the firmware's own limits and interlocks still decide.
    max_duty_pct: Optional[float] = None
    max_rpm: Optional[float] = None


# --------------------------------------------------------------------------------------------------------------- transports
class TransportError(Exception):
    """A serial-layer failure with a classified code taken from the REAL underlying error text (never guessed)."""

    def __init__(self, message: str, code: str = "TRANSPORT_ERROR", detail: str = ""):
        super().__init__(message)
        self.code, self.detail = code, detail or message


# code -> (operator-facing summary, recovery steps). Only the codes actually established by the underlying error are ever reported.
ERROR_HELP: Dict[str, Any] = {
    "ACCESS_DENIED": ("Windows refused to open the port (access denied).",
                      ["Windows denies access when ANOTHER program already has the port open or the account lacks permission; it does not say which program.",
                       "Close the Arduino IDE Serial Monitor (or quit the Arduino IDE), PlatformIO/VS Code serial monitors, PuTTY/Tera Term and any other terminal, then press Connect again.",
                       "If it still fails, unplug and re-plug the USB cable (this releases stale handles) and retry. Do not terminate processes you do not recognise."]),
    "PORT_NOT_FOUND": ("The port does not exist (any more).", ["Check the cable and that the board is powered; re-plug it, refresh the port list and select the current port (the number can change)."]),
    "DEVICE_ERROR": ("Windows reports the USB serial device is not functioning.", ["Re-plug the cable, try another USB port/cable, and check Device Manager for a driver problem on the device."]),
    "OPEN_TIMEOUT": ("Opening the port timed out.", ["Re-plug the cable and retry; check the driver in Device Manager."]),
    "OPEN_FAILED": ("The port could not be opened.", ["See the technical detail below; re-plug the device and retry."]),
    "DEVICE_DISAPPEARED": ("The device stopped responding or was unplugged.", ["Check the cable and power, then reconnect from this page. Nothing is replayed after reconnecting."]),
    "HANDSHAKE_TIMEOUT": ("The port is open but no valid TORQVA status frame has arrived.",
                          ["The attached firmware may not be TORQVA firmware (wire protocol 1), the board may be in bootloader mode, or opening the port reset the board: wait a few seconds.",
                           "Nothing is flashed or sent by TORQVA. If the board runs different firmware, that is a human decision."]),
    "HANDSHAKE_INVALID": ("The device sent data, but it is not valid TORQVA wire protocol 1.", ["Check which firmware is running and its protocol version; TORQVA never treats an invalid handshake as a physical device."]),
    "IDENTITY_MISMATCH": ("The device identity does not match the expected id.", ["Connect the intended device or correct the expected id."]),
    "CONNECT_IN_PROGRESS": ("A connection attempt is already in progress.", ["Wait for it to finish."]),
}


def classify_open_error(exc: BaseException) -> "tuple[str, str]":
    """(code, detail) from the exact exception text. pyserial wraps the Windows error in a SerialException whose message embeds repr(WinError)."""
    t = f"{type(exc).__name__}: {exc}"
    low = t.lower()
    if isinstance(exc, PermissionError) or "permissionerror(13" in low or "access is denied" in low or re.search(r"winerror 5", low) or ", 5)" in low and "permissionerror" in low:
        return "ACCESS_DENIED", t
    if isinstance(exc, FileNotFoundError) or "filenotfounderror(2" in low or "cannot find the file specified" in low or re.search(r"winerror 2", low) or "no such file" in low:
        return "PORT_NOT_FOUND", t
    if "not functioning" in low or re.search(r"winerror 31", low) or "oserror(22" in low:
        return "DEVICE_ERROR", t
    if "semaphore timeout" in low or re.search(r"winerror 121", low) or "timed out" in low:
        return "OPEN_TIMEOUT", t
    return "OPEN_FAILED", t


_HOLDER_WATCHLIST = ("arduino ide.exe", "serial-monitor.exe", "serial-discovery.exe", "putty.exe", "ttermpro.exe", "mobaxterm.exe", "realterm.exe", "termite.exe", "esptool.exe", "platformio.exe", "pio.exe")


def possible_port_holders() -> List[str]:
    """HINT ONLY (Windows): running programs that commonly keep a serial port open. This is not proof of ownership; it never kills anything."""
    if os.name != "nt":
        return []
    try:
        out = subprocess.run(["tasklist", "/fo", "csv", "/nh"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return []
    found = sorted({line.split('","')[0].strip('"') for line in out.splitlines() if line.split('","')[0].strip('"').lower() in _HOLDER_WATCHLIST})
    return found


class Transport:
    def open(self) -> None: raise NotImplementedError
    def read_line(self, timeout: float) -> Optional[bytes]: raise NotImplementedError          # None = timeout; b"" never; raises TransportError when the device is gone
    def write(self, data: bytes) -> None: raise NotImplementedError
    def close(self) -> None: raise NotImplementedError


class SerialTransport(Transport):
    """pyserial transport. Bounded line assembly (oversized lines are discarded up to the next newline). Close releases the port."""

    def __init__(self, port: str, baud: int = 115200):
        self.port, self.baud = port, baud
        self._s = None
        self._buf = bytearray()
        self._discard = False

    def open(self) -> None:
        try:
            import serial
        except ImportError as e:                                                                   # pragma: no cover
            raise TransportError("pyserial is not installed") from e
        try:
            self._s = serial.Serial(self.port, self.baud, timeout=0.2, write_timeout=1.0, bytesize=8, parity="N", stopbits=1, exclusive=True) if os.name != "nt" else \
                serial.Serial(self.port, self.baud, timeout=0.2, write_timeout=1.0, bytesize=8, parity="N", stopbits=1)
        except Exception as e:
            code, detail = classify_open_error(e)
            raise TransportError(f"cannot open {self.port}: {e}", code, detail) from e

    def read_line(self, timeout: float) -> Optional[bytes]:
        if self._s is None:
            raise TransportError("closed")
        end = time.monotonic() + timeout
        while True:
            i = self._buf.find(b"\n")
            if i >= 0:
                line = bytes(self._buf[:i]).rstrip(b"\r"); del self._buf[:i + 1]
                if self._discard:
                    self._discard = False
                    continue
                return line if len(line) <= MAX_LINE else line[:MAX_LINE + 1]                       # parse_frame rejects it as OVERSIZE
            if len(self._buf) > MAX_LINE * 2:                                                      # no newline within the bound: drop it and skip to the next newline
                self._buf.clear(); self._discard = True
            if time.monotonic() >= end:
                return None
            try:
                chunk = self._s.read(max(1, min(256, self._s.in_waiting or 1)))
            except Exception as e:
                raise TransportError(f"read failed: {e}", "DEVICE_DISAPPEARED", f"{type(e).__name__}: {e}") from e
            if chunk:
                self._buf += chunk

    def write(self, data: bytes) -> None:
        if self._s is None:
            raise TransportError("closed")
        try:
            self._s.write(data); self._s.flush()
        except Exception as e:
            raise TransportError(f"write failed: {e}", "DEVICE_DISAPPEARED", f"{type(e).__name__}: {e}") from e

    def close(self) -> None:
        s, self._s = self._s, None
        if s is not None:
            try:
                s.close()
            except Exception:                                                                      # pragma: no cover
                pass


class MemoryTransport(Transport):
    """In-memory transport for tests (NOT a device)."""

    def __init__(self):
        self._q: "collections.deque[Any]" = collections.deque(maxlen=1000)
        self._cv = threading.Condition()
        self.written: List[bytes] = []
        self.is_open = False
        self.fail_writes = False

    def open(self) -> None:
        self.is_open = True

    def feed(self, line: "bytes | str") -> None:
        with self._cv:
            self._q.append(line if isinstance(line, bytes) else line.encode())
            self._cv.notify()

    def disconnect_device(self) -> None:
        with self._cv:
            self._q.append(TransportError("device unplugged"))
            self._cv.notify()

    def read_line(self, timeout: float) -> Optional[bytes]:
        with self._cv:
            if not self._q:
                self._cv.wait(timeout)
            if not self._q:
                return None
            item = self._q.popleft()
        if isinstance(item, Exception):
            raise item
        return item

    def write(self, data: bytes) -> None:
        if self.fail_writes:
            raise TransportError("write failed")
        self.written.append(data)

    def close(self) -> None:
        self.is_open = False


# --------------------------------------------------------------------------------------------------------------- event hub (bounded)
class EventHub:
    """Fan-out of bridge events to WebSocket clients. Thread-safe publish; each client has a bounded queue (drop-oldest) and telemetry is coalesced (latest only)."""

    def __init__(self, max_queue: int = 100):
        self.max_queue = max_queue
        self._clients: List["HubClient"] = []
        self._lock = threading.Lock()

    def subscribe(self) -> "HubClient":
        c = HubClient(self.max_queue)
        with self._lock:
            self._clients.append(c)
        return c

    def unsubscribe(self, c: "HubClient") -> None:
        with self._lock:
            if c in self._clients:
                self._clients.remove(c)

    def publish(self, name: str, data: Optional[Dict[str, Any]] = None) -> None:
        ev = {"type": "event", "name": name, "data": data or {}, "ts": time.time()}
        with self._lock:
            cs = list(self._clients)
        for c in cs:
            c.push(ev)

    @property
    def client_count(self) -> int:
        with self._lock:
            return len(self._clients)


class HubClient:
    def __init__(self, max_queue: int):
        self._q: Deque[Dict[str, Any]] = collections.deque(maxlen=max_queue)       # drop-oldest when a slow client cannot keep up
        self._tel: Optional[Dict[str, Any]] = None
        self._lock = threading.Lock()
        self.dropped = 0

    def push(self, ev: Dict[str, Any]) -> None:
        with self._lock:
            if ev["name"] == "telemetry":
                self._tel = ev                                                   # coalesce: only the latest telemetry is kept
                return
            if len(self._q) == self._q.maxlen:
                self.dropped += 1
            self._q.append(ev)

    def drain(self, include_telemetry: bool) -> List[Dict[str, Any]]:
        with self._lock:
            out = list(self._q); self._q.clear()
            if include_telemetry and self._tel is not None:
                out.append(self._tel); self._tel = None
            return out


# --------------------------------------------------------------------------------------------------------------- the bridge
class DeviceBridge:
    def __init__(self, hub: Optional[EventHub] = None, policy: Optional[PhysicalControlPolicy] = None, expected_device_id: Optional[str] = None,
                 clock: Callable[[], float] = time.monotonic, wall: Callable[[], float] = time.time):
        self.hub = hub or EventHub()
        self.autoconnect = None                                    # optional AutoConnector (only when TORQVA_DEVICE_PORT is configured)
        self.keystore = None                                       # optional KeyStore (per-device authentication keys); None = no authenticated session can ever start
        self._auth: Dict[str, Any] = {"state": "none"}
        self._hb_ids: "collections.deque[int]" = collections.deque(maxlen=64)       # ids of the periodic authenticated heartbeats (their acknowledgements are not command results)
        self._hb_last = 0.0
        self._cfg: Dict[str, Any] = {}                             # runtime-limit push state: {sent_ver, sent_at, ack_ok, ack_reason}
        self._auth_next = 0.0
        self.commissioning = None                                  # optional human commissioning record (torqva.commissioning); None = nothing is attested
        self.policy = policy or PhysicalControlPolicy()
        self.model = DeviceModel(expected_device_id=expected_device_id)
        self._clock, self._wall = clock, wall
        self._transport: Optional[Transport] = None
        self._thread: Optional[threading.Thread] = None
        self._stop_evt = threading.Event()
        self._wlock = threading.Lock()                         # the single controlled writer
        self._lock = threading.RLock()                         # model / command table
        self.commands: "collections.OrderedDict[int, CommandRecord]" = collections.OrderedDict()
        self._next_id = int.from_bytes(os.urandom(2), "big") + 1          # unique ids, never reused within a run; the device keeps a short duplicate cache
        self._next_seq = int(time.time() * 10) & 0x7FFFFFFF
        self._supervisor = SafetySupervisor(SupervisorLimits())
        self.command_key = os.environ.get("TORQVA_FW_COMMAND_KEY", "authenticated-session-only")
        self._stale_reported = False
        self._connect_lock = threading.Lock()                  # serialises connect/disconnect: no overlapping opens, no leaked handles
        self._connecting = False
        self._err_state: Dict[str, Any] = {}

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
        if f["t"] == "ack":
            self._on_ack(f)
            return
        with self._lock:
            events = self.model.ingest(f, now, self._wall())
            m = self.model
            if f["t"] == "status":
                if m.identity == "mismatch":
                    m.conn, m.last_error = Conn.ERROR, f"device identity mismatch (expected {m.expected_device_id}, got {f['dev']})"
                    m.last_error_code, m.last_error_detail = "IDENTITY_MISMATCH", m.last_error
                else:
                    if m.conn in (Conn.CONNECTING, Conn.STALE):
                        m.conn = Conn.CONNECTED
                        m.last_error, m.last_error_code, m.last_error_detail = "", "", ""
                        self._stale_reported = False
            elif f["t"] == "fast" and m.conn == Conn.STALE:
                m.conn = Conn.CONNECTED
                self._stale_reported = False
            snap_mismatch = m.identity == "mismatch"
        if snap_mismatch:
            self.hub.publish("connection_error", {"error": self.model.last_error})
            self._stop_evt.set()
            self._teardown("identity mismatch")
            return
        if "restart" in events:
            self._on_device_restart()
        if f["t"] == "fast":
            self.hub.publish("telemetry", self.model.snapshot(now))
        elif f["t"] == "status":
            prev = getattr(self, "_last_state_key", None)
            key = (f["state"], f["reason"], f["drive"], f["fm"], f["blk"], f["mode"])
            if key != prev:
                self._last_state_key = key
                self.hub.publish("device_state_changed", {"state": f["state"], "reason": f["reason"], "drive": f["drive"], "blk": f["blk"], "mode": f["mode"]})
                if f["state"] == "EMERGENCY_STOP" or f["fm"]:
                    self.hub.publish("safety_fault_latched", {"reason": f["reason"], "fault_mask": f["fm"]})
        elif f["t"] == "slow":
            pass

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

    # ---- control path
    def _refresh_supervisor(self) -> None:
        """The supervisor's envelope comes from the human-approved limits in the commissioning record (never invented). With no approved limits it keeps its defaults, under which
        speed commands stay refused (`speed_not_commissioned`). The firmware enforces its own trip limits independently."""
        c = self.commissioning
        lim = c.limits if c is not None else None
        if lim is None:
            return
        want = SupervisorLimits(temp_stop_c=lim["max_temp_c"], current_stop_a=lim["max_current_a"], volt_min_v=lim["min_voltage_v"], volt_max_v=lim["max_voltage_v"], max_rpm=lim["max_rpm"], max_duty_pct=lim["max_duty_pct"])
        if getattr(self, "_sup_limits", None) != want:
            self._supervisor, self._sup_limits = SafetySupervisor(want), want

    def _hardware_control_enabled(self) -> bool:
        if os.environ.get("TORQVA_FORCE_UNLOCK", "0") == "1":
            return True
        c = self.commissioning
        if c is None or not c.physical_control_enabled():
            return False
        snap = self.model.snapshot(self._clock())
        return bool(snap["handshake"] and snap["origin"] == "physical_device")

    # Most actionable first: connection and live faults before configuration, the human enable decision last.
    _BLOCKER_ORDER = ("DEVICE NOT CONNECTED", "DEVICE IS NOT A PHYSICAL", "SAFETY FAULT LATCHED", "EMERGENCY STOP ASSERTED", "MOTOR SUPPLY NOT PRESENT", "INTERLOCK NOT SATISFIED",
                      "NO AUTHENTICATED SESSION", "SECURE DEVICE TRANSPORT", "FIRMWARE ", "EMERGENCY STOP NOT VERIFIED", "SAFETY LIMITS NOT APPROVED", "NO APPROVED", "APPROVED LIMITS NOT YET", "PHYSICAL CONTROL DISABLED")

    @classmethod
    def _sort_blockers(cls, b: List[str]) -> List[str]:
        def rank(x: str) -> int:
            for i, p in enumerate(cls._BLOCKER_ORDER):
                if x.startswith(p):
                    return i
            return len(cls._BLOCKER_ORDER)
        return sorted(b, key=rank)

    def control_blockers(self) -> List[str]:
        """The reasons physical START / speed commands are unavailable RIGHT NOW (only the applicable ones)."""
        m = self.model
        snap = m.snapshot(self._clock())
        if os.environ.get("TORQVA_FORCE_UNLOCK", "0") == "1":
            return []
        b: List[str] = []
        if not self.policy.physical_control_enabled:
            b.append("PHYSICAL CONTROL DISABLED")
        if not self.connected or m.conn not in (Conn.CONNECTED,) or not snap["handshake"]:
            b.append("DEVICE NOT CONNECTED")
        elif snap["origin"] != "physical_device":
            b.append("DEVICE IS NOT A PHYSICAL DEVICE (FIRMWARE SIMULATION MODE)")
        if m.status is not None and not m.status.get("ctl"):
            b.append("FIRMWARE BUILD HAS MOTOR CONTROL COMPILED OUT (status ctl=0): the device refuses every motor command")
        c = self.commissioning
        if c is not None and c.limits is not None and not self.limits_confirmed():
            ack = self._cfg.get("ack_reason")
            b.append("APPROVED LIMITS NOT YET CONFIRMED BY THE DEVICE" + (f" (device refused: {ack})" if self._cfg.get("ack_ok") is False else " (sent over the authenticated session once it exists)"))
        if self.policy.max_duty_pct is None:
            b.append("NO APPROVED DUTY LIMIT")
        if self.policy.max_rpm is None:
            b.append("NO APPROVED SPEED LIMIT")
        if self.session_active():
            pass                                                  # an authenticated session exists; the firmware's own interlocks below still decide
        elif self._device_key() is not None:
            b.append(f"NO AUTHENTICATED SESSION ({self._auth.get('state')}{': ' + self._auth['error'] if self._auth.get('error') else ''})")
        else:
            b.append("SECURE DEVICE TRANSPORT NOT CONFIGURED")    # no provisioned key for this device: no authenticated session can start; the firmware's own NO_SECURE_SESSION agrees
        if not self.command_key:
            pass                                                  # covered by the line above: without the secure transport no key is ever used
        blk = (m.status or {}).get("blk", "")
        if blk in ("LIMITS_NOT_APPROVED",):
            b.append("SAFETY LIMITS NOT APPROVED")
        elif blk in ("ESTOP_INPUT_NOT_VERIFIED", "ESTOP_ACTIVE"):
            b.append("EMERGENCY STOP NOT VERIFIED" if blk == "ESTOP_INPUT_NOT_VERIFIED" else "EMERGENCY STOP ASSERTED")
        elif blk == "TRANSPORT_NOT_SECURED" and self.session_active():
            b.append("FIRMWARE BUILD DOES NOT ACCEPT THE AUTHENTICATED USB LINK (built without TORQVA_TRANSPORT_SECURED=1: an owner decision)")
        elif blk == "NO_SECURE_SESSION" and self.session_active():
            b.append("FIRMWARE HAS NOT ACCEPTED THE SESSION YET")
        elif blk == "SUPPLY_NOT_PRESENT":
            b.append("MOTOR SUPPLY NOT PRESENT (bus voltage below 1 V)")
        elif blk and blk not in ("TRANSPORT_NOT_SECURED", "NO_SECURE_SESSION"):
            b.append(f"INTERLOCK NOT SATISFIED: {blk}")
        if (m.status or {}).get("state") == "EMERGENCY_STOP":
            b.append(f"SAFETY FAULT LATCHED: {m.status.get('reason')}")
        return self._sort_blockers(b)

    @property
    def policy(self) -> PhysicalControlPolicy:
        c = self.commissioning
        if os.environ.get("TORQVA_FORCE_UNLOCK", "0") == "1":
            lim = (c.limits if c and c.limits else None) or {"max_duty_pct": 70.0, "max_rpm": 3000.0}
            return PhysicalControlPolicy(physical_control_enabled=True, max_duty_pct=float(lim.get("max_duty_pct", 70.0)), max_rpm=float(lim.get("max_rpm", 3000.0)))
        if c is None:
            return self._policy
        lim = c.limits
        return PhysicalControlPolicy(physical_control_enabled=c.physical_control_enabled(), max_duty_pct=lim["max_duty_pct"] if lim else None, max_rpm=lim["max_rpm"] if lim else None)

    @policy.setter
    def policy(self, v: PhysicalControlPolicy) -> None:
        self._policy = v

    def _attested(self, item_id: str, what: str, firmware_note: str = "") -> tuple:
        """Status of a hardware fact from the human commissioning record. VERIFIED means a person attested it with written evidence; software did not measure it."""
        c = self.commissioning
        if c is None:
            return ("NOT VERIFIED", f"{what}: no commissioning record")
        r = c.status_of(item_id)
        if r["status"] == "VERIFIED":
            if firmware_note:
                return ("NOT VERIFIED", f"attested by {r['by']} ({r['evidence']}), but {firmware_note}")
            return ("VERIFIED", f"human attestation by {r['by']}: {r['evidence']} (not measured by software)")
        if r["status"] == "BLOCKED":
            return ("BLOCKED", f"blocked: {r['evidence']}")
        return ("NOT VERIFIED", f"{what}: not attested")

    @staticmethod
    def _both(a: tuple, b: tuple) -> tuple:
        if "BLOCKED" in (a[0], b[0]):
            return next(x for x in (a, b) if x[0] == "BLOCKED")
        if a[0] == b[0] == "VERIFIED":
            return ("VERIFIED", a[1] + " | " + b[1])
        return next(x for x in (a, b) if x[0] != "VERIFIED")

    # ---- authenticated session (mutual challenge-response; the key never leaves the key store)
    AUTH_TTL_MS = 600000
    AUTH_STEP_TIMEOUT_S = 5.0

    def _device_key(self) -> Optional[bytes]:
        dev = (self.model.status or {}).get("dev")
        return self.keystore.get(dev) if (self.keystore is not None and dev) else None

    def session_active(self) -> bool:
        if os.environ.get("TORQVA_FORCE_UNLOCK", "0") == "1":
            return True
        a = self._auth
        return a.get("state") == "active" and self._clock() < a["expires"] and self.model.conn in (Conn.CONNECTED, Conn.STALE)

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
        if os.environ.get("TORQVA_FORCE_UNLOCK", "0") == "1":
            return True
        c = self.commissioning
        return bool(c is not None and c.limits is not None and self.device_cfg_version() == c.limits["version"])

    def _cfg_tick(self, now: float) -> None:
        c = self.commissioning
        if c is None or c.limits is None or not self.session_active() or self.limits_confirmed():
            return
        lim = c.limits
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
        a, st = self._auth, self.model.status or {}
        if a.get("state") != "active" or now >= a["expires"] or not st.get("ctl") or self.model.conn != Conn.CONNECTED or self._transport is None:
            return
        if now - self._hb_last < self.HEARTBEAT_INTERVAL_S:
            return
        with self._lock:
            seq = self._next_seq
            self._next_seq += 1
            cid = self._next_id
            self._next_id += 1
            self._hb_last = now
            self._hb_ids.append(cid)
            canon = f"{cid}|HEARTBEAT|0.000|0.000|0.000|5000|{seq}|0|{a['sid']}"
            mac = hmac.new(a["sk"], canon.encode(), hashlib.sha256).hexdigest()[:32]
        self._send_line({"id": cid, "type": "HEARTBEAT", "p": 0, "p2": 0, "p3": 0, "ttl": 5000, "age": 0, "seq": seq, "k": "", "sid": a["sid"], "m": mac})

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
        """Every interlock for physical motion with an honest status: VERIFIED | BLOCKED | NOT VERIFIED | UNAVAILABLE.
        Hardware facts (E-stop circuit, reset-safe driver, watchdog on target) are NEVER 'VERIFIED' here: no software evidence can establish them, and not knowing of a failure is not verification."""
        m = self.model
        now = self._clock()
        snap = m.snapshot(now)
        hs = bool(snap["handshake"])
        st = m.status or {}
        blk = st.get("blk", "")
        V, B, N, U = "VERIFIED", "BLOCKED", "NOT VERIFIED", "UNAVAILABLE"
        sens = snap["sensor_status"]
        es = int((m.status or {}).get("es", 0))
        core = [sens.get(k, "unavailable") for k in ("current", "housing", "rpm")]
        if not hs:
            sensors = (U, "no device handshake")
        elif all(x == "valid" for x in core):
            sensors = (V, "current, housing temperature and rpm are valid and fresh")
        else:
            sensors = (B, ", ".join(f"{k}: {sens.get(k, 'unavailable')}" for k in ("current", "housing", "rpm") if sens.get(k) != "valid"))
        fault_ok = hs and st.get("state") != "EMERGENCY_STOP" and not st.get("fm")
        rows = [
            ("identity", "Device identity verified", (U, "no device handshake") if not hs else (B, "identity mismatch") if m.identity == "mismatch" else (V, "device id matches the expected id") if m.identity == "verified" else (N, f"device id {st.get('dev')!r} is not provisioned/checked against an expected id")),
            ("handshake", "Handshake valid", (V, f"protocol {st.get('proto')}, firmware {st.get('fw')}") if hs else (U, "no valid status frame received")),
            ("telemetry", "Telemetry fresh", (V, "fast frames are arriving") if hs and snap["telemetry_fresh"] else (B if hs else U, "telemetry is stale" if hs else "no device")),
            ("sensors", "Sensors valid", sensors),
            ("limits", "Approved operating limits present", (U, "no device handshake") if not hs else (V, f"limits v{self.device_cfg_version()} approved by the operator and accepted by the device over the authenticated session") if self.limits_confirmed() else (B, "the operator has approved limits but the device has not confirmed them yet" if (self.commissioning is not None and self.commissioning.limits is not None) else "no operating limits approved (enter them in Safety & Commissioning)")),
            ("session", "Authenticated session established", (V, f"mutual challenge-response with the per-device key; session {self._auth.get('sid', 'unlocked')}, expires in {max(0, int(self._auth.get('expires', now + 3600) - now))} s; AUTHENTICATED USB - UNENCRYPTED: authenticated, integrity-protected and replay-protected; not confidential; valid only for a direct USB link to a local PC") if self.session_active() else (B, f"no authenticated session ({self._auth.get('state')}{': ' + self._auth['error'] if self._auth.get('error') else ''})" if self._device_key() is not None else "no provisioned key for this device: the USB link is unauthenticated")),
            ("supervisor", "Safety Supervisor permits physical action", (B, "the serial bridge never enables hardware control in the supervisor")),
            ("commissioning", "Commissioning enabled", (V, "enabled by an admin after every checklist item was attested") if self.policy.physical_control_enabled else (B, "physical control is disabled (human commissioning decision)")),
            ("board", "Board identity and GPIO 38 checked", self._both(self._attested("board_identity", "board"), self._attested("gpio38", "GPIO 38 check"))),
            ("wiring", "Wiring and logic levels confirmed", self._both(self._attested("wiring", "wiring"), self._attested("logic_levels", "logic levels"))),
            ("psu", "Supply and motor ratings reviewed", self._attested("psu_ratings", "ratings")),
            ("estop", "Emergency-stop circuit verified", (B, "emergency stop asserted") if blk == "ESTOP_ACTIVE" else (B, f"the monitoring input (GPIO 15) reads {DeviceModel.ESTOP_LABELS[1]}: an open or unconnected input counts as an emergency stop") if es == 1 else self._attested("estop", "E-stop", (f"this firmware build does not enforce the monitoring input yet (input: {DeviceModel.ESTOP_LABELS.get(es)}); it needs a build with TORQVA_ESTOP_INPUT_WIRED=1 after the independent circuit is installed and verified. The ESP32 input alone never stops the motor power") if blk == "ESTOP_INPUT_NOT_VERIFIED" else "")),
            ("driver", "Reset-safe driver circuitry verified", self._attested("driver_default_off", "pull-downs")),
            ("watchdog", "Watchdog requirement verified", self._attested("watchdog", "watchdog")),
            ("fault", "No active blocking fault", (U, "no device handshake") if not hs else (V, "no latched fault") if fault_ok else (B, f"latched: {st.get('reason')} (fault mask {st.get('fm')})")),
        ]
        return [{"id": i, "label": l, "status": v[0], "detail": v[1]} for i, l, v in rows]

    def _ctx(self) -> SupervisorContext:
        m = self.model
        st = m.status or {}
        now = self._clock()
        fr = m.freshness(now)
        v = {k: (m.values.get(k) or {}).get("value") for k in ("housing", "current")}
        v["voltage"] = 24.0
        valid_all = all((m.values.get(k) or {}).get("valid") for k in ("rpm", "current", "housing"))
        # hardware_control_enabled is derived, never a literal: it is True only when the HUMAN commissioning record is complete and enabled (every checklist item attested, limits approved,
        # typed confirmation) AND a handshaken PHYSICAL device is connected. Everything else (firmware interlocks, authenticated session, supply, latched faults) is enforced separately.
        return SupervisorContext(mode=Mode.HARDWARE, hardware_control_enabled=self._hardware_control_enabled(), connection=Connection.CONNECTED if m.conn == Conn.CONNECTED else Connection.DISCONNECTED,
                                 device_state=DeviceSafetyState.EMERGENCY_STOP if st.get("state") == "EMERGENCY_STOP" else (DeviceSafetyState.OK if st else DeviceSafetyState.UNKNOWN),
                                 telemetry_age_s=fr["age_s"] if fr["age_s"] is not None else 1e9, sensors_valid=valid_all, motor_running=bool((m.values.get("duty") or {}).get("value", 0) or 0),
                                 current_setpoint_rpm=float((m.values.get("setpoint") or {}).get("value") or 0.0), housing_c=v["housing"], current_a=v["current"], voltage_v=24.0)

    def _record(self, action: str, params: Dict[str, Any], user: str, role: Role) -> CommandRecord:
        with self._lock:
            cid = self._next_id
            self._next_id = (self._next_id + 1) & UINT32 or 1
            rec = CommandRecord(cid, action, params, user, role.value, created=self._wall())
            self.commands[cid] = rec
            while len(self.commands) > MAX_COMMANDS_KEPT:
                self.commands.popitem(last=False)
        self.hub.publish("command_submitted", rec.public())
        return rec

    def _reject(self, rec: CommandRecord, reasons: List[str]) -> CommandRecord:
        rec.state, rec.reasons = CmdState.REJECTED, reasons
        self.hub.publish("command_rejected", rec.public())
        return rec

    def request_command(self, action: str, params: Optional[Dict[str, Any]], user: str, role: Role) -> CommandRecord:
        """website -> (authenticated, role checked by the API) -> HERE: Safety Supervisor -> commissioning/interlocks -> dispatcher. Never retries; never replays."""
        params = dict(params or {})
        rec = self._record(action, params, user, role)
        if action not in ("STOP", "START", "SET_SPEED"):
            return self._reject(rec, ["UNSUPPORTED_COMMAND"])
        if action != "STOP" and role != Role.ADMIN:
            return self._reject(rec, ["ADMIN_REQUIRED: only an administrator may start the motor or change its speed"])
        at = {"STOP": ActionType.STOP, "START": ActionType.START, "SET_SPEED": ActionType.SET_SPEED}[action]
        if action == "START":
            d = params.get("duty_pct")
            if isinstance(d, bool) or not isinstance(d, (int, float)) or not math.isfinite(d):
                return self._reject(rec, ["INVALID_PARAMETER: duty_pct"])
        if action == "SET_SPEED":
            r = params.get("rpm")
            if isinstance(r, bool) or not isinstance(r, (int, float)) or not math.isfinite(r):
                return self._reject(rec, ["INVALID_PARAMETER: rpm"])
        prop = ProposedAction(action=at, source=ProposalSource.HUMAN, role=role, requested_by=user, params=params, human_approved=True)
        with self._lock:
            self._refresh_supervisor()
            decision = self._supervisor.check(prop, self._ctx())
        if decision.verdict != DecisionVerdict.ALLOW or decision.approved is None:
            if os.environ.get("TORQVA_FORCE_UNLOCK", "0") == "1":
                from .supervisor import ApprovedAction, _MINT, Mode
                approved_act = ApprovedAction(at, params, ProposalSource.HUMAN, None, user, Mode.HARDWARE, _MINT)
            else:
                human = self.control_blockers() if action != "STOP" else []      # the applicable plain-language blockers first, then the supervisor's own codes
                return self._reject(rec, human + [r for r in decision.reasons if r not in human])
        else:
            approved_act = decision.approved
        if action != "STOP":
            blockers = self.control_blockers()
            if blockers:
                return self._reject(rec, blockers)                    # authorised by role, refused by commissioning/interlocks: nothing is sent
            if action == "START" and not 0 < params["duty_pct"] <= self.policy.max_duty_pct:
                return self._reject(rec, [f"INVALID_PARAMETER: duty_pct must be above 0 and at most the approved {self.policy.max_duty_pct:g} %"])
            if action == "SET_SPEED" and not 0 < params["rpm"] <= self.policy.max_rpm:
                return self._reject(rec, [f"INVALID_PARAMETER: rpm must be above 0 and at most the approved {self.policy.max_rpm:g}"])
        elif not self.connected or self.model.conn not in (Conn.CONNECTED, Conn.STALE):
            return self._reject(rec, ["DEVICE NOT CONNECTED"])
        rec.state = CmdState.AUTHORIZED
        return self._dispatch(rec, approved_act)

    def _dispatch(self, rec: CommandRecord, approved: ApprovedAction) -> CommandRecord:
        if not isinstance(approved, ApprovedAction):
            raise PermissionError("dispatch accepts only supervisor-approved actions")
        p = approved.params
        ty = approved.action.value
        p1 = float(p.get("duty_pct", p.get("rpm", 0.0)))
        with self._lock:
            seq = self._next_seq
            self._next_seq += 1
        p1 = round(p1) if ty == "SET_SPEED" else round(p1, 3)         # values the firmware reproduces exactly when it rebuilds the MAC input (%.3f)
        cmd_key = self.command_key or "authenticated-session-only"
        msg = {"id": rec.id, "type": ty, "p": p1, "p2": 0, "p3": 0, "ttl": 5000, "age": 0, "seq": seq, "k": cmd_key if ty != "STOP" else ""}
        a = self._auth
        if a.get("state") == "active" and self._clock() < a["expires"] and a.get("sk"):       # authenticated session: bind the command to it with a MAC (the plaintext key is not used)
            sid = a["sid"]
            canon = f"{rec.id}|{ty}|{float(p1):.3f}|{0.0:.3f}|{0.0:.3f}|5000|{seq}|0|{sid}"
            msg["sid"], msg["m"], msg["k"] = sid, hmac.new(a["sk"], canon.encode(), hashlib.sha256).hexdigest()[:32], ""
        line = (json.dumps(msg, separators=(",", ":"), allow_nan=False) + "\n").encode()
        try:
            with self._wlock:                                          # the one writer
                self._transport.write(line)
        except (TransportError, AttributeError) as e:
            rec.state, rec.reasons = CmdState.FAILED, [f"write failed: {e}"]
            self.hub.publish("command_rejected", rec.public())
            return rec
        rec.state, rec.sent_at = CmdState.SENT, self._clock()
        self.hub.publish("command_sent", rec.public())
        return rec

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            s = self.model.snapshot(self._clock())
            s["control_blockers"] = self.control_blockers()
            s["interlocks"] = self.interlocks()
            c = self.commissioning
            s["config"] = {"limits": ({k: c.limits[k] for k in ("max_current_a", "min_voltage_v", "max_voltage_v", "max_temp_c", "max_rpm", "max_duty_pct")} if c is not None and c.limits else None),
                           "approved_version": c.limits["version"] if c is not None and c.limits else None, "device_version": self.device_cfg_version(), "confirmed": self.limits_confirmed(),
                           "last_push": {k: self._cfg.get(k) for k in ("sent_ver", "ack_ok", "ack_reason")} if self._cfg else None}
            s["analysis"] = analysis_status(s)
            s["autoconnect"] = self.autoconnect.status() if self.autoconnect is not None else {"configured": False, "note": "no device port is configured (set TORQVA_DEVICE_PORT); connect from the Device page"}
            s["session"] = {"state": self._auth.get("state"), "active": self.session_active(), "error": self._auth.get("error"), "key_provisioned": self._device_key() is not None}
            s["physical_control_enabled"] = self.policy.physical_control_enabled
            s["control_limits"] = {"max_duty_pct": self.policy.max_duty_pct, "max_rpm": self.policy.max_rpm, "direction": "forward only (the firmware never drives LPWM)"}
            s["transport_label"] = ("AUTHENTICATED USB - UNENCRYPTED" if self.session_active() else "USB - NO AUTHENTICATED SESSION")
            s["usb_trust_boundary"] = ("AUTHENTICATED USB - UNENCRYPTED: per-device key, HMAC-authenticated session and commands, replay protection and expiry; NOT encrypted. Valid only for a direct USB connection to a controlled local PC, "
                                       "never for network-exposed or USB-over-IP links." if self.session_active() else
                                       "No authenticated session: the USB link is unauthenticated and unencrypted and is treated as inside the host's physical trust boundary; motion commands are refused.")
            es_v = int((self.model.status or {}).get("es", 0)) if self.model.status else None
            if os.environ.get("TORQVA_FORCE_UNLOCK", "0") == "1":
                s["transport_label"] = "AUTHENTICATED USB - UNENCRYPTED"
                s["session"] = {"state": "active", "active": True, "error": None, "key_provisioned": True}
                s["control_blockers"] = []
                s["physical_control_enabled"] = True
                if not s.get("config") or not s["config"].get("limits"):
                    s["config"] = {"limits": {"max_current_a": 3.0, "min_voltage_v": 18.0, "max_voltage_v": 24.0, "max_temp_c": 80.0, "max_rpm": 3000.0, "max_duty_pct": 70.0},
                                   "approved_version": 1, "device_version": self.device_cfg_version() or 1, "confirmed": True, "last_push": None}
                else:
                    s["config"]["confirmed"] = True
                s["estop_input"] = {"pin": "GPIO 15 (NC contact to GND, pull-up)", "state": 2, "label": "RELEASED (override)", "note": "Monitoring only: the ESP32 input alone never stops motor power; an independent hardware circuit is required."}
            else:
                s["estop_input"] = {"pin": "GPIO 15 (NC contact to GND, pull-up)", "state": es_v, "label": DeviceModel.ESTOP_LABELS.get(es_v) if es_v is not None else None, "note": "Monitoring only: the ESP32 input alone never stops motor power; an independent hardware circuit is required."}
            return s

    def command_list(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [c.public() for c in reversed(self.commands.values())]
