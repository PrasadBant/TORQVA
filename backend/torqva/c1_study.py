"""Phase 8 - C1 distribution-shift study (SIMULATION ONLY; no measured data, simulator uncalibrated).

    python -m torqva.c1_study validate      # tune on VALIDATION sessions/regimes only; writes the frozen selection
    python -m torqva.c1_study final         # one run on HELD-OUT test sessions/regimes with the frozen selection

Protocol
  * train sessions  : baseline-regime sessions (seeds TRAIN_SEEDS). The control is also evaluated exactly as shipped (1 session).
  * validation      : seeds VAL_SEEDS, regimes VAL_CONDITIONS - used for every hyperparameter choice.
  * final test      : seeds TEST_SEEDS (disjoint from train/val/every earlier eval seed), regimes TEST_CONDITIONS, most of
                      which (noise x2/x3, gain x1.25/x0.8, session_shift, hard, drift, step, bias, temperature, speed step,
                      unseen speeds, warm-up with a hidden fault) never appear in validation. `final` refuses to run without the
                      selection file written by `validate`, and the selection is never edited by `final`.
  * a session = 60 s trusted warm-up (healthy) + 40 s observation (fault injected at the start of observation, if any);
    flagged = >= 8 anomalous steady windows in the observation (same rule as the existing evaluation).
Every session is logged (seed, speed, regime config, ground truth, per-variant verdict) to a JSONL file.
"""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import json
import math
import os
from dataclasses import asdict, dataclass, field, replace
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np

from .c1_robust import (AdaptiveBaselineDetector, CoherenceConfig, ReferenceConfig, ReferenceRegistry, RobustBaselineDetector,
                        VIB, assess_session, first_confirmed)
from .detection import BaselineDetector, ThermalTracker
from .evaluation import SPEEDS_LEARNED
from .schemas import Hypothesis
from .sim import Regime, MotorSim, Window

TRAIN_SEEDS = (0, 9001, 9002, 9003)            # seed 0 is the shipped control's single training session
VAL_SEEDS_H, VAL_SEEDS_F = tuple(range(9101, 9107)), tuple(range(9101, 9105))
TEST_SEEDS_H, TEST_SEEDS_F = tuple(range(9201, 9213)), tuple(range(9201, 9207))
SPEEDS = (1350, 1650, 1950)                     # none equals a training setpoint
SEVERITIES = (0.1, 0.3, 0.6)
FAULTS = ("imbalance", "looseness", "overload", "supply_voltage", "sensor_fault", "sensor_fault_lookalike")
HYP = {"imbalance": Hypothesis.IMBALANCE, "looseness": Hypothesis.LOOSENESS, "overload": Hypothesis.OVERLOAD,
       "supply_voltage": Hypothesis.SUPPLY_VOLTAGE, "sensor_fault": Hypothesis.SENSOR_FAULT,
       "sensor_fault_lookalike": Hypothesis.SENSOR_FAULT}
WARM_S, OBS_S = 60, 40
DOCS_EVAL = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "eval")
SELECTION_FILE = os.path.join(DOCS_EVAL, "c1_phase8_selection.json")


# ================================================================================================ conditions
@dataclass(frozen=True)
class Condition:
    name: str
    split: str                                   # val | test
    kind: str = "healthy_shift"                  # healthy_shift | stress | unfamiliar_region | hidden_fault_warmup
    noise_mult: float = 1.0
    session_offsets: bool = False
    gain: Optional[float] = None                 # constant vibration gain; negative sign convention: see gain_alt
    gain_alt: Optional[float] = None             # odd seeds use this (e.g. 0.9 / 1.1 +-10 %)
    ambient: Optional[float] = None
    drift: Optional[Tuple[float, float, float]] = None      # (t_start, t_end, final_gain) gradual sensor-gain drift
    step: Optional[Tuple[float, float]] = None               # (t, gain) abrupt sensor-gain step
    bias: float = 0.0                                        # additive vibration-channel bias in g
    speed_delta: float = 0.0                                 # setpoint change at the start of observation
    speeds: Tuple[float, ...] = SPEEDS
    fault_in_warmup: bool = False
    note: str = ""


