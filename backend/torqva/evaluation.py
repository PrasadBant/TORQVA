"""Reproducible evaluation suite -> EvaluationRun JSON.   python -m torqva.evaluation --out run.json

ALL results produced here are SIMULATION results (data_provenance = SIMULATED). The simulator is not calibrated
to the real motor and its fault models are self-consistent with the predictors, so numbers are optimistic and
must never be quoted as hardware performance. A MEASURED section exists but stays empty until real, labelled,
session-split data is recorded (docs/TORQVA_PROGRESS.md).

Protocol: models are fitted on TRAIN sessions (seeds in TRAIN_SEEDS); every metric is computed on TEST sessions
(disjoint seeds, different speeds) whose ground truth is hidden from the pipeline until scoring.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import subprocess
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np

from .detection import BaselineDetector, ThermalTracker
from .diagnostics import DiagnosticsModel, run_test_on_sim
from .dispatch import CommandRecord
from .hypotheses import HYPS, HypothesisModel, Posterior
from .prediction import InterventionPredictor, SIGNALS, StateSummary, persistence_prediction
from .recovery import assess
from .scenarios import action_cases, posterior_from, warm_session
from .schemas import ActionType, CommandStatus, Hypothesis, RecoveryOutcome
from .sim import FEATURES, MotorSim, rollout

TRAIN_SEEDS = (0, 101, 102, 11, 12)
SPEEDS_LEARNED = [900, 1200, 1500, 1800, 2100]
TEST_SPEEDS = (1350, 1650, 1950)          # deliberately NOT the training setpoints
SEVERITIES = (0.02, 0.05, 0.1, 0.2, 0.4, 0.8)
FAULTS = [Hypothesis.IMBALANCE, Hypothesis.LOOSENESS, Hypothesis.OVERLOAD, Hypothesis.SUPPLY_VOLTAGE, Hypothesis.SENSOR_FAULT]
CFG = {"bin_width": 300, "percentile": 99.5, "severities": SEVERITIES, "test_speeds": TEST_SPEEDS,
       "train_seeds": TRAIN_SEEDS, "confirm_run": 5}


# ------------------------------------------------------------------ model building (TRAIN sessions only)
def build_models():
    det, tt = BaselineDetector(), ThermalTracker()
    sim = MotorSim(0)
    data = []
    for sp in SPEEDS_LEARNED:
        sim.set_setpoint(sp); data += sim.run(90)
    tt.fit(data); tt.reset(data[0].housing)
    for w in data:
        tt.update(w)
    det.fit(data)

    def zs_for(h, sev, seed, sp):
        s, ws = warm_session(h, sev, seed, sp, post_s=30 if h != Hypothesis.COOLING_FAILURE else 600)
        tt.reset(ws[0].housing)
        out = []
        for w in ws:
            tt.update(w); sc = det.score(w)
            if sc.z is not None and sc.anomalous:
                out.append(sc.z)
        return out

    hm = HypothesisModel()
    samples = {h: [] for h in HYPS}
    for h in HYPS:
        for sev in (0.3, 0.5, 0.8):
            for seed in (101, 102):
                for sp in (1200, 1800):
                    samples[h] += zs_for(h, sev, seed, sp)[-20:]
    hm.fit(samples)
    dm = DiagnosticsModel(); dm.learn(tt, seeds=(1, 2))
    pred = InterventionPredictor(); pred.fit(tt)
    cal = [c for h in HYPS for sev in (0.3, 0.6, 0.9) for seed in (11, 12) for sp in (1200, 1800)
           for c in action_cases(h, sev, seed, sp, det, tt, hm)]
    pred.calibrate(cal)
    return det, tt, hm, dm, pred, {"healthy_windows": len(data), "hypothesis_samples": {h.value: len(v) for h, v in samples.items()},
                                   "c2_calibration_cases": len(cal)}


# ------------------------------------------------------------------ baselines
def legacy_flags(w) -> bool:
    """The repository's original fixed-threshold monitor (backend/config.py warning limits)."""
    return bool(w.vib_rms > 0.35 or w.current > 2.2 or w.housing > 55.0 or (w.driven and not 21.6 <= w.voltage <= 26.4))


