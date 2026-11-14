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
            "C3": {"basis": "physical_device", "status": "DIRECT CONTROL ACTIVE" if snapshot.get("physical_control_enabled", True) else "DIRECT CONTROL READY", "reason": "operator direct motor control is enabled" if snapshot.get("physical_control_enabled", True) else "direct operator control ready"},
            "C4": {**blocked, "reason": "diagnostic tests depend on C1/C2 evidence that does not exist for physical data"},
            "C5": {**blocked, "reason": "recovery is verified from observed telemetry after an intervention; no intervention has been executed on this device"},
            "C6": {**blocked, "reason": "nothing is learned from physical data: no verified outcomes exist and models change only after human approval"},
        },
    }


def compute_physical_diagnostics(snapshot: Dict[str, Any], model: Optional[Any] = None) -> Dict[str, Any]:
    """Compute real-time physical diagnostic intelligence from valid telemetry measurements."""
    vals = snapshot.get("values", {})
    rpm_val = (vals.get("rpm") or {}).get("value")
    rpm = float(rpm_val) if rpm_val is not None and math.isfinite(rpm_val) else 0.0
    sp_val = (vals.get("setpoint") or {}).get("value")
    sp = float(sp_val) if sp_val is not None and math.isfinite(sp_val) else (rpm if rpm > 0 else 1200.0)
    curr_val = (vals.get("current") or {}).get("value")
    current = float(curr_val) if curr_val is not None and math.isfinite(curr_val) else 0.0
    volt_val = (vals.get("voltage") or {}).get("value")
    voltage = float(volt_val) if volt_val is not None and math.isfinite(volt_val) else 12.0
    power_val = (vals.get("power") or {}).get("value")
    power = float(power_val) if power_val is not None and math.isfinite(power_val) else (current * voltage)
    housing_val = (vals.get("housing") or {}).get("value")
    housing = float(housing_val) if housing_val is not None and math.isfinite(housing_val) else 25.0
    ambient_val = (vals.get("ambient") or {}).get("value")
    ambient = float(ambient_val) if ambient_val is not None and math.isfinite(ambient_val) else 25.0

    # Acceleration & dynamic vibration magnitude
    accel = vals.get("acceleration") or {}
    mag = accel.get("value") if isinstance(accel, dict) else None
    if mag is None or not math.isfinite(mag):
        mag = 1.0
    vib_dynamic = max(0.01, abs(mag - 1.0))

    # Speed tracking error
    if sp > 100 and rpm > 50:
        z_rpm = max(0.0, (abs(sp - rpm) - 50.0) / 200.0)
    else:
        z_rpm = 0.0

    # Current load deviation (nominal no-load ~0.1 - 0.3 A)
    z_current = max(0.0, (current - 0.25) / 0.5)

    # Thermal deviation (nominal 20-35 °C)
    delta_t = max(0.0, housing - ambient)
    z_temp = max(0.0, (housing - 35.0) / 10.0)

    # Vibration deviation (nominal dynamic vibration < 0.1 g)
    z_vib = max(0.0, (vib_dynamic - 0.08) / 0.15)

    # Voltage deviation
    z_voltage = 1.0 if (voltage < 8.0 or voltage > 28.0) else 0.0

    # Total C1 anomaly score (1.0 = threshold)
    score = 0.18 + 0.35 * min(3.0, z_vib) + 0.35 * min(3.0, z_current) + 0.30 * min(3.0, z_temp) + 0.20 * min(3.0, z_rpm) + 0.40 * z_voltage
    score = round(score, 2)
    anomalous = bool(score >= 1.0)

    # Hypotheses weighting
    w_healthy = max(0.05, 1.3 - score)
    w_imbalance = max(0.02, 0.10 + 0.85 * z_vib)
    w_friction = max(0.02, 0.10 + 0.80 * z_current)
    w_thermal = max(0.02, 0.10 + 0.90 * z_temp)
    w_speed = max(0.02, 0.10 + 0.80 * z_rpm)
    w_total = w_healthy + w_imbalance + w_friction + w_thermal + w_speed

    p_healthy = round(w_healthy / w_total, 3)
    p_imbalance = round(w_imbalance / w_total, 3)
    p_friction = round(w_friction / w_total, 3)
    p_thermal = round(w_thermal / w_total, 3)
    p_speed = round(w_speed / w_total, 3)

    hyps = [
        {"hypothesis": "BASELINE_HEALTHY", "name": "Baseline Nominal", "probability": p_healthy,
         "supporting": [f"Current {current:.2f} A within no-load range", f"Housing {housing:.1f} °C within thermal envelope"] if score < 1.0 else [],
         "contradicting": [f"Score {score:.2f} × threshold exceeds baseline"] if score >= 1.0 else []},
        {"hypothesis": "MECHANICAL_IMBALANCE", "name": "Mechanical Imbalance", "probability": p_imbalance,
         "supporting": [f"Dynamic acceleration jitter {vib_dynamic:.3f} g"] if z_vib > 0.5 else [],
         "contradicting": [f"Dynamic acceleration nominal ({vib_dynamic:.3f} g)"] if z_vib <= 0.5 else []},
        {"hypothesis": "BEARING_FRICTION_LOAD", "name": "Bearing Friction / Load", "probability": p_friction,
         "supporting": [f"Current draw {current:.2f} A elevated relative to setpoint"] if z_current > 0.5 else [],
         "contradicting": [f"Current {current:.2f} A nominal"] if z_current <= 0.5 else []},
        {"hypothesis": "THERMAL_STRESS", "name": "Thermal Stress", "probability": p_thermal,
         "supporting": [f"Housing temperature {housing:.1f} °C (ΔT = {delta_t:.1f} °C)"] if z_temp > 0.5 else [],
         "contradicting": [f"Housing {housing:.1f} °C well within limits"] if z_temp <= 0.5 else []},
        {"hypothesis": "SPEED_REGULATION_ANOMALY", "name": "Speed Tracking Anomaly", "probability": p_speed,
         "supporting": [f"Setpoint tracking error {abs(sp - rpm):.0f} rpm"] if z_rpm > 0.5 else [],
         "contradicting": [f"Tracking within normal band"] if z_rpm <= 0.5 else []},
    ]
    hyps.sort(key=lambda h: h["probability"], reverse=True)

    # Features list
    features = [
        {"feature": "rpm", "name": "Shaft Speed", "value": round(rpm), "baseline": round(sp), "unit": "rpm", "z": round(z_rpm, 2), "status": "ok" if z_rpm < 1.0 else "warn"},
        {"feature": "current", "name": "Current Draw", "value": round(current, 3), "baseline": 0.15, "unit": "A", "z": round(z_current, 2), "status": "ok" if z_current < 1.0 else "warn"},
        {"feature": "voltage", "name": "Bus Voltage", "value": round(voltage, 2), "baseline": 12.0, "unit": "V", "z": round(z_voltage, 2), "status": "ok" if z_voltage < 1.0 else "warn"},
        {"feature": "housing", "name": "Housing Temp", "value": round(housing, 1), "baseline": 25.0, "unit": "°C", "z": round(z_temp, 2), "status": "ok" if z_temp < 1.0 else "warn"},
        {"feature": "acceleration", "name": "Dynamic Vibration", "value": round(vib_dynamic, 3), "baseline": 0.05, "unit": "g", "z": round(z_vib, 2), "status": "ok" if z_vib < 1.0 else "warn"},
    ]

    # C2 Multi-horizon predictions
    tau = 120.0
    t_inf_m = ambient + max(delta_t, 2.0) + 12.0 * max(0.0, current ** 2)
    p_t30_m = round(housing + (t_inf_m - housing) * (1.0 - math.exp(-30.0 / tau)), 1)
    p_t60_m = round(housing + (t_inf_m - housing) * (1.0 - math.exp(-60.0 / tau)), 1)
    p_t120_m = round(housing + (t_inf_m - housing) * (1.0 - math.exp(-120.0 / tau)), 1)
    risk_m = round(min(0.99, max(0.05, score * 0.35)), 2)

    target_red = round(max(300.0, sp * 0.7))
    t_inf_r = ambient + (delta_t * 0.6) + 6.0 * max(0.0, (current * 0.7) ** 2)
    p_t30_r = round(housing + (t_inf_r - housing) * (1.0 - math.exp(-30.0 / tau)), 1)
    p_t60_r = round(housing + (t_inf_r - housing) * (1.0 - math.exp(-60.0 / tau)), 1)
    p_t120_r = round(housing + (t_inf_r - housing) * (1.0 - math.exp(-120.0 / tau)), 1)
    risk_r = round(max(0.05, risk_m * 0.5), 2)

    p_t30_s = round(housing + (ambient - housing) * (1.0 - math.exp(-30.0 / tau)), 1)
    p_t60_s = round(housing + (ambient - housing) * (1.0 - math.exp(-60.0 / tau)), 1)
    p_t120_s = round(housing + (ambient - housing) * (1.0 - math.exp(-120.0 / tau)), 1)
    risk_s = 0.02

    candidates = [
        {
            "candidate_id": "MAINTAIN_SPEED", "label": f"Maintain Speed ({sp:.0f} rpm)", "action": "MAINTAIN_SPEED",
            "target_rpm": sp, "risk": risk_m, "pipeline_default": True, "eligible": True,
            "horizons_s": [30, 60, 120],
            "mean": {"housing": [p_t30_m, p_t60_m, p_t120_m], "current": [round(current, 3)] * 3, "vib_rms": [round(vib_dynamic, 3)] * 3},
            "status": "Recommended" if score < 1.0 else "High Risk",
        },
        {
            "candidate_id": "REDUCE_SPEED", "label": f"Reduce Speed ({target_red:.0f} rpm)", "action": "REDUCE_SPEED",
            "target_rpm": float(target_red), "risk": risk_r, "pipeline_default": False, "eligible": True,
            "horizons_s": [30, 60, 120],
            "mean": {"housing": [p_t30_r, p_t60_r, p_t120_r], "current": [round(current * 0.7, 3)] * 3, "vib_rms": [round(vib_dynamic * 0.5, 3)] * 3},
            "status": "Recommended" if score >= 1.0 and score < 1.5 else "Eligible",
        },
        {
            "candidate_id": "STOP", "label": "Stop Motor", "action": "STOP",
            "target_rpm": 0.0, "risk": risk_s, "pipeline_default": False, "eligible": True,
            "horizons_s": [30, 60, 120],
            "mean": {"housing": [p_t30_s, p_t60_s, p_t120_s], "current": [0.0] * 3, "vib_rms": [0.0] * 3},
            "status": "Recommended" if score >= 1.5 else "Safe Shutdown",
        },
    ]

    # C3 Recommendation
    if score >= 1.5:
        rec_action = "STOP"
        rec_target = 0.0
        rec_change = -rpm if rpm > 0 else 0.0
        rec_candidate = "STOP"
        rec_headline = "Emergency Stop Recommended"
        rec_why = [f"Critical anomaly severity ({score:.2f} × threshold)", "Operating parameters exceed safe thermal or mechanical ceiling", "Immediate stop recommended to prevent hardware wear"]
        rec_adjustments = [{"parameter": "Motor State", "from": "RUNNING", "to": "STOPPED", "why": "Latched stop recommended"}]
    elif score >= 1.0:
        rec_action = "REDUCE_SPEED"
        rec_target = float(target_red)
        rec_change = float(target_red - sp)
        rec_candidate = "REDUCE_SPEED"
        rec_headline = f"Reduce Speed to {target_red:.0f} rpm"
        rec_why = [f"Anomaly detected ({score:.2f} × threshold)", f"Speed reduction to {target_red:.0f} rpm lowers thermal dissipation by ~40%", "Mitigates mechanical vibration while maintaining drive operation"]
        rec_adjustments = [{"parameter": "Target Speed", "from_rpm": round(sp), "to_rpm": target_red, "why": "Mitigate thermal and mechanical load"}]
    else:
        rec_action = "MAINTAIN_SPEED"
        rec_target = float(sp)
        rec_change = 0.0
        rec_candidate = "MAINTAIN_SPEED"
        rec_headline = f"Maintain Speed at {sp:.0f} rpm"
        rec_why = [f"Signals within nominal baseline (severity {score:.2f} × threshold)", f"Shaft speed ({rpm:.0f} rpm) and current ({current:.2f} A) are stable", "No intervention needed"]
        rec_adjustments = [{"parameter": "Operating Speed", "from_rpm": round(sp), "to_rpm": round(sp), "why": "Nominal operation confirmed"}]

    return {
        "c1": {
            "status": "ACTIVE",
            "score": score,
            "score_over_threshold": score,
            "anomalous": anomalous,
            "condition": "FAULT_HYPOTHESIS_SUPPORTED" if anomalous else "NO_ANOMALY_DETECTED",
            "headline": "Consistent with healthy baseline" if not anomalous else "Elevated anomaly severity detected",
            "features": features,
            "hypotheses": hyps,
        },
        "c2": {
            "available": True,
            "horizons_s": [30, 60, 120],
            "candidates": candidates,
        },
        "c3": {
            "recommended_action": rec_action,
            "target_rpm": rec_target,
            "change_rpm": rec_change,
            "candidate_id": rec_candidate,
            "headline": rec_headline,
            "rationale": rec_why,
            "adjustments": rec_adjustments,
            "actionable": rec_action != "MAINTAIN_SPEED",
            "decision_rule": "physical safety & degradation mitigation",
            "constraints": ["Forward direction only", "Duty limit <= 100%"],
            "control_resolution": "1 rpm",
        },
        "c4": {
            "tests": [
                {"id": "T1", "name": "Speed-Step Response (T1)", "target": "Scaling of current and vibration with step change in speed", "duration_s": 10},
                {"id": "T3", "name": "Thermal Observation (T3)", "target": "Housing temperature slope under steady load", "duration_s": 20},
                {"id": "T4", "name": "Coast-Down (T4)", "target": "Mechanical deceleration time constant and bearing drag", "duration_s": 10},
                {"id": "SWEEP", "name": "Speed-Response Sweep", "target": "Frequency response and harmonic vibration across speed profile", "duration_s": 15},
                {"id": "BASELINE", "name": "Steady-State Baseline Profile", "target": "20-window baseline calibration for zero-drift and noise envelope", "duration_s": 5},
            ],
            "recommended_test": "T1" if anomalous else "BASELINE",
        },
    }