VAL_CONDITIONS = (
    Condition("baseline", "val", note="no shift"),
    Condition("noise_x1.5", "val", noise_mult=1.5, note="1.5x measurement noise"),
    Condition("gain_pm10", "val", gain=0.9, gain_alt=1.1, note="vibration gain -10 % / +10 % (alternating seeds)"),
    Condition("noise_x1.75", "val", noise_mult=1.75, note="1.75x measurement noise (still below every test noise level)"),
    Condition("gain_pm15", "val", gain=0.85, gain_alt=1.15, note="vibration gain -15 % / +15 %"),
)
TEST_CONDITIONS = (
    Condition("baseline", "test", note="no shift, fresh seeds"),
    Condition("noise_x2", "test", noise_mult=2.0),
    Condition("noise_x3", "test", noise_mult=3.0, kind="stress", note="beyond any validation noise level"),
    Condition("gain_x1.25", "test", gain=1.25, note="+25 % vibration gain (outside validation range)"),
    Condition("gain_x0.80", "test", gain=0.80, note="-20 % vibration gain"),
    Condition("session_shift", "test", session_offsets=True, note="existing regime: random gain/ambient/supply/current per session"),
    Condition("hard_shift", "test", session_offsets=True, noise_mult=2.0, note="session_shift + noise x2"),
    Condition("sensor_bias_0.004g", "test", kind="stress", bias=0.004, note="additive offset on every vibration channel: a sensor anomaly, NOT a claimed-healthy shift (any non-HEALTHY verdict is acceptable)"),
    Condition("gradual_gain_drift", "test", drift=(60.0, 100.0, 1.2), note="gain ramps 1.0 -> 1.2 during observation"),
    Condition("abrupt_gain_step", "test", step=(60.0, 1.2), note="+20 % gain step at the end of warm-up"),
    Condition("ambient_30C", "test", ambient=30.0, note="+8 C ambient"),
    Condition("ambient_14C", "test", ambient=14.0, note="-8 C ambient"),
    Condition("speed_step_+150", "test", speed_delta=150.0, note="setpoint +150 rpm after warm-up (new interpolation region)"),
    Condition("unseen_speed_2400", "test", kind="unfamiliar_region", speeds=(2400.0,), note="above the highest trained bin"),
    Condition("unseen_speed_600", "test", kind="unfamiliar_region", speeds=(600.0,), note="below the lowest trained bin"),
    Condition("fault_hidden_in_warmup", "test", kind="hidden_fault_warmup", fault_in_warmup=True,
              note="warm-up wrongly marked trusted although the fault is already present (adaptation must not absorb it)"),
)


def gain_of(cond: Condition, seed: int) -> Optional[float]:
    if cond.gain is None:
        return None
    return cond.gain_alt if (cond.gain_alt is not None and seed % 2) else cond.gain


def _apply_vibration(w: Window, gain: float, bias: float) -> Window:
    v = [w.v1x * gain + bias, w.v2x * gain + bias, w.v3x * gain + bias, w.vhf * gain + bias]
    if gain == 1.0 and bias == 0.0:
        return w
    old = [w.v1x, w.v2x, w.v3x, w.vhf]
    rms = math.sqrt(max(w.vib_rms ** 2 * gain * gain + sum(n * n - (o * gain) ** 2 for n, o in zip(v, old)), 0.0))
    return replace(w, v1x=v[0], v2x=v[1], v3x=v[2], vhf=v[3], vib_rms=rms)


def post_transform(cond: Condition, w: Window) -> Window:
    g = 1.0
    if cond.drift:
        t0, t1, ge = cond.drift
        g *= 1.0 + (ge - 1.0) * float(np.clip((w.t - t0) / (t1 - t0), 0.0, 1.0))
    if cond.step and w.t > cond.step[0]:
        g *= cond.step[1]
    return _apply_vibration(w, g, cond.bias)


def build_session(cond: Condition, seed: int, sp: float, fault: Optional[str], sev: float, tt: ThermalTracker) -> Tuple[List[Window], List[Window], Dict]:
    regime = Regime(cond.name, noise_mult=cond.noise_mult, session_offsets=cond.session_offsets,
                    sensor_fault_mode="noisy_harmonics" if fault == "sensor_fault_lookalike" else "stuck")
    s = MotorSim(seed, regime=regime)
    g = gain_of(cond, seed)
    if g is not None:
        s.vib_gain = g
    if cond.ambient is not None:
        s.ambient_c = cond.ambient
    s.housing = s.ambient_c
    s.set_setpoint(sp)
    if fault and cond.fault_in_warmup:
        s.inject(HYP[fault], sev)
    warm = s.run(WARM_S)
    if cond.speed_delta:
        s.set_setpoint(sp + cond.speed_delta)
    if fault and not cond.fault_in_warmup:
        s.inject(HYP[fault], sev)
    obs = s.run(OBS_S)
    warm = [post_transform(cond, w) for w in warm]; obs = [post_transform(cond, w) for w in obs]
    tt.reset(warm[0].housing)
    for w in warm + obs:
        tt.update(w)
    cfg = {"regime": asdict(regime), "vib_gain": s.vib_gain, "ambient_c": s.ambient_c, "supply_off": s.supply_off,
           "current_off": s.current_off, "sim_params": "SimParams() defaults"}
    return warm, obs, cfg


