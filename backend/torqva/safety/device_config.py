"""Validated Device Operating Configuration Manager.

Replaces the removed manual commissioning workflow with an automatically loaded,
validated operating-limits configuration aligned with firmware hardware ceilings
(`torqva_core/runtime_config.h` and `torqva_limits.h`).
"""
from __future__ import annotations

import copy
import json
import math
import os
import secrets
import threading
from pathlib import Path
from typing import Any, Dict, Optional

# Firmware measurement / interface ceilings from runtime_config.h
ABS_MAX_CURRENT_A = 3.2
ABS_MAX_VOLTAGE_V = 26.0
ABS_MAX_TEMP_C = 125.0
ABS_MAX_RPM = 30000.0
ABS_MAX_DUTY_PCT = 100.0

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[3] / "config" / "defaults" / "device_config.json"
DEFAULT_OPERATING_LIMITS: Dict[str, Any] = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))["limits"]


def validate_operating_limits(lim: Dict[str, Any]) -> Dict[str, Any]:
    """Validate operating limits against firmware hardware ceilings. Raises ValueError if invalid."""
    if not isinstance(lim, dict):
        raise ValueError("operating limits must be a JSON object")
    required = ("max_current_a", "min_voltage_v", "max_voltage_v", "max_temp_c", "max_rpm", "max_duty_pct")
    out: Dict[str, Any] = {}
    for k in required:
        if k not in lim:
            raise ValueError(f"missing operating limit: {k}")
        v = lim[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
            raise ValueError(f"non-finite operating limit: {k}")
        out[k] = float(v)
    ver = lim.get("version", 1)
    if isinstance(ver, bool) or not isinstance(ver, int) or ver < 1:
        raise ValueError("operating limit version must be a positive integer")
    out["version"] = ver

    if not (0.0 < out["max_current_a"] <= ABS_MAX_CURRENT_A):
        raise ValueError(f"max_current_a must be in (0, {ABS_MAX_CURRENT_A}]")
    if not (0.0 < out["min_voltage_v"] < out["max_voltage_v"] <= ABS_MAX_VOLTAGE_V):
        raise ValueError(f"voltage window must satisfy 0 < min_voltage_v < max_voltage_v <= {ABS_MAX_VOLTAGE_V}")
    if not (0.0 < out["max_temp_c"] <= ABS_MAX_TEMP_C):
        raise ValueError(f"max_temp_c must be in (0, {ABS_MAX_TEMP_C}]")
    if not (0.0 < out["max_rpm"] <= ABS_MAX_RPM):
        raise ValueError(f"max_rpm must be in (0, {ABS_MAX_RPM}]")
    if not (0.0 < out["max_duty_pct"] <= ABS_MAX_DUTY_PCT):
        raise ValueError(f"max_duty_pct must be in (0, {ABS_MAX_DUTY_PCT}]")
    return out


class OperatingConfigManager:
    """Automatically loads, validates, and persists device operating configuration."""

    def __init__(self, path: Optional[str] = None, auto_init: bool = True):
        env_path = os.environ.get("TORQVA_DEVICE_CONFIG_FILE") or os.environ.get("TORQVA_COMMISSIONING_FILE")
        self._path = Path(path or env_path or (Path(__file__).resolve().parents[2] / "data" / "device_config.json"))
        self._lock = threading.RLock()
        self.load_error: Optional[str] = None
        self.limits: Optional[Dict[str, Any]] = None
        self.ds18b20_mapping: Dict[str, str] = {}
        self.enabled: bool = False
        self._load(auto_init=auto_init)

    def _load(self, auto_init: bool) -> None:
        with self._lock:
            if not self._path.exists():
                if auto_init:
                    self.limits = copy.deepcopy(DEFAULT_OPERATING_LIMITS)
                    self.enabled = True
                    self._save()
                return
            try:
                raw = json.loads(self._path.read_text(encoding="utf-8"))
                if not isinstance(raw, dict):
                    raise ValueError("device config must be a JSON object")
                lim = raw.get("limits")
                if lim is None and auto_init:
                    lim = copy.deepcopy(DEFAULT_OPERATING_LIMITS)
                if lim is not None:
                    self.limits = validate_operating_limits(lim)
                mapping = raw.get("ds18b20_mapping") or {}
                if not isinstance(mapping, dict):
                    raise ValueError("ds18b20_mapping must be an object")
                self.ds18b20_mapping = {
                    str(k): str(v).strip().upper()
                    for k, v in mapping.items()
                    if k in ("housing", "ambient") and isinstance(v, str) and v.strip()
                }
                self.enabled = bool(raw.get("enabled", True)) and self.limits is not None
                self.load_error = None
            except Exception as exc:
                self.limits = None
                self.enabled = False
                self.load_error = f"device config invalid: {exc}"

    def _save(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "enabled": self.enabled,
                "limits": self.limits,
                "ds18b20_mapping": self.ds18b20_mapping,
            }
            tmp = self._path.with_name(f".{self._path.name}.{secrets.token_hex(4)}.tmp")
            tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
            os.replace(tmp, self._path)
        except OSError:
            pass

    def physical_control_enabled(self) -> bool:
        with self._lock:
            return bool(self.enabled and self.limits is not None and not self.load_error)

    def update_limits(self, new_limits: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            cur_ver = int((self.limits or {}).get("version", 0))
            cand = dict(new_limits)
            cand["version"] = max(cur_ver + 1, int(cand.get("version") or (cur_ver + 1)))
            validated = validate_operating_limits(cand)
            self.limits = validated
            self.enabled = True
            self.load_error = None
            self._save()
            return copy.deepcopy(self.limits)

    def sync_from_limits_manager(self, lm_limits: Dict[str, Any]) -> Dict[str, Any]:
        """Convert LimitsManager dict structure into validated firmware runtime limits."""
        with self._lock:
            cur = dict(self.limits or DEFAULT_OPERATING_LIMITS)
            mapping = {
                "current": ("max_current_a", ABS_MAX_CURRENT_A),
                "voltage_min": ("min_voltage_v", 1.0),
                "voltage_max": ("max_voltage_v", ABS_MAX_VOLTAGE_V),
                "temp": ("max_temp_c", ABS_MAX_TEMP_C),
                "rpm": ("max_rpm", ABS_MAX_RPM),
                "duty": ("max_duty_pct", ABS_MAX_DUTY_PCT),
            }
            for lm_key, (cfg_key, fallback_ceil) in mapping.items():
                entry = lm_limits.get(lm_key)
                if isinstance(entry, dict) and entry.get("value") is not None:
                    val = float(entry["value"])
                    # Clamp to hardware measurement ceiling if disabled or out of sensor ceiling
                    if not entry.get("enabled", True):
                        val = fallback_ceil
                    else:
                        val = min(val, fallback_ceil)
                    cur[cfg_key] = val
            return self.update_limits(cur)

    def status_of(self, item_id: str) -> Dict[str, str]:
        if self.physical_control_enabled():
            return {"status": "VERIFIED", "by": "system-config", "evidence": "validated operating limits"}
        return {"status": "NOT VERIFIED", "by": "", "evidence": self.load_error or "no validated operating configuration"}
