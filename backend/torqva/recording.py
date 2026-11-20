"""TORQVA Telemetry & Event Session Recorder.

Records live physical and simulated telemetry to disk in crash-safe CSV format.
Sessions are stored under `sessions/<date_mode>/` containing:
- readings.csv: time_s, signals with units in headers, and explicit per-value quality flags
- events.csv: timestamps, event categories, severity levels, and details
- session.json: session metadata, config snapshot, and SHA-256 checksums of CSV files.

Auto-starts on first motor drive command or via explicit operator start.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


READINGS_HEADER = [
    "time_s",
    "rpm[rpm]",
    "rpm_valid",
    "current[A]",
    "current_valid",
    "voltage[V]",
    "voltage_valid",
    "power[W]",
    "power_valid",
    "housing_temp[C]",
    "housing_temp_valid",
    "ambient_temp[C]",
    "ambient_temp_valid",
    "duty[%]",
    "duty_valid",
    "vib_rms[g]",
    "vib_rms_valid",
    "score",
    "score_status",
]

EVENTS_HEADER = [
    "time_s",
    "timestamp_iso",
    "event_type",
    "level",
    "details",
]


def _sha256_file(path: Path) -> str:
    if not path.is_file():
        return ""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


class SessionRecorder:
    def __init__(self, base_dir: Path | str = "sessions") -> None:
        self.base_dir = Path(base_dir)
        self.active_session_id: Optional[str] = None
        self.active_mode: Optional[str] = None
        self.active_dir: Optional[Path] = None
        self.start_wall: Optional[float] = None
        self.config_snapshot: Dict[str, Any] = {}
        self._readings_file = None
        self._readings_writer = None
        self._events_file = None
        self._events_writer = None
        self.sample_count: int = 0
        self.event_count: int = 0

    def is_active(self) -> bool:
        return self.active_session_id is not None

    def start_session(self, mode: str, config: Optional[Dict[str, Any]] = None, trigger: str = "manual") -> str:
        """Start a new recording session."""
        if self.is_active():
            self.stop_session()

        mode_clean = mode.lower()
        now = datetime.now(timezone.utc)
        date_str = now.strftime("%Y%m%d_%H%M%S")
        session_id = f"{date_str}_{mode_clean}"
        session_dir = self.base_dir / session_id
        session_dir.mkdir(parents=True, exist_ok=True)

        self.active_session_id = session_id
        self.active_mode = mode.upper()
        self.active_dir = session_dir
        self.start_wall = time.time()
        self.config_snapshot = config or {}
        self.sample_count = 0
        self.event_count = 0

        # Open readings.csv (crash-safe flush on row)
        readings_path = session_dir / "readings.csv"
        self._readings_file = open(readings_path, "w", newline="", encoding="utf-8")
        self._readings_writer = csv.writer(self._readings_file)
        self._readings_writer.writerow(READINGS_HEADER)
        self._readings_file.flush()
        os.fsync(self._readings_file.fileno())

        # Open events.csv
        events_path = session_dir / "events.csv"
        self._events_file = open(events_path, "w", newline="", encoding="utf-8")
        self._events_writer = csv.writer(self._events_file)
        self._events_writer.writerow(EVENTS_HEADER)
        self._events_file.flush()
        os.fsync(self._events_file.fileno())

        # Write initial session.json
        meta = {
            "session_id": session_id,
            "mode": self.active_mode,
            "started_at_iso": now.isoformat(),
            "started_at_unix": self.start_wall,
            "stopped_at_iso": None,
            "stopped_at_unix": None,
            "trigger": trigger,
            "config_snapshot": self.config_snapshot,
            "sample_count": 0,
            "event_count": 0,
            "duration_s": 0.0,
            "checksums": {},
        }
        self._save_meta(meta)

        self.record_event("SESSION_START", "INFO", f"Recording session started in {self.active_mode} mode (trigger: {trigger})")
        return session_id

    def record_reading(self, reading: Dict[str, Any]) -> None:
        """Write one telemetry row with explicit quality flags."""
        if not self.is_active() or self._readings_writer is None:
            return

        t = reading.get("t")
        if t is None:
            t = time.time() - (self.start_wall or time.time())
        t_fmt = f"{float(t):.3f}"

        def get_val(key: str, valid_key: Optional[str] = None) -> tuple[str, str]:
            # Returns (value_str, valid_str)
            raw = reading.get(key)
            if isinstance(raw, dict):
                val = raw.get("value")
                valid = bool(raw.get("valid", True))
            else:
                val = raw
                if valid_key and valid_key in reading:
                    valid = bool(reading[valid_key])
                else:
                    valid = val is not None

            if val is None or not valid:
                return ("", "0")
            try:
                f_val = float(val)
                if key in ("current", "power", "vib_rms"):
                    v_str = f"{f_val:.3f}"
                elif key in ("voltage", "housing", "ambient", "duty"):
                    v_str = f"{f_val:.2f}"
                elif key == "rpm":
                    v_str = f"{f_val:.1f}"
                else:
                    v_str = f"{f_val:.2f}"
                return (v_str, "1")
            except (ValueError, TypeError):
                return ("", "0")

        rpm_v, rpm_q = get_val("rpm", "rpm_valid")
        cur_v, cur_q = get_val("current", "current_valid")
        volt_v, volt_q = get_val("voltage", "voltage_valid")
        pwr_v, pwr_q = get_val("power", "power_valid")
        temp_v, temp_q = get_val("housing", "housing_valid")
        amb_v, amb_q = get_val("ambient", "ambient_valid")
        duty_v, duty_q = get_val("duty", "duty_valid")
        vib_v, vib_q = get_val("vib_rms", "vib_rms_valid")

        score = reading.get("score")
        score_str = f"{float(score):.3f}" if score is not None else ""
        score_status = str(reading.get("score_status") or "")

        row = [
            t_fmt,
            rpm_v, rpm_q,
            cur_v, cur_q,
            volt_v, volt_q,
            pwr_v, pwr_q,
            temp_v, temp_q,
            amb_v, amb_q,
            duty_v, duty_q,
            vib_v, vib_q,
            score_str,
            score_status,
        ]

        self._readings_writer.writerow(row)
        self.sample_count += 1
        # Crash-safe flush
        self._readings_file.flush()
        try:
            os.fsync(self._readings_file.fileno())
        except OSError:
            pass

    def record_event(self, event_type: str, level: str, details: str) -> None:
        """Write one event record to events.csv."""
        if not self.is_active() or self._events_writer is None:
            return

        now = time.time()
        t = now - (self.start_wall or now)
        iso = datetime.now(timezone.utc).isoformat()

        self._events_writer.writerow([f"{t:.3f}", iso, event_type, level, details])
        self.event_count += 1
        self._events_file.flush()
        try:
            os.fsync(self._events_file.fileno())
        except OSError:
            pass

    def notify_drive_command(self, mode: str, action: str, params: Dict[str, Any], config: Optional[Dict[str, Any]] = None) -> None:
        """Auto-start recording on the first drive command if not already recording."""
        if action in ("START", "SET_SPEED"):
            # Check if non-zero drive requested
            duty = params.get("duty_pct", params.get("duty", 0))
            rpm = params.get("rpm", params.get("target_rpm", 0))
            if float(duty or 0) > 0 or float(rpm or 0) > 0:
                if not self.is_active():
                    self.start_session(mode, config=config, trigger="drive_command")
                self.record_event("DRIVE_COMMAND", "COMMAND", f"Action: {action}, duty: {duty}%, rpm: {rpm}")

    def stop_session(self) -> Optional[Dict[str, Any]]:
        """Stop active session and finalize SHA-256 checksums in session.json."""
        if not self.is_active():
            return None

        self.record_event("SESSION_STOP", "INFO", "Recording session stopped by operator or system")

        if self._readings_file:
            self._readings_file.flush()
            self._readings_file.close()
            self._readings_file = None

        if self._events_file:
            self._events_file.flush()
            self._events_file.close()
            self._events_file = None

        now = datetime.now(timezone.utc)
        stopped_wall = time.time()
        duration_s = max(0.0, stopped_wall - (self.start_wall or stopped_wall))

        readings_path = self.active_dir / "readings.csv"
        events_path = self.active_dir / "events.csv"

        checksums = {
            "readings_sha256": _sha256_file(readings_path),
            "events_sha256": _sha256_file(events_path),
        }

        meta = {
            "session_id": self.active_session_id,
            "mode": self.active_mode,
            "started_at_iso": datetime.fromtimestamp(self.start_wall or stopped_wall, timezone.utc).isoformat(),
            "started_at_unix": self.start_wall,
            "stopped_at_iso": now.isoformat(),
            "stopped_at_unix": stopped_wall,
            "config_snapshot": self.config_snapshot,
            "sample_count": self.sample_count,
            "event_count": self.event_count,
            "duration_s": round(duration_s, 2),
            "checksums": checksums,
        }
        self._save_meta(meta)

        out = dict(meta)
        self.active_session_id = None
        self.active_mode = None
        self.active_dir = None
        self.start_wall = None
        self.sample_count = 0
        self.event_count = 0
        return out

    def get_status(self) -> Dict[str, Any]:
        """Return live recording status for the UI recording dot."""
        if not self.is_active():
            return {
                "active": False,
                "session_id": None,
                "mode": None,
                "duration_s": 0.0,
                "sample_count": 0,
                "event_count": 0,
            }
        dur = time.time() - (self.start_wall or time.time())
        return {
            "active": True,
            "session_id": self.active_session_id,
            "mode": self.active_mode,
            "duration_s": round(dur, 1),
            "sample_count": self.sample_count,
            "event_count": self.event_count,
        }

    def list_sessions(self) -> List[Dict[str, Any]]:
        """List all completed and active sessions."""
        if not self.base_dir.exists():
            return []
        sessions = []
        for path in sorted(self.base_dir.iterdir(), reverse=True):
            if path.is_dir():
                meta_path = path / "session.json"
                if meta_path.is_file():
                    try:
                        with open(meta_path, "r", encoding="utf-8") as f:
                            meta = json.load(f)
                        sessions.append(meta)
                    except Exception:
                        pass
        return sessions

    def get_session_meta(self, session_id: str) -> Optional[Dict[str, Any]]:
        meta_path = self.base_dir / session_id / "session.json"
        if not meta_path.is_file():
            return None
        with open(meta_path, "r", encoding="utf-8") as f:
            return json.load(f)

    def get_session_summary(self, session_id: Optional[str] = None) -> Dict[str, Any]:
        """Compute summary metrics (duration, peak rpm, peak current, max temp, data-quality %)."""
        sid = session_id or self.active_session_id
        if not sid:
            return {
                "duration_s": 0.0,
                "peak_rpm": 0.0,
                "peak_current_a": 0.0,
                "max_temp_c": 0.0,
                "data_quality_pct": 100.0,
                "sample_count": 0,
            }

        session_dir = self.base_dir / sid
        readings_path = session_dir / "readings.csv"
        if not readings_path.is_file():
            return {
                "duration_s": 0.0,
                "peak_rpm": 0.0,
                "peak_current_a": 0.0,
                "max_temp_c": 0.0,
                "data_quality_pct": 100.0,
                "sample_count": 0,
            }

        # Flush if active
        if self.active_session_id == sid and self._readings_file:
            self._readings_file.flush()

        peak_rpm = 0.0
        peak_current = 0.0
        max_temp = 0.0
        total_fields_checked = 0
        valid_fields_count = 0
        first_t = None
        last_t = None
        count = 0

        with open(readings_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                count += 1
                try:
                    t_val = float(row.get("time_s", 0))
                    if first_t is None:
                        first_t = t_val
                    last_t = t_val
                except (ValueError, TypeError):
                    pass

                # RPM
                rpm_q = row.get("rpm_valid") == "1"
                total_fields_checked += 1
                if rpm_q:
                    valid_fields_count += 1
                    try:
                        peak_rpm = max(peak_rpm, float(row.get("rpm[rpm]", 0)))
                    except (ValueError, TypeError):
                        pass

                # Current
                cur_q = row.get("current_valid") == "1"
                total_fields_checked += 1
                if cur_q:
                    valid_fields_count += 1
                    try:
                        peak_current = max(peak_current, float(row.get("current[A]", 0)))
                    except (ValueError, TypeError):
                        pass

                # Temp
                temp_q = row.get("housing_temp_valid") == "1"
                total_fields_checked += 1
                if temp_q:
                    valid_fields_count += 1
                    try:
                        max_temp = max(max_temp, float(row.get("housing_temp[C]", 0)))
                    except (ValueError, TypeError):
                        pass

                # Voltage
                total_fields_checked += 1
                if row.get("voltage_valid") == "1":
                    valid_fields_count += 1

        dur = (last_t - first_t) if (first_t is not None and last_t is not None and last_t >= first_t) else 0.0
        quality_pct = (valid_fields_count / total_fields_checked * 100.0) if total_fields_checked > 0 else 100.0

        return {
            "session_id": sid,
            "duration_s": round(dur, 1),
            "peak_rpm": round(peak_rpm, 1),
            "peak_current_a": round(peak_current, 3),
            "max_temp_c": round(max_temp, 1),
            "data_quality_pct": round(quality_pct, 1),
            "sample_count": count,
        }

    def export_session_zip(self, session_id: str) -> Optional[bytes]:
        """Bundle readings.csv, events.csv, session.json and checksums.sha256 into a zip."""
        session_dir = self.base_dir / session_id
        if not session_dir.is_dir():
            return None

        # Ensure active session files flushed
        if self.active_session_id == session_id:
            if self._readings_file:
                self._readings_file.flush()
            if self._events_file:
                self._events_file.flush()

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
            for fname in ("readings.csv", "events.csv", "session.json", "report.html"):
                fpath = session_dir / fname
                if fpath.is_file():
                    z.write(fpath, arcname=fname)

            # Add explicit checksums.sha256 file
            checksum_lines = []
            for fname in ("readings.csv", "events.csv", "session.json"):
                fpath = session_dir / fname
                if fpath.is_file():
                    checksum_lines.append(f"{_sha256_file(fpath)}  {fname}")
            z.writestr("checksums.sha256", "\n".join(checksum_lines) + "\n")

        buf.seek(0)
        return buf.getvalue()

    def _save_meta(self, meta: Dict[str, Any]) -> None:
        if not self.active_dir:
            return
        meta_path = self.active_dir / "session.json"
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2)


# Global singleton instance
recorder = SessionRecorder()