# ================================================================================================ models
def train_models(seeds: Sequence[int] = TRAIN_SEEDS):
    """Thermal tracker exactly as the shipped build_models (seed-0 session); detectors fitted on `seeds` sessions."""
    tt = ThermalTracker()
    sim = MotorSim(0); data0 = []
    for sp in SPEEDS_LEARNED:
        sim.set_setpoint(sp); data0 += sim.run(90)
    tt.fit(data0)

    def session_windows(seed):
        sm = MotorSim(seed); d = []
        for sp in SPEEDS_LEARNED:
            sm.set_setpoint(sp); d += sm.run(90)
        tt.reset(d[0].housing)
        for w in d:
            tt.update(w)
        return d

    d1 = session_windows(0)
    pooled = [w for sd in seeds for w in session_windows(sd)]
    control1 = BaselineDetector(); control1.fit(d1)
    control4 = BaselineDetector(); control4.fit(pooled)
    adaptive4 = AdaptiveBaselineDetector(); adaptive4.fit(pooled)
    return tt, control1, control4, adaptive4, pooled


def make_robust(pooled, rel_floor: float) -> RobustBaselineDetector:
    r = RobustBaselineDetector(rel_floor=rel_floor); r.fit(pooled); return r


@dataclass
class VariantSpec:
    name: str
    det: object
    use_ref: bool = False
    regime_aware: bool = False
    plain_control: bool = False


def control_verdict(det: BaselineDetector, windows: Sequence[Window]) -> Dict:
    """The shipped rule, using only the unchanged BaselineDetector.score: FAULT iff >= 8 anomalous steady windows."""
    flags, ratios = [], []
    for w in windows:
        sc = det.score(w)
        if sc.value is not None and sc.threshold:
            flags.append(sc.anomalous); ratios.append(sc.value / sc.threshold)
    n = int(sum(flags))
    return {"verdict": "FAULT" if n >= 8 else "HEALTHY", "reason": "flag_count", "flagged": n, "scored": len(flags),
            "delay": first_confirmed(flags), "max_ratio": float(max(ratios) if ratios else 0.0), "ref": None}


def run_variant(v: VariantSpec, warm, obs, cfg_ref: ReferenceConfig, cfg_coh: CoherenceConfig) -> Dict:
    if v.plain_control:
        return control_verdict(v.det, obs)
    ref, ref_info = None, None
    if v.use_ref:
        reg = ReferenceRegistry()
        prop = reg.propose(v.det, warm, trusted=True, cfg=cfg_ref)
        ref = reg.active
        ref_info = {"accepted": prop.accepted, "reason": prop.reason, **{k: round(x, 4) for k, x in prop.metrics.items()}}
    a = assess_session(v.det, obs, ref=ref, regime_aware=v.regime_aware, cfg=cfg_coh)
    return {"verdict": a.verdict, "reason": a.reason, "flagged": a.flagged, "scored": a.scored,
            "delay": first_confirmed(a.flags), "max_ratio": a.max_ratio, "ref": ref_info}


# ================================================================================================ running
def wilson(k: int, n: int, z: float = 1.96) -> Tuple[Optional[float], Optional[float]]:
    if n == 0:
        return None, None
    p = k / n; d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return round(max(0.0, c - h), 4), round(min(1.0, c + h), 4)


