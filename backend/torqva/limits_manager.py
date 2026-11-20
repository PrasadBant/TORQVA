"""TORQVA Limits Manager.

Centralized configuration source for all operational and safety limits.
Defaults align with `torqva_limits.h`.
Every limit can be independently enabled (ON) or disabled (OFF) and edited.
Maintains an immutable in-memory change log with timestamps and user attestation.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


DEFAULT_LIMITS_CONFIG = {
    "duty": {
        "name": "Max Duty Cycle",
        "description": "Absolute motor PWM drive duty limit",
        "unit": "%",
        "value": 70.0,
        "default": 70.0,
        "enabled": True,
        "min": 0.0,
        "max": 100.0,
    },
    "rpm": {
        "name": "Max Speed Setpoint",
        "description": "Maximum closed-loop target speed ceiling",
        "unit": "rpm",
        "value": 3000.0,
        "default": 3000.0,
        "enabled": True,
        "min": 0.0,
        "max": 20000.0,
    },
    "current": {
        "name": "Sustained Over-Current",
        "description": "Continuous motor current trip threshold",
        "unit": "A",
        "value": 4.0,
        "default": 4.0,
        "enabled": True,
        "min": 0.1,
        "max": 50.0,
    },
    "temp": {
        "name": "Housing Temperature Stop",
        "description": "Emergency thermal trip threshold",
        "unit": "°C",
        "value": 60.0,
        "default": 60.0,
        "enabled": True,
        "min": 20.0,
        "max": 120.0,
    },
    "voltage_min": {
        "name": "Minimum DC Bus Voltage",
        "description": "Low supply voltage trip",
        "unit": "V",
        "value": 20.0,
        "default": 20.0,
        "enabled": True,
        "min": 0.0,
        "max": 50.0,
    },
    "voltage_max": {
        "name": "Maximum DC Bus Voltage",
        "description": "High supply voltage trip",
        "unit": "V",
        "value": 25.5,
        "default": 25.5,
        "enabled": True,
        "min": 0.0,
        "max": 50.0,
    },
    "rpm_loss": {
        "name": "RPM Loss Stall Timeout",
        "description": "Stall or sensor disconnect duration before trip",
        "unit": "ms",
        "value": 1000.0,
        "default": 1000.0,
        "enabled": True,
        "min": 100.0,
        "max": 10000.0,
    },
    "heartbeat": {
        "name": "Heartbeat Timeout",
        "description": "Host-device communication dead-man timeout",
        "unit": "ms",
        "value": 2000.0,
        "default": 2000.0,
        "enabled": True,
        "min": 200.0,
        "max": 10000.0,
    },
}


class LimitsManager:
    def __init__(self) -> None:
        self._limits: Dict[str, Dict[str, Any]] = copy.deepcopy(DEFAULT_LIMITS_CONFIG)
        self._change_log: List[Dict[str, Any]] = []

    def get_limits(self) -> Dict[str, Any]:
        return {
            "limits": copy.deepcopy(self._limits),
            "change_log": list(self._change_log),
        }

    def update_limit(
        self,
        key: str,
        value: Optional[float] = None,
        enabled: Optional[bool] = None,
        user: str = "operator",
    ) -> Dict[str, Any]:
        if key not in self._limits:
            raise KeyError(f"Unknown limit parameter '{key}'")

        param = self._limits[key]
        old_val = param["value"]
        old_en = param["enabled"]

        if value is not None:
            f_val = float(value)
            if f_val < param["min"] or f_val > param["max"]:
                raise ValueError(f"{param['name']} must be between {param['min']} and {param['max']} {param['unit']}")
            param["value"] = f_val

        if enabled is not None:
            param["enabled"] = bool(enabled)

        # Log change if state changed
        if param["value"] != old_val or param["enabled"] != old_en:
            entry = {
                "timestamp_iso": datetime.now(timezone.utc).isoformat(),
                "user": user,
                "param": key,
                "param_name": param["name"],
                "old_value": old_val,
                "new_value": param["value"],
                "old_enabled": old_en,
                "new_enabled": param["enabled"],
                "unit": param["unit"],
            }
            self._change_log.append(entry)

        return copy.deepcopy(param)

    def reset_defaults(self, user: str = "operator") -> Dict[str, Any]:
        old = copy.deepcopy(self._limits)
        self._limits = copy.deepcopy(DEFAULT_LIMITS_CONFIG)
        self._change_log.append({
            "timestamp_iso": datetime.now(timezone.utc).isoformat(),
            "user": user,
            "param": "ALL",
            "param_name": "Reset to Defaults (torqva_limits.h)",
            "old_value": None,
            "new_value": None,
            "old_enabled": None,
            "new_enabled": None,
            "unit": "",
        })
        return self.get_limits()


# Global limits manager instance
limits_mgr = LimitsManager()