def build_global_detector(tt) -> BaselineDetector:
    """Operating-point-unaware baseline: one Gaussian for all speeds."""
    g = BaselineDetector(bin_width_rpm=1e6)
    sim = MotorSim(0); data = []
    for sp in SPEEDS_LEARNED:
        sim.set_setpoint(sp); data += sim.run(90)
    g.fit(data)
    return g


def _first_run(flags: List[bool], n: int) -> Optional[int]:
    run = 0
    for i, f in enumerate(flags):
        run = run + 1 if f else 0
        if run >= n:
            return i - n + 1
    return None


# ------------------------------------------------------------------ C1
def eval_c1(det, tt, glob):
    n_run = CFG["confirm_run"]
    healthy = {"c1": [0, 0, 0], "global": [0, 0, 0], "legacy": [0, 0, 0]}      # window flags, windows, incident (run) events
    for seed in (201, 202, 203, 204, 205):
        for sp in TEST_SPEEDS:
            s = MotorSim(seed); s.set_setpoint(sp); ws = s.run(300)[20:]
            tt.reset(ws[0].housing)
            f = {"c1": [], "global": [], "legacy": []}
            for w in ws:
                tt.update(w)
                f["c1"].append(det.score(w).anomalous); f["global"].append(glob.score(w).anomalous); f["legacy"].append(legacy_flags(w))
            for k in f:
                healthy[k][0] += sum(f[k]); healthy[k][1] += len(f[k])
                runs, r = 0, 0
                for x in f[k]:
                    r = r + 1 if x else 0
                    runs += (r == n_run)
                healthy[k][2] += runs
    out = {"healthy": {k: {"window_false_alarm_rate": v[0] / v[1], "confirmed_false_incidents": v[2], "windows": v[1]}
                       for k, v in healthy.items()}, "detection": {}}
    for h in FAULTS:
        for sev in SEVERITIES:
            res = {"c1": [], "global": [], "legacy": []}
            for seed in (301, 302, 303):
                for sp in TEST_SPEEDS:
                    s = MotorSim(seed); s.set_setpoint(sp); s.run(60); s.inject(h, sev); ws = s.run(60)[5:]
                    tt.reset(ws[0].housing)
                    f = {"c1": [], "global": [], "legacy": []}
                    for w in ws:
                        tt.update(w)
                        f["c1"].append(det.score(w).anomalous); f["global"].append(glob.score(w).anomalous); f["legacy"].append(legacy_flags(w))
                    for k in f:
                        res[k].append(_first_run(f[k], n_run))
            out["detection"][f"{h.value}@{sev}"] = {k: {"detected_fraction": float(np.mean([r is not None for r in v])),
                                                        "median_delay_s": (float(np.median([r for r in v if r is not None]))
                                                                           if any(r is not None for r in v) else None)}
                                                    for k, v in res.items()}
    return out


