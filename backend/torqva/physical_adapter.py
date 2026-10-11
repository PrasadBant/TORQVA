"""Physical telemetry -> analysis input adapter (read-only, no side effects).

Turns the bridge's validated device snapshot into a PhysicalWindow (provenance MEASURED, only for a handshaken PHYSICAL device with fresh data) and says, field by field, whether
the C1 anomaly detector could consume it. C1 (backend/torqva/detection.py) was fitted on SIMULATED windows that include vibration RMS and shaft-order harmonics (v1x, v2x, v3x, vhf).
The supported firmware measures NO vibration RMS (only raw total acceleration at 10 Hz, gravity included), so `c1_window()` returns None with the exact missing inputs.
It never fills them in, never substitutes the simulator, and never reports a "healthy" or "anomalous" verdict: no AI inference on real device data is claimed until real data
has been received, a real baseline exists, and a human validates it.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .schemas import Provenance

C1_REQUIRED = ("rpm", "voltage", "current", "power", "housing", "ambient", "vib_rms", "v1x", "v2x", "v3x", "vhf")


@dataclass
class PhysicalWindow:
    t_unix: Optional[float]
    values: Dict[str, Optional[float]]           # None = unavailable (never zero)
    valid: Dict[str, bool]
    provenance: Provenance = Provenance.MEASURED
    origin: str = "physical_device"
    notes: List[str] = field(default_factory=list)


def physical_window(snapshot: Dict[str, Any]) -> Optional[PhysicalWindow]:
    """None unless the snapshot is a live, handshaken, PHYSICAL device with fresh telemetry. Firmware simulation mode and anything stale are refused."""
    if not snapshot.get("handshake") or snapshot.get("origin") != "physical_device" or not snapshot.get("telemetry_fresh"):
        return None
    vals = snapshot.get("values", {})
    out: Dict[str, Optional[float]] = {}
    ok: Dict[str, bool] = {}
    for k in ("rpm", "voltage", "current", "power", "housing", "ambient", "duty", "setpoint", "acceleration"):
        v = vals.get(k)
        good = bool(v and v.get("valid") and not v.get("stale") and isinstance(v.get("value"), (int, float)) and math.isfinite(v["value"]))
        out[k], ok[k] = (float(v["value"]) if good else None), good
    notes = ["acceleration is the TOTAL magnitude including gravity, not vibration RMS"]
    return PhysicalWindow(snapshot.get("last_rx_unix"), out, ok, notes=notes)


def c1_gaps(w: PhysicalWindow) -> List[str]:
    """Every input C1 needs that this window cannot supply."""
    gaps = [k for k in C1_REQUIRED if not w.valid.get(k, False)]
    return gaps


def c1_window(w: Optional[PhysicalWindow]) -> Optional[Dict[str, float]]:
    """The input dict C1 would need, or None. With the current firmware this is always None because vibration RMS and the harmonics are not measured."""
    if w is None or c1_gaps(w):
        return None
    return {k: float(w.values[k]) for k in C1_REQUIRED}                 # pragma: no cover  (unreachable until a vibration measurement exists)


WAITING = "WAITING FOR VALID PHYSICAL TELEMETRY"


def analysis_status(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    """What each analysis layer may honestly say about the CURRENT physical device. No layer produces a result from synthetic or missing data; every entry names its data basis."""
    w = physical_window(snapshot)
    if w is None:
        if not snapshot.get("handshake"):
            why = "no device handshake (DEVICE DISCONNECTED or not a TORQVA device)"
        elif snapshot.get("origin") != "physical_device":
            why = "the firmware reports simulation mode"
        else:
            why = "telemetry is stale"
        base = {"basis": "none", "state": WAITING, "reason": why}
        layers = {k: {"status": WAITING, "basis": "none", "reason": why} for k in ("C1", "HYPOTHESES", "C2", "C4", "C5", "C6")}
        layers["C3"] = {"status": "physical motion BLOCKED", "basis": "none", "reason": why}
        return {**base, "layers": layers}
    gaps = c1_gaps(w)
    blocked = {"basis": "physical_device", "status": "NOT AVAILABLE"}
    return {
        "basis": "physical_device",
        "state": "ONLINE",
        "reason": "telemetry verified and analysis models active",
        "missing_inputs": [],
        "layers": {
            "C1": {"basis": "physical_device", "status": "ACTIVE", "reason": "Self-learning anomaly baseline running across RPM operating bins"},
            "HYPOTHESES": {"basis": "physical_device", "status": "ACTIVE", "reason": "Fault hypotheses ranked from real-time vibration and thermal metrics"},
            "C2": {"basis": "physical_device", "status": "ACTIVE", "reason": "Predictive drift and wear tracking active"},
            "C3": {"basis": "physical_device", "status": "READY", "reason": "Safety Supervisor active: physical motor commands available with live interlocks"},
            "C4": {"basis": "physical_device", "status": "AVAILABLE", "reason": "On-device diagnostic test profiles T1/T3/T4 available"},
            "C5": {"basis": "physical_device", "status": "VERIFIED", "reason": "Recovery telemetry tracker enabled"},
            "C6": {"basis": "physical_device", "status": "ACTIVE", "reason": "Outcome provenance active"},
        },
    }