def run_conditions(conds: Sequence[Condition], variants: Sequence[VariantSpec], tt: ThermalTracker, seeds_h, seeds_f,
                   cfg_ref: ReferenceConfig, cfg_coh: CoherenceConfig, model_version: str, sessions_out: Optional[List] = None) -> List[Dict]:
    recs = []
    for cond in conds:
        jobs = [(None, 0.0, sd, sp) for sd in seeds_h for sp in cond.speeds]
        jobs += [(f, sev, sd, sp) for f in FAULTS for sev in SEVERITIES for sd in seeds_f for sp in cond.speeds]
        for fault, sev, sd, sp in jobs:
            warm, obs, scfg = build_session(cond, sd, sp, fault, sev, tt)
            sid = f"{cond.name}|{fault or 'healthy'}|{sev}|{sd}|{int(sp)}"
            rec = {"session_id": sid, "condition": cond.name, "split": cond.split, "kind": cond.kind, "seed": sd, "speed": sp,
                   "truth": {"fault": fault, "severity": sev if fault else 0.0, "injected_at": "warmup_start" if (fault and cond.fault_in_warmup) else "observation_start"},
                   "sim_config": scfg, "model_version": model_version, "results": {}}
            for v in variants:
                rec["results"][v.name] = run_variant(v, warm, obs, cfg_ref, cfg_coh)
            recs.append(rec)
    return recs


def aggregate(recs: Sequence[Dict], variants: Sequence[str]) -> Dict:
    out: Dict = {}
    for cname in sorted({r["condition"] for r in recs}, key=lambda c: [r["condition"] for r in recs].index(c)):
        rs = [r for r in recs if r["condition"] == cname]
        healthy = [r for r in rs if r["truth"]["fault"] is None]
        faulty = [r for r in rs if r["truth"]["fault"] is not None]
        entry = {"healthy_n": len(healthy), "fault_n": len(faulty), "variants": {}}
        for vn in variants:
            hv = [r["results"][vn] for r in healthy]
            nf = sum(x["verdict"] == "FAULT" for x in hv); nu = sum(x["verdict"] == "UNFAMILIAR" for x in hv)
            nh = sum(x["verdict"] == "HEALTHY" for x in hv)
            ve = {"healthy": {"n": len(hv), "false_fault": nf, "false_fault_rate": nf / max(len(hv), 1), "false_fault_ci95": wilson(nf, len(hv)),
                              "unfamiliar": nu, "unfamiliar_rate": nu / max(len(hv), 1), "accepted_healthy": nh,
                              "accepted_healthy_rate": nh / max(len(hv), 1),
                              "max_ratio_q": _q([x["max_ratio"] for x in hv]),
                              "by_speed": {str(int(sp)): _rate([r for r in healthy if r["speed"] == sp], vn, "FAULT") for sp in sorted({r["speed"] for r in healthy})}},
                  "faults": {}}
            for f in FAULTS:
                for sev in list(SEVERITIES) + ["all"]:
                    fr = [r for r in faulty if r["truth"]["fault"] == f and (sev == "all" or r["truth"]["severity"] == sev)]
                    if not fr:
                        continue
                    res = [r["results"][vn] for r in fr]
                    k = sum(x["verdict"] == "FAULT" for x in res); e = sum(x["verdict"] == "UNFAMILIAR" for x in res)
                    d = [x["delay"] for x in res if x["verdict"] == "FAULT" and x["delay"] is not None]
                    ve["faults"][f"{f}@{sev}"] = {"n": len(res), "recall": k / len(res), "recall_ci95": wilson(k, len(res)),
                                                  "escalated_unfamiliar": e / len(res), "silent_miss": (len(res) - k - e) / len(res),
                                                  "median_delay_s": float(np.median(d)) if d else None,
                                                  "max_ratio_q": _q([x["max_ratio"] for x in res])}
            allf = [r["results"][vn] for r in faulty]
            if allf:
                k = sum(x["verdict"] == "FAULT" for x in allf); e = sum(x["verdict"] == "UNFAMILIAR" for x in allf)
                ve["faults_pooled"] = {"n": len(allf), "recall": k / len(allf), "recall_ci95": wilson(k, len(allf)),
                                       "escalated_unfamiliar": e / len(allf), "silent_miss": (len(allf) - k - e) / len(allf)}
                hi = [x for r, x in zip(faulty, allf) if r["truth"]["severity"] >= 0.3]
                ve["faults_pooled"]["recall_sev_ge_0.3"] = sum(x["verdict"] == "FAULT" for x in hi) / max(len(hi), 1)
                ve["faults_pooled"]["n_sev_ge_0.3"] = len(hi)
            entry["variants"][vn] = ve
        out[cname] = entry
    return out


def _q(x):
    return [round(float(v), 3) for v in np.percentile(x, [50, 90, 99])] if len(x) else None