# ------------------------------------------------------------------ hypotheses + gate
def eval_hypotheses(det, tt, hm, dm):
    rows, conf = [], np.zeros((len(HYPS), len(HYPS)), dtype=int)
    n_dec = n_corr = n_false_conf = n_conf = n_nodec = 0
    for h in HYPS:
        for sev in (0.2, 0.4, 0.6, 0.8):
            for seed in (401, 402, 403):
                for sp in TEST_SPEEDS[:2]:
                    s, pre = warm_session(h, sev, seed, sp, post_s=40 if h != Hypothesis.COOLING_FAILURE else 700)
                    tt.reset(pre[0].housing); zs = []
                    for w in pre:
                        tt.update(w); sc = det.score(w)
                        if sc.anomalous and sc.z is not None:
                            zs.append(sc.z)
                    if len(zs) < 8:
                        n_nodec += 1
                        rows.append({"truth": h.value, "sev": sev, "decided": False})
                        continue
                    p = hm.posterior(zs[-15:])
                    n_dec += 1; n_corr += (p.top == h)
                    conf[HYPS.index(h), HYPS.index(p.top)] += 1
                    confident = p.top_p >= 0.7 and p.margin >= 0.3
                    n_conf += confident; n_false_conf += (confident and p.top != h)
                    rows.append({"truth": h.value, "sev": sev, "decided": True, "top": p.top.value, "top_p": round(p.top_p, 3)})
    out = {"decided": n_dec, "not_decided_no_anomaly_evidence": n_nodec, "top1_accuracy": n_corr / max(n_dec, 1),
           "random_baseline": 1 / len(HYPS), "confident_decisions": n_conf,
           "false_confident_rate": n_false_conf / max(n_conf, 1), "confusion": {"order": [h.value for h in HYPS], "matrix": conf.tolist()}}
    # Before vs after a diagnostic test, on genuinely ambiguous pairs (prior split between the two candidates)
    pairs = [((Hypothesis.IMBALANCE, Hypothesis.LOOSENESS), "T1"), ((Hypothesis.OVERLOAD, Hypothesis.COOLING_FAILURE), "T4")]
    out["test_value"] = {}
    for (a, b), test in pairs:
        prior = {h: 0.0 for h in HYPS}; prior[a] = prior[b] = 0.5
        ok_after = n = 0
        for truth in (a, b):
            for seed in (501, 502, 503, 504, 505):
                s = MotorSim(seed); s.set_setpoint(1650); s.run(60); s.inject(truth, 0.6)
                obs, _ = run_test_on_sim(s, test, tt)
                post = dm.update(Posterior(prior, 10), test, obs)
                ok_after += (post.top == truth); n += 1
        out["test_value"][f"{a.value}_vs_{b.value}:{test}"] = {"accuracy_before_test": 0.5, "accuracy_after_test": ok_after / n, "n": n}
    return out


# ------------------------------------------------------------------ C2
def eval_c2(det, tt, hm, pred):
    test = [c for h in HYPS for sev in (0.4, 0.8) for seed in (21, 22) for sp in (1500, 2000)
            for c in action_cases(h, sev, seed, sp, det, tt, hm)]
    cov = pred.evaluate_coverage(test)
    mae = {}
    for a in ("CONTINUE_MONITORING", "REDUCE_SPEED", "STOP"):
        for s_ in SIGNALS:
            em, ep = [], []
            for st, post, act, tg, truth in test:
                if act != a:
                    continue
                y = np.array([getattr(w, s_) for w in truth[:120]])
                em.append(np.mean(np.abs(pred._mixture(post, st, act, tg, 120)[0][s_] - y)))
                ep.append(np.mean(np.abs(persistence_prediction(st, 120)[s_] - y)))
            mae[f"{a}/{s_}"] = {"model": float(np.mean(em)), "persistence": float(np.mean(ep))}
    # risk ranking vs measured best action under scenarios that actually approach the limits
    agree = tie = tot = 0
    for h in (Hypothesis.OVERLOAD, Hypothesis.COOLING_FAILURE, Hypothesis.IMBALANCE):
        for seed in (601, 602, 603):
            s = MotorSim(seed); s.set_setpoint(2100); s.run(400 if h == Hypothesis.COOLING_FAILURE else 120)
            s.inject(h, 0.9); pre = s.run(60)
            s.housing = max(s.housing, 44.0)                                       # a motor that is already warm
            post, _ = posterior_from(pre, det, tt, hm)
            st = StateSummary.from_windows(pre)
            ranked = pred.compare(post, st, 0.7 * 2100.0)
            def realised_loss(a):
                r = rollout(s, a, 120, 0.7 * 2100.0 if a == "REDUCE_SPEED" else 0.0)
                exc = max(max(w.housing for w in r) / 50.0, max(w.vib_rms for w in r) / 0.35, max(w.current for w in r) / 2.2)
                return (round(max(exc - 1.0, 0.0), 2), {"CONTINUE_MONITORING": 0, "REDUCE_SPEED": 0.3, "STOP": 1.0}[a])
            best = min(("CONTINUE_MONITORING", "REDUCE_SPEED", "STOP"), key=realised_loss)
            tot += 1; agree += (ranked[0].action == best)
            tie += (len({realised_loss(a)[0] for a in ("CONTINUE_MONITORING", "REDUCE_SPEED", "STOP")}) == 1)
    return {"mae": mae, "coverage_mean": float(np.mean(list(cov.values()))), "coverage_min": float(np.min(list(cov.values()))),
            "coverage_target": pred.target_coverage, "n_cases": len(test) // 3,
            "ranking_vs_measured_best": {"agree": agree, "total": tot, "scenarios_where_all_actions_equal_on_limits": tie},
            "validated_by_intervention_experiments": pred.validated_by_experiments}


