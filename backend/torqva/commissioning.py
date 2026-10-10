"""Commissioning record for physical motor control: human attestations with evidence, approved limits, and the explicit enable decision.

This is a RECORD of human decisions, not a measurement: software cannot verify an E-stop circuit, pull-downs or wiring. An attestation never overrides the firmware: the firmware's own
interlocks (reported in `blk`) and the missing secure session still refuse motion. Nothing here is a bypass; every write is admin-only, audited and needs written evidence.
Nothing is ever invented: with no record, every item is NOT VERIFIED, no limit is approved and physical control is disabled.
"""
from __future__ import annotations

import json
import math
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

STATUSES = ("VERIFIED", "NOT VERIFIED", "BLOCKED")
ITEMS = [
    ("board_identity", "Board model and revision confirmed (module marking, chip_id / flash_id)"),
    ("gpio38", "GPIO 38 checked against the on-board RGB LED for this board revision"),
    ("wiring", "All sensor, OLED, LED, buzzer and driver wiring confirmed against pinmap.h"),
    ("logic_levels", "Common ground and 3.3 V logic compatibility confirmed"),
    ("psu_ratings", "Supply, driver and motor ratings reviewed (current, voltage, thermal)"),
    ("estop", "Independent hardware emergency stop installed and tested (cuts motor power without software)"),
    ("driver_default_off", "Driver enable and PWM lines measured OFF across reset and brown-out (pull-downs)"),
    ("watchdog", "Watchdog timeout approved and tested on the target"),
]
# Absolute ceilings are this firmware's MEASUREMENT ratings (INA219 range, DS18B20 range, Hall counter), mirrored from torqva_core/runtime_config.h. They only reject nonsense: the operator
# is responsible for entering the actual motor, driver and supply ratings, and a larger number than the equipment can take is never "approved" by this software.
LIMITS = {"max_current_a": (0.0, 3.2), "min_voltage_v": (0.0, 26.0), "max_voltage_v": (0.0, 26.0), "max_temp_c": (0.0, 125.0), "max_rpm": (0.0, 30000.0), "max_duty_pct": (0.0, 100.0)}
LIMITS_CONFIRM_PHRASE = "APPROVE THESE LIMITS"
HISTORY_MAX = 50
ENABLE_PHRASE = "ENABLE PHYSICAL CONTROL"
MIN_EVIDENCE = 10


class CommissioningError(ValueError):
    pass


def _evidence(text: Any) -> str:
    if not isinstance(text, str) or len(text.strip()) < MIN_EVIDENCE or len(text) > 500:
        raise CommissioningError(f"written evidence of {MIN_EVIDENCE}-500 characters is required")
    return text.strip()


def _blank() -> Dict[str, Dict[str, Any]]:
    return {i: {"status": "NOT VERIFIED", "evidence": "", "by": None, "at": None} for i, _ in ITEMS}