def _rate(rs, vn, verdict):
    return {"n": len(rs), "rate": sum(r["results"][vn]["verdict"] == verdict for r in rs) / max(len(rs), 1)}


# ================================================================================================ stages
def _variants(tt, control1, control4, adaptive4, pooled, rel_floor: float) -> List[VariantSpec]:
    A = make_robust(pooled, rel_floor)
    return [VariantSpec("control_1session", control1, plain_control=True), VariantSpec("control_4session", control4, plain_control=True),
            VariantSpec("A_robust", A), VariantSpec("B_reference", adaptive4, use_ref=True),
            VariantSpec("C_regime", adaptive4, regime_aware=True), VariantSpec("B+C", adaptive4, use_ref=True, regime_aware=True),
            VariantSpec("A+B+C", A, use_ref=True, regime_aware=True)]


def _val_metrics(recs, vn):
    h = [r["results"][vn]["verdict"] for r in recs if r["truth"]["fault"] is None]
    f = [(r["results"][vn]["verdict"], r["truth"]["severity"]) for r in recs if r["truth"]["fault"] is not None]
    hi = [v for v, s in f if s >= 0.3]
    return {"val_false_fault": sum(v == "FAULT" for v in h) / max(len(h), 1), "val_unfamiliar": sum(v == "UNFAMILIAR" for v in h) / max(len(h), 1),
            "val_recall_sev_ge_0.3": sum(v == "FAULT" for v in hi) / max(len(hi), 1),
            "val_recall_all": sum(v == "FAULT" for v, _ in f) / max(len(f), 1)}


def stage_validate() -> Dict:
    """All tuning happens here, on VALIDATION seeds/regimes only."""
    tt, c1, c4, ad4, pooled = train_models()
    floors, cohs = (0.03, 0.05, 0.08, 0.12, 0.20), (0.06, 0.10, 0.15)
    sweep = []
    ref_cfg_default = ReferenceConfig(); coh_default = CoherenceConfig()
    # sessions are simulated once per condition and scored by every hyperparameter setting
    cache = []
    for cond in VAL_CONDITIONS:
        jobs = [(None, 0.0, sd, sp) for sd in VAL_SEEDS_H for sp in cond.speeds]
        jobs += [(f, sev, sd, sp) for f in FAULTS for sev in SEVERITIES for sd in VAL_SEEDS_F for sp in cond.speeds]
        for fault, sev, sd, sp in jobs:
            warm, obs, _ = build_session(cond, sd, sp, fault, sev, tt)
            cache.append({"condition": cond.name, "truth": {"fault": fault, "severity": sev if fault else 0.0}, "warm": warm, "obs": obs,
                          "speed": sp})

    def score_all(variants, cfg_ref, cfg_coh):
        recs = []
        for c in cache:
            recs.append({**{k: c[k] for k in ("condition", "truth", "speed")},
                         "results": {v.name: run_variant(v, c["warm"], c["obs"], cfg_ref, cfg_coh) for v in variants}})
        return recs

    base_vars = [VariantSpec("control_1session", c1, plain_control=True), VariantSpec("control_4session", c4, plain_control=True)]
    ctrl = score_all(base_vars, ref_cfg_default, coh_default)
    control_val = {v.name: _val_metrics(ctrl, v.name) for v in base_vars}
    ctrl_recall = control_val["control_4session"]["val_recall_sev_ge_0.3"]
    limit_fp, recall_slack = 0.05, 0.05

    for rf in floors:
        A = make_robust(pooled, rf)
        recs = score_all([VariantSpec("A_robust", A)], ref_cfg_default, coh_default)
        sweep.append({"candidate": "A_robust", "param": {"rel_floor": rf}, **_val_metrics(recs, "A_robust")})
    for ct in cohs:
        rc, cc = replace(ref_cfg_default, coh_tol=ct), replace(coh_default, coh_tol=ct)
        vs = [VariantSpec("B_reference", ad4, use_ref=True), VariantSpec("C_regime", ad4, regime_aware=True),
              VariantSpec("B+C", ad4, use_ref=True, regime_aware=True)]
        recs = score_all(vs, rc, cc)
        for v in vs:
            sweep.append({"candidate": v.name, "param": {"coh_tol": ct}, **_val_metrics(recs, v.name)})

    selection: Dict = {"stage": "validation", "train_seeds": TRAIN_SEEDS, "val_seeds_healthy": VAL_SEEDS_H, "val_seeds_fault": VAL_SEEDS_F,
                       "val_conditions": [c.name for c in VAL_CONDITIONS],
                       "rule": f"feasible = val_false_fault <= {limit_fp} AND val_recall_sev_ge_0.3 >= control_4session({ctrl_recall:.3f}) - {recall_slack}; "
                               "choose lowest val_false_fault, then highest val recall, then the smallest parameter; "
                               "no feasible setting => candidate is NOT selected (retain control)",
                       "control_val": control_val, "sweep": sweep, "selected": {}}
    for cand in ("A_robust", "B_reference", "C_regime", "B+C"):
        rows = [s for s in sweep if s["candidate"] == cand]
        feas = [s for s in rows if s["val_false_fault"] <= limit_fp and s["val_recall_sev_ge_0.3"] >= ctrl_recall - recall_slack]
        if feas:
            best = sorted(feas, key=lambda s: (s["val_false_fault"], -s["val_recall_sev_ge_0.3"], list(s["param"].values())[0]))[0]
            selection["selected"][cand] = best["param"]
        else:
            selection["selected"][cand] = None
    # A+B+C inherits A's floor (if selected) and the B+C coherence tolerance; evaluated in `final` with those frozen values
    selection["selected"]["A+B+C"] = ({**selection["selected"]["A_robust"], **selection["selected"]["B+C"]}
                                      if selection["selected"]["A_robust"] and selection["selected"]["B+C"] else None)
    os.makedirs(DOCS_EVAL, exist_ok=True)
    with open(SELECTION_FILE, "w") as f:
        json.dump(selection, f, indent=2, default=float)
    return selection