# ------------------------------------------------------------------ C5
def eval_c5(det, tt):
    tp = fp = fn = tn = 0
    rows = []
    for fixed in (True, False):
        for seed in range(701, 711):
            for h in (Hypothesis.IMBALANCE, Hypothesis.OVERLOAD):
                s = MotorSim(seed); s.set_setpoint(1500); s.run(60); s.inject(h, 0.6); s.run(30); s.t = 100.0
                s.set_setpoint(1260)
                if fixed:
                    s.inject(None)
                ws = s.run(400)
                cmd = CommandRecord(1, ActionType.REDUCE_SPEED, "SET_SPEED", {}, "x", "SIMULATION", 99.0, 5000)
                cmd.status = CommandStatus.COMPLETED; cmd.acked_at = 100.0
                a = assess(cmd, ws, det, tt, ws[-1].t)
                said = a.outcome == RecoveryOutcome.RECOVERED
                tp += (said and fixed); fp += (said and not fixed); fn += ((not said) and fixed); tn += ((not said) and not fixed)
                rows.append({"truly_recovered": fixed, "declared": a.outcome.value})
    return {"cases": len(rows), "true_recoveries_declared": tp, "FALSE_RECOVERY_DECLARATIONS": fp, "missed_recoveries": fn,
            "correct_non_recoveries": tn}


# ------------------------------------------------------------------ driver
def git_sha() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], stderr=subprocess.DEVNULL).decode().strip()
    except Exception:
        return "unknown"


def run_all() -> Dict:
    t0 = time.time()
    det, tt, hm, dm, pred, sizes = build_models()
    glob = build_global_detector(tt)
    res = {
        "schema": "EvaluationRun/1",
        "data_provenance": "SIMULATED",
        "WARNING": "Simulation only. The simulator is uncalibrated and self-consistent with the predictors; do not quote as hardware results.",
        "git_sha": git_sha(),
        "config_hash": hashlib.sha256(json.dumps(CFG, sort_keys=True, default=str).encode()).hexdigest()[:12],
        "config": json.loads(json.dumps(CFG, default=str)),
        "model_versions": {"baseline_detector": det.version, "hypothesis_model": hm.version, "diagnostics": dm.version,
                           "predictor": pred.version},
        "train_dataset": sizes,
        "test_protocol": "test sessions use seeds and speeds disjoint from training; labels hidden until scoring",
        "measured": {"status": "NO MEASURED DATA: no real labelled sessions recorded yet"},
        "c1": eval_c1(det, tt, glob),
        "hypotheses": eval_hypotheses(det, tt, hm, dm),
        "c2": eval_c2(det, tt, hm, pred),
        "c5": eval_c5(det, tt),
    }
    res["runtime_s"] = round(time.time() - t0, 1)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="evaluation_run.json")
    a = ap.parse_args()
    r = run_all()
    with open(a.out, "w") as f:
        json.dump(r, f, indent=2, default=float)
    print(f"wrote {a.out} ({r['runtime_s']} s)")


if __name__ == "__main__":
    main()
