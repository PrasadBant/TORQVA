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

from .c1_robust import AdaptiveBaselineDetector
from .detection import BaselineDetector, ThermalTracker
from .diagnostics import DiagnosticsModel, run_test_on_sim
from .dispatch import CommandRecord
from .hypotheses import HYPS, HypothesisModel, Posterior, calibrate_temperature
from .prediction import InterventionPredictor, SIGNALS, StateSummary, persistence_prediction
from .recovery import assess
from .scenarios import action_cases, posterior_from, warm_session
from .schemas import ActionType, CommandStatus, Hypothesis, RecoveryOutcome
from .sim import FEATURES, REGIMES, MotorSim, rollout

TRAIN_SEEDS = (0, 101, 102, 11, 12)
SPEEDS_LEARNED = [900, 1200, 1500, 1800, 2100]
TEST_SPEEDS = (1350, 1650, 1950)          # deliberately NOT the training setpoints
SEVERITIES = (0.02, 0.05, 0.1, 0.2, 0.4, 0.8)
FAULTS = [Hypothesis.IMBALANCE, Hypothesis.LOOSENESS, Hypothesis.OVERLOAD, Hypothesis.SUPPLY_VOLTAGE, Hypothesis.SENSOR_FAULT]
CFG = {"bin_width": 300, "percentile": 99.5, "severities": SEVERITIES, "test_speeds": TEST_SPEEDS,
       "train_seeds": TRAIN_SEEDS, "confirm_run": 5}


# ------------------------------------------------------------------ model building (TRAIN sessions only)
def build_models(c2_variant: str = "control"):
    det, tt = AdaptiveBaselineDetector(), ThermalTracker()      # bit-identical to BaselineDetector until a session reference is set
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
    if c2_variant == "noise_aware":                        # opt-in (Phase 10): same point predictions, noise-aware intervals + support status
        from .c2_robust import build_noise_aware
        pred = build_noise_aware(pred, det, tt, hm)
    elif c2_variant != "control":
        raise ValueError(f"unknown c2_variant {c2_variant!r}")
    import copy as _copy
    hm_uncal = _copy.deepcopy(hm); hm_uncal.use_ood = False; hm_uncal.temp = 1.0       # the pre-change policy
    val = validation_cases(det, tt)
    calib = calibrate_temperature(hm, val)
    det.__dict__.setdefault('_extras', {})['hm_uncalibrated'] = hm_uncal
    det.__dict__['_extras']['calibration'] = {**calib, 'validation_cases': len(val)}
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



# ------------------------------------------------------------------ held-out regimes (harder worlds)
EVAL_REGIMES = ("baseline", "noisy", "session_shift", "confusable_sensor", "intermittent", "hard")
SEV_REG = (0.3, 0.6, 0.9)
SEEDS_REG = (8101, 8102, 8103)           # disjoint from training, validation (8001..) and every other test seed
SPEEDS_REG = (1350, 1650, 1950)


def _evidence(det, tt, ws):
    tt.reset(ws[0].housing)
    zs, flagged = [], 0
    for w in ws:
        tt.update(w)
        sc = det.score(w)
        if sc.anomalous and sc.z is not None:
            zs.append(sc.z); flagged += 1
    return zs, flagged


def validation_cases(det, tt):
    """Validation set for temperature calibration: mixed shifted regimes, seeds disjoint from train and test."""
    cases = []
    for regime in ("baseline", "noisy", "session_shift"):
        for h in HYPS:
            for sev in (0.3, 0.6):
                for seed in (8001, 8002):
                    for sp in (1200, 1800):
                        _, ws = warm_session(h, sev, seed, sp, post_s=40 if h != Hypothesis.COOLING_FAILURE else 600, regime=regime)
                        zs, _ = _evidence(det, tt, ws)
                        if len(zs) >= 8:
                            cases.append((zs[-15:], h))
    return cases


def _decide(model: HypothesisModel, zs, pair_rule: bool = False, tests_run: int = 0, test_required=("looseness", "sensor_fault")):
    p = model.posterior(zs[-15:])
    needs_test = pair_rule and p.top.value in test_required and tests_run == 0
    return {"top": p.top, "top_p": p.top_p, "margin": p.margin, "label": p.label(), "needs_test": needs_test,
            "confident": p.label() == "confident" and not needs_test, "posterior": p}


def _prf(conf, order):
    out = {}
    f1s = []
    for i, h in enumerate(order):
        tp = conf[i, i]; fp = conf[:, i].sum() - tp; fn = conf[i, :].sum() - tp
        pr = tp / (tp + fp) if tp + fp else None
        rc = tp / (tp + fn) if tp + fn else None
        f1 = 2 * pr * rc / (pr + rc) if pr and rc else 0.0
        f1s.append(f1)
        out[h] = {"precision": pr, "recall": rc, "f1": f1, "support": int(conf[i, :].sum())}
    return out, float(np.mean(f1s))