class Commissioning:
    def __init__(self, path: Optional[str] = None, clock=time.time):
        self._path = Path(path) if path else None
        self._clock = clock
        self._lock = threading.RLock()
        self.items: Dict[str, Dict[str, Any]] = _blank()
        self.limits: Optional[Dict[str, Any]] = None
        self.limits_history: list = []                 # who changed what, when: previous and new values, version
        self.enable: Optional[Dict[str, Any]] = None
        self.load_error: Optional[str] = None
        self._load()

    # ---- persistence (atomic; a damaged file is reported and treated as EMPTY, never as approval)
    def _load(self) -> None:
        if not self._path or not self._path.exists():
            return
        try:
            d = json.loads(self._path.read_text(encoding="utf-8"))
            for k, v in (d.get("items") or {}).items():
                if k in self.items and v.get("status") in STATUSES:
                    self.items[k] = {"status": v["status"], "evidence": str(v.get("evidence", ""))[:500], "by": v.get("by"), "at": v.get("at")}
            lim = d.get("limits")
            if isinstance(lim, dict) and all(isinstance(lim.get(k), (int, float)) and not isinstance(lim.get(k), bool) and math.isfinite(lim[k]) and lim[k] > 0 for k in LIMITS) \
                    and lim["min_voltage_v"] < lim["max_voltage_v"] and isinstance(lim.get("version"), int) and lim["version"] >= 1:
                self.limits = dict(lim)
            h = d.get("limits_history")
            self.limits_history = [x for x in h if isinstance(x, dict)][-HISTORY_MAX:] if isinstance(h, list) else []
            self.enable = d.get("enable") if isinstance(d.get("enable"), dict) else None
            if not self._enable_allowed():
                self.enable = None                                              # a stale or inconsistent enable never survives a load
        except Exception as e:                                                  # noqa: BLE001
            self.load_error = f"commissioning file ignored: {type(e).__name__}"
            self.items, self.limits, self.enable, self.limits_history = _blank(), None, None, []

    def _save(self) -> None:
        if not self._path:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(self._path.parent), prefix=".comm-", suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"items": self.items, "limits": self.limits, "limits_history": self.limits_history, "enable": self.enable}, f, indent=1)
        os.replace(tmp, self._path)

    # ---- queries
    def _enable_allowed(self) -> bool:
        return self.limits is not None and all(v["status"] == "VERIFIED" for v in self.items.values())

    def physical_control_enabled(self) -> bool:
        with self._lock:
            return bool(self.enable and self.enable.get("enabled") and self._enable_allowed())

    def status_of(self, item_id: str) -> Dict[str, Any]:
        with self._lock:
            return dict(self.items[item_id])

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {"items": [{"id": i, "label": l, **self.items[i]} for i, l in ITEMS], "limits": dict(self.limits) if self.limits else None,
                    "limits_history": list(self.limits_history[-10:]), "limits_confirm_phrase": LIMITS_CONFIRM_PHRASE,
                    "enable": dict(self.enable) if self.enable else None, "physical_control_enabled": self.physical_control_enabled(), "enable_allowed": self._enable_allowed(),
                    "enable_phrase": ENABLE_PHRASE, "load_error": self.load_error,
                    "note": "A human record, not a measurement. It never overrides the firmware interlocks or the missing secure session."}

    # ---- writes (callers enforce admin + audit)
    def set_item(self, item_id: str, status: str, evidence: str, user: str) -> None:
        with self._lock:
            if item_id not in self.items:
                raise CommissioningError("unknown item")
            if status not in STATUSES:
                raise CommissioningError("status must be VERIFIED, NOT VERIFIED or BLOCKED")
            ev = _evidence(evidence) if status != "NOT VERIFIED" else (evidence or "").strip()[:500]
            self.items[item_id] = {"status": status, "evidence": ev, "by": user, "at": self._clock()}
            if status != "VERIFIED":
                self.enable = None                                              # any regression disables physical control
            self._save()

    def set_limits(self, limits: Dict[str, Any], evidence: str, user: str, confirm: str = "") -> None:
        """Approve operating limits. Complete, validated, explicitly confirmed, versioned and recorded (previous and new values, who, when). Nothing is defaulted."""
        with self._lock:
            if confirm != LIMITS_CONFIRM_PHRASE:
                raise CommissioningError(f"type {LIMITS_CONFIRM_PHRASE!r} to confirm the new operating limits")
            out: Dict[str, Any] = {}
            for k, (lo, hi) in LIMITS.items():
                v = limits.get(k)
                if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo < v <= hi:
                    raise CommissioningError(f"{k} must be a finite number above {lo:g} and at most {hi:g}")
                out[k] = round(float(v), 3)                                    # three decimals: exactly what the firmware reproduces when it checks the message authentication code
            if out["min_voltage_v"] >= out["max_voltage_v"]:
                raise CommissioningError("min_voltage_v must be below max_voltage_v")
            prev = self.limits
            ver = (prev["version"] + 1) if prev else 1
            at = self._clock()
            out.update({"version": ver, "evidence": _evidence(evidence), "by": user, "at": at})
            self.limits = out
            keys = list(LIMITS)
            self.limits_history.append({"version": ver, "by": user, "at": at, "previous": {k: prev[k] for k in keys} if prev else None, "new": {k: out[k] for k in keys}, "evidence": out["evidence"]})
            self.limits_history = self.limits_history[-HISTORY_MAX:]
            self.enable = None                                                  # changed limits need a fresh explicit enable
            self._save()

    def set_enable(self, enabled: bool, phrase: str, user: str) -> None:
        with self._lock:
            if not enabled:
                self.enable = None
                self._save()
                return
            if phrase != ENABLE_PHRASE:
                raise CommissioningError(f"type {ENABLE_PHRASE!r} to confirm")
            if not self._enable_allowed():
                raise CommissioningError("every checklist item must be VERIFIED and the limits approved first")
            self.enable = {"enabled": True, "by": user, "at": self._clock()}
            self._save()