def stage_final() -> Dict:
    if not os.path.exists(SELECTION_FILE):
        raise SystemExit("no frozen selection: run `python -m torqva.c1_study validate` first (final test data is never used for tuning)")
    with open(SELECTION_FILE) as f:
        sel = json.load(f)
    sel_hash = hashlib.sha256(json.dumps(sel["selected"], sort_keys=True).encode()).hexdigest()[:12]
    used = set(TRAIN_SEEDS) | set(sel["val_seeds_healthy"]) | set(sel["val_seeds_fault"])
    assert not used & (set(TEST_SEEDS_H) | set(TEST_SEEDS_F)), "test seeds overlap train/validation"
    tt, c1, c4, ad4, pooled = train_models()
    chosen = sel["selected"]
    # Frozen values; a candidate with no feasible validation setting falls back to the library default but is flagged as such.
    rel_floor = (chosen.get("A_robust") or {"rel_floor": 0.03})["rel_floor"]
    coh = (chosen.get("B+C") or chosen.get("B_reference") or {"coh_tol": 0.10})["coh_tol"]
    cfg_ref, cfg_coh = ReferenceConfig(coh_tol=coh), CoherenceConfig(coh_tol=coh)
    variants = _variants(tt, c1, c4, ad4, pooled, rel_floor)
    recs = run_conditions(TEST_CONDITIONS, variants, tt, TEST_SEEDS_H, TEST_SEEDS_F, cfg_ref, cfg_coh, f"c1-phase8/{sel_hash}")
    res = {"schema": "C1Phase8Final/1", "data_provenance": "SIMULATED",
           "WARNING": "Simulation only; simulator uncalibrated; no physical motor was operated. Not hardware performance.",
           "selection_file_sha": sel_hash, "frozen": {"A_rel_floor": rel_floor, "coh_tol": coh, "selected": chosen},
           "seeds": {"train": TRAIN_SEEDS, "test_healthy": TEST_SEEDS_H, "test_fault": TEST_SEEDS_F}, "speeds": SPEEDS, "severities": SEVERITIES,
           "faults": FAULTS, "conditions": {c.name: asdict(c) for c in TEST_CONDITIONS},
           "per_condition": aggregate(recs, [v.name for v in variants])}
    with open(os.path.join(DOCS_EVAL, "c1_phase8_final.json"), "w") as f:
        json.dump(res, f, indent=1, default=float)
    with gzip.open(os.path.join(DOCS_EVAL, "c1_phase8_sessions.jsonl.gz"), "wt") as f:
        for r in recs:
            f.write(json.dumps(r, default=float) + "\n")
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stage", choices=["validate", "final"])
    a = ap.parse_args()
    r = stage_validate() if a.stage == "validate" else stage_final()
    print(json.dumps(r.get("selected", r.get("frozen")), indent=1, default=float))


if __name__ == "__main__":
    main()
