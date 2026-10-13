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
        "basis": "physical_device", "state": "TELEMETRY VALID, ANALYSIS NOT AVAILABLE", "reason": "valid measurements are arriving, but the analysis models cannot consume them yet",
        "missing_inputs": gaps,
        "layers": {
            "C1": {**blocked, "reason": "C1 was fitted on simulated windows and needs vibration RMS and shaft-order harmonics, which this firmware does not measure; missing: " + ", ".join(gaps)},
            "HYPOTHESES": {**blocked, "reason": "no anomaly evidence exists to rank hypotheses; missing data is never treated as evidence"},
            "C2": {**blocked, "reason": "no validated prediction model exists for physical data; there is no real baseline or held-out evaluation"},
            "C3": {"basis": "physical_device", "status": "physical motion BLOCKED", "reason": "the deterministic Safety Supervisor decides every physical command; commissioning requirements are open (see Motor Control)"},
            "C4": {**blocked, "reason": "diagnostic tests depend on C1/C2 evidence that does not exist for physical data"},
            "C5": {**blocked, "reason": "recovery is verified from observed telemetry after an intervention; no intervention has been executed on this device"},
            "C6": {**blocked, "reason": "nothing is learned from physical data: no verified outcomes exist and models change only after human approval"},
        },
    }