def eval_regimes(det, tt, models: Dict[str, HypothesisModel], dm, pred):
    """models: {'uncalibrated': hm without OOD/temperature, 'calibrated': hm with both}. All numbers SIMULATED."""
    order = [h.value for h in HYPS]
    report = {}
    for regime in EVAL_REGIMES:
        sessions = []
        for h in [None] + list(HYPS):
            for sev in ((0.0,) if h is None else SEV_REG):
                for seed in SEEDS_REG:
                    for sp in SPEEDS_REG:
                        post_s = 40 if h != Hypothesis.COOLING_FAILURE else 600
                        s, ws = warm_session(h, sev, seed, sp, post_s=post_s, regime=regime)
                        zs, nflag = _evidence(det, tt, ws)
                        sessions.append({"truth": h, "sev": sev, "zs": zs, "nflag": nflag, "n": len(ws), "sim": s})
        faulty = [x for x in sessions if x["truth"] is not None]
        healthy = [x for x in sessions if x["truth"] is None]
        flagged_f = [x for x in faulty if len(x["zs"]) >= 8]
        flagged_h = [x for x in healthy if len(x["zs"]) >= 8]
        entry = {"sessions": len(sessions), "faulty_sessions": len(faulty), "healthy_sessions": len(healthy),
                 "detection_rate": len(flagged_f) / len(faulty),
                 "healthy_false_incident_rate": len(flagged_h) / max(len(healthy), 1), "policies": {}}
        for name, (model, pair_rule) in models.items():
            conf = np.zeros((len(HYPS), len(HYPS)), dtype=int)
            n_conf = conf_wrong = abstain = correct_all = 0
            decided = [(x, _decide(model, x["zs"], pair_rule)) for x in flagged_f + flagged_h]
            for x, d in decided:
                if x["truth"] is None:                              # healthy but flagged: any diagnosis is wrong
                    n_conf += d["confident"]; conf_wrong += d["confident"]; abstain += (not d["confident"])
                    continue
                conf[HYPS.index(x["truth"]), HYPS.index(d["top"])] += 1
                correct_all += d["top"] == x["truth"]
                n_conf += d["confident"]
                conf_wrong += d["confident"] and d["top"] != x["truth"]
                abstain += (not d["confident"])
            nd = max(len(decided), 1)
            per_class, macro_f1 = _prf(conf, order)
            n_f = max(len(flagged_f), 1)
            pol = {
                "decisions": len(decided),
                "top1_accuracy_all_flagged_faulty": correct_all / n_f,
                "abstention_rate": abstain / nd,
                "confident_decisions": n_conf,
                "false_confident_count": int(conf_wrong),
                "false_confident_rate_of_decisions": conf_wrong / nd,
                "accuracy_when_confident": (1 - conf_wrong / n_conf) if n_conf else None,
                "macro_f1": macro_f1, "per_class": per_class,
                "confusion": {"order": order, "matrix": conf.tolist()},
                "looseness_vs_sensor": {
                    "looseness_called_sensor": int(conf[order.index("looseness"), order.index("sensor_fault")]),
                    "sensor_called_looseness": int(conf[order.index("sensor_fault"), order.index("looseness")]),
                    "looseness_total": int(conf[order.index("looseness"), :].sum()),
                    "sensor_total": int(conf[order.index("sensor_fault"), :].sum())},
            }
            if pair_rule:
                # Follow-up: sessions held back by the pair rule get a T1 speed-step test, then are decided again.
                held = [(x, d) for x, d in decided if d["needs_test"] and x["truth"] is not None]
                fc = ab = ood_n = cor = 0
                for x, d in held:
                    sim = x["sim"]
                    obs, _ = run_test_on_sim(sim, "T1", tt)
                    pst = dm.update(d["posterior"], "T1", obs)
                    ood_n += pst.ood
                    is_conf = pst.label() == "confident"
                    fc += is_conf and pst.top != x["truth"]
                    cor += is_conf and pst.top == x["truth"]
                    ab += not is_conf
                pol["after_T1_for_held_back"] = {"held_back": len(held), "confident_correct": int(cor), "false_confident": int(fc),
                                                 "abstained_or_escalated": int(ab), "test_outcome_unfamiliar": int(ood_n)}
            entry["policies"][name] = pol
        # C2 interval coverage in this regime (predictor calibrated on baseline only)
        cases = [c for h in HYPS for sev in (0.4, 0.8) for seed in (8201, 8202) for sp in (1500, 2000)
                 for c in action_cases(h, sev, seed, sp, det, tt, models["calibrated_ood"][0], regime=regime)]
        cov = pred.evaluate_coverage(cases)
        entry["c2"] = {"coverage_mean": float(np.mean(list(cov.values()))), "coverage_min": float(np.min(list(cov.values()))),
                       "target": pred.target_coverage, "cases": len(cases) // 3,
                       "trusted_by_check": pred.trust(Posterior({h: (0.9 if h == HYPS[0] else 0.02) for h in HYPS}, 10), True).trusted}
        report[regime] = entry
    # Does a diagnostic test separate looseness from the confusable sensor fault? (held-out regime, dm fitted on baseline)
    prior = {h: 0.0 for h in HYPS}
    prior[Hypothesis.LOOSENESS] = prior[Hypothesis.SENSOR_FAULT] = 0.5
    ok = n = 0
    for truth in (Hypothesis.LOOSENESS, Hypothesis.SENSOR_FAULT):
        for seed in range(8301, 8307):
            sim = MotorSim(seed, regime=REGIMES["confusable_sensor"]); sim.set_setpoint(1650); sim.run(60); sim.inject(truth, 0.6)
            obs, _ = run_test_on_sim(sim, "T1", tt)
            ok += dm.update(Posterior(prior, 10), "T1", obs).top == truth; n += 1
    report["_t1_looseness_vs_confusable_sensor"] = {"accuracy_before_test": 0.5, "accuracy_after_test": ok / n, "n": n,
                                                    "note": "T1 signature model fitted on the baseline regime only"}
    return report


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
        "regimes": eval_regimes(det, tt, {"uncalibrated": (det._extras["hm_uncalibrated"], False), "calibrated_ood": (hm, False),
                                       "calibrated_ood_pair_rule": (hm, True)}, dm, pred),
        "calibration": det._extras["calibration"],
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
