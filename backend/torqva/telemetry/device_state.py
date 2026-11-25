"""Device-reported measurements, validity, history and freshness."""

import collections
import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Deque, Dict, List, Optional

from torqva.device.transport import ERROR_HELP
from torqva.device.wire_protocol import Q_BITS, UINT32
from torqva.telemetry.recording import recorder

HISTORY_SAMPLES = 3600                       # 10 Hz -> 6 minutes; bounded memory
STALE_AFTER_S = 2.0                          # no fast frame for this long -> telemetry is stale (never presented as live)
LEGACY_MARKERS = ("OVERALL CONDITION", "[TCP", "[MOTOR]", "BTS7960", "Smart DC Motor", "BUZZER ")


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
    last_stop_reason: Optional[str] = None
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
        self.last_stop_reason = None
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
            self.last_stop_reason = f.get("stop_reason")
            rpm_raw = f.get("rpm")
            rpm_valid = bool(q & Q_BITS["rpm"]) and rpm_raw is not None and math.isfinite(rpm_raw) and (0.0 <= rpm_raw <= 30000.0)
            self._set("rpm", float(rpm_raw) if rpm_valid else None, rpm_valid, ts, now)

            curr_raw = f.get("i")
            curr_valid = bool(q & Q_BITS["current"]) and curr_raw is not None and math.isfinite(curr_raw) and (-1.0 <= curr_raw <= 40.0)
            self._set("current", float(curr_raw) if curr_valid else None, curr_valid, ts, now)

            volt_raw = f.get("v")
            volt_valid = bool(q & Q_BITS["voltage"]) and volt_raw is not None and math.isfinite(volt_raw) and (0.0 <= volt_raw <= 60.0)
            self._set("voltage", float(volt_raw) if volt_valid else None, volt_valid, ts, now)

            if curr_valid and volt_valid:
                p_val = round(float(volt_raw) * float(curr_raw), 2)
                self._set("power", p_val, True, ts, now)
            else:
                self._set("power", None, False, ts, now)

            self.values["duty"] = {"value": f["duty"], "valid": True, "device_ts_ms": ts, "received_at": now, "origin": "device_command_state"}
            self.values["setpoint"] = {"value": f["sp"], "valid": True, "device_ts_ms": ts, "received_at": now, "origin": "device_command_state"}
            for key in ("pwm_req", "ramp_up", "ramp_down"):
                self.values[key] = {"value": f.get(key), "valid": key in f, "device_ts_ms": ts, "received_at": now, "origin": "device_command_state"}
            self.history.append({"t": wall, "device_ts_ms": ts, **{k: (self.values[k]["value"]) for k in ("rpm", "current", "voltage", "power", "duty", "setpoint")},
                                 "housing": (self.values.get("housing") or {}).get("value")})
            recorder.record_reading({"t": wall, **self.values})
        elif f["t"] == "accel":
            ok = f["ok"] == 1
            mag_raw = f.get("mag")
            mag_valid = ok and mag_raw is not None and math.isfinite(mag_raw) and (0.0 <= mag_raw <= 50.0)
            self.accel = {"valid": mag_valid, "x_g": f.get("ax") if mag_valid else None, "y_g": f.get("ay") if mag_valid else None, "z_g": f.get("az") if mag_valid else None,
                          "magnitude_g": float(mag_raw) if mag_valid else None, "received_at": now, "received_unix": wall, "device_ts_ms": f["ts"]}
            self.accel_history.append((wall, float(mag_raw) if mag_valid else None))
        elif f["t"] == "slow":
            h_raw = f.get("housing")
            h_valid = bool(q & Q_BITS["housing"]) and h_raw is not None and math.isfinite(h_raw) and (-40.0 <= h_raw <= 180.0)
            self._set("housing", float(h_raw) if h_valid else None, h_valid, f["ts"], now)

            amb_raw = f.get("ambient")
            amb_ok = bool(q & Q_BITS["ambient"]) and amb_raw is not None and math.isfinite(amb_raw) and (-40.0 <= amb_raw <= 100.0)
            if amb_ok:
                self._set("ambient", float(amb_raw), True, f["ts"], now)
            else:
                self.values["ambient"] = {
                    "value": None, "valid": False, "device_ts_ms": f["ts"],
                    "received_at": now, "received_unix": self._rx_wall,
                    "origin": "unavailable", "note": "Optional secondary ambient probe not fitted"
                }
        elif f["t"] == "status":
            self.status = f
            if self.expected_device_id is not None and f.get("dev") != self.expected_device_id:
                self.identity = "mismatch"
            elif self.expected_device_id is not None:
                self.identity = "verified"
            else:
                self.identity = "unverified"
            if f.get("dev") in ("", "UNPROVISIONED") and self.identity == "verified":
                self.identity = "unverified"
        return ev

    def freshness(self, now: float) -> Dict[str, Any]:
        age = None if self.last_fast_rx is None else now - self.last_fast_rx
        return {"fresh": age is not None and age <= STALE_AFTER_S, "age_s": age}

    def snapshot(self, now: float) -> Dict[str, Any]:
        fr = self.freshness(now)
        vals = {}
        for k in ("rpm", "current", "voltage", "power", "housing", "ambient", "duty", "setpoint", "pwm_req", "ramp_up", "ramp_down"):
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
                "drive": st.get("drive"), "stop_reason": self.last_stop_reason if fr["fresh"] else None, "hb_age_ms": st.get("hb_age"), "control_enabled_in_firmware": None if not st else bool(st.get("ctl")), "start_blocked_reason": st.get("blk"),
                "telemetry_fresh": fr["fresh"], "telemetry_age_s": fr["age_s"], "last_rx_unix": self.last_rx_wall, "values": vals, "counters": dict(self.counters), "last_error": self.last_error, "error": self.error_info(),
                "port": self.port, "state_label": self.state_label(handshake, physical), "sensor_status": self.sensor_status(now),
                "direct_mode": False}

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
            out[k] = "unavailable" if (v is None or v.get("origin") == "unavailable") else ("stale" if old else ("valid" if v["valid"] else "invalid"))
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
            steps.append("Moving the board to the supported TORQVA firmware (firmware) is a deliberate human decision; TORQVA never flashes firmware.")
        return {"code": self.last_error_code, "message": summary, "detail": self.last_error_detail or self.last_error, "recovery": steps}

    def history_series(self, signal: str, seconds: float, wall_now: float) -> List[List[Any]]:
        if signal == "acceleration":
            pts = [[t, m] for t, m in self.accel_history if t >= wall_now - seconds]       # total magnitude (g, gravity included); None = invalid
            if len(pts) > 400:
                from torqva.telemetry.decimation import decimate_min_max
                return decimate_min_max(pts, max_points=400)
            return pts
        if signal not in ("rpm", "current", "voltage", "power", "duty", "housing"):
            raise ValueError("unsupported signal")
        lo = wall_now - seconds
        pts = [[h["t"], h.get(signal)] for h in self.history if h["t"] >= lo]          # None = invalid reading: a gap in the chart, never a zero
        if len(pts) > 400:
            from torqva.telemetry.decimation import decimate_min_max
            return decimate_min_max(pts, max_points=400)
        return pts


# --------------------------------------------------------------------------------------------------------------- command lifecycle
