"""Lab: reproducible recording sessions, fault-injection records, pre-run checklist, blind sessions,
and matched-condition intervention experiments. SIMULATION ONLY in this build (provenance SIMULATED).

* A session is fully described by its config (regime, seed, speed profile, fault injection). Re-running the
  same config yields the same window hash: that is the reproducibility guarantee, and it is tested.
* The pre-run checklist is a *procedure*, not a safety mechanism. It is required before a run and audited.
* Blind sessions keep the injected fault hidden from API consumers until the model output has been frozen
  (the run stores its posterior first) and a human reveals it.
* Experiments run every action on identical starting conditions (same seed => identical pre-action history),
  so measured outcomes exist for chosen AND non-chosen actions. Good for validating C2 in simulation; it does
  not replace experiments on the real rig.
"""
from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from .hypotheses import HYPS
from .prediction import SIGNALS, StateSummary
from .schemas import Hypothesis
from .scenarios import posterior_from
from .sim import REGIMES, MotorSim, Window, rollout

CHECKLIST = [
    ("guard", "Guard is fitted around all rotating parts"),
    ("masses", "Fault masses / shims are screwed down (never taped or glued)"),
    ("estop", "E-stop function was tested today and logged"),
    ("clear", "Area is clear of people and loose items"),
    ("limits", "Speed cap and duty limits reviewed for this session"),
]
PURPOSES = ("commissioning", "fault_run", "experiment", "evaluation")
MAX_PROFILE_S = 1800


class LabError(Exception):
    pass


def validate_profile(profile: List[Dict[str, float]], max_rpm: float = 3000.0) -> List[Dict[str, float]]:
    if not profile:
        raise LabError("speed profile is empty")
    out, total = [], 0
    for step in profile:
        rpm, hold = float(step["rpm"]), float(step["hold_s"])
        if not (0 < rpm <= max_rpm):
            raise LabError(f"rpm {rpm} outside (0, {max_rpm}]")
        if not (5 <= hold <= 900):
            raise LabError("hold_s must be between 5 and 900")
        total += hold
        out.append({"rpm": rpm, "hold_s": hold})
    if total > MAX_PROFILE_S:
        raise LabError(f"profile longer than {MAX_PROFILE_S}s")
    return out


def config_hash(cfg: Dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(cfg, sort_keys=True, default=str).encode()).hexdigest()[:16]


def window_hash(ws: List[Window]) -> str:
    h = hashlib.sha256()
    for w in ws:
        h.update(np.round(w.features(), 6).tobytes())
        h.update(np.round([w.rpm, w.housing, w.vib_rms], 6).tobytes())
    return h.hexdigest()[:16]


def new_session(purpose: str, operator: str, notes: str, blind: bool, regime: str, seed: int,
                profile: List[Dict[str, float]], fault: Optional[str], severity: float, inject_at_s: int,
                clears_below_rpm: Optional[float], settings: Dict[str, Any]) -> Dict[str, Any]:
    if purpose not in PURPOSES:
        raise LabError(f"purpose must be one of {PURPOSES}")
    if regime not in REGIMES:
        raise LabError(f"unknown regime '{regime}'")
    if fault is not None:
        Hypothesis(fault)                                   # validates
        if not (0.0 < severity <= 1.0):
            raise LabError("severity must be in (0, 1]")
    prof = validate_profile(profile)
    cfg = {"regime": regime, "seed": int(seed), "profile": prof,
           "fault": ({"fault": fault, "severity": float(severity), "inject_at_s": int(inject_at_s),
                      "clears_below_rpm": clears_below_rpm} if fault else None)}
    return {"purpose": purpose, "operator": operator, "notes": notes, "blind": bool(blind), "config": cfg,
            "config_hash": config_hash(cfg), "fault_settings": settings or {},
            "checklist": {"items": {k: False for k, _ in CHECKLIST}, "confirmed_by": None, "complete": False},
            "status": "planned", "revealed": not blind, "result": None, "provenance": "SIMULATED"}


def confirm_checklist(session: Dict[str, Any], items: Dict[str, bool], user: str) -> Dict[str, Any]:
    known = {k for k, _ in CHECKLIST}
    if set(items) - known:
        raise LabError(f"unknown checklist item(s): {sorted(set(items) - known)}")
    session["checklist"]["items"].update({k: bool(v) for k, v in items.items()})
    done = all(session["checklist"]["items"].values())
    session["checklist"]["complete"] = done
    session["checklist"]["confirmed_by"] = user if done else None
    session["checklist"]["confirmed_at"] = time.time() if done else None
    session["status"] = "ready" if done else "planned"
    return session


def redact(session: Dict[str, Any]) -> Dict[str, Any]:
    """Blind sessions hide the injected fault (and anything derived from it) until revealed."""
    if session["revealed"]:
        return session
    s = json.loads(json.dumps(session))
    s["config"]["fault"] = "HIDDEN (blind session)"
    s["fault_settings"] = "HIDDEN (blind session)"
    s["config_hash"] = "HIDDEN (blind session)"
    if s.get("result"):
        s["result"].pop("truth_match", None)
    return s


# ------------------------------------------------------------------------------------------ running
def run_session(session: Dict[str, Any], det, tt, hm) -> Dict[str, Any]:
    if not session["checklist"]["complete"]:
        raise LabError("pre-run checklist is not complete")
    cfg = session["config"]
    sim = MotorSim(cfg["seed"], regime=REGIMES[cfg["regime"]])
    f = cfg["fault"]
    windows: List[Window] = []
    step_of: List[int] = []
    scores = []
    tt2 = type(tt)(); tt2.a, tt2.b = tt.a, tt.b
    tt2.reset(sim.housing)
    t_inject = None
    for i, step in enumerate(cfg["profile"]):
        sim.set_setpoint(step["rpm"])
        for _ in range(int(step["hold_s"])):
            if f and t_inject is None and sim.t >= f["inject_at_s"]:
                sim.inject(Hypothesis(f["fault"]), f["severity"], f["clears_below_rpm"])
                t_inject = sim.t
            w = sim.step(1.0)
            tt2.update(w)
            windows.append(w); step_of.append(i); scores.append(det.score(w))
    sim.stop()
    # per-step summary
    steps = []
    for i, step in enumerate(cfg["profile"]):
        idx = [k for k, s in enumerate(step_of) if s == i]
        sc = [scores[k] for k in idx if scores[k].value is not None]
        steps.append({"rpm": step["rpm"], "hold_s": step["hold_s"], "windows": len(idx), "scored": len(sc),
                      "flagged_fraction": float(np.mean([s.anomalous for s in sc])) if sc else None,
                      "mean_score_over_threshold": float(np.mean([s.value / s.threshold for s in sc])) if sc else None,
                      "mean_housing": float(np.mean([windows[k].housing for k in idx])),
                      "mean_vib_rms": float(np.mean([windows[k].vib_rms for k in idx]))})
    # detection latency relative to the injection time
    run, first = 0, None
    for k, s in enumerate(scores):
        run = run + 1 if (s.anomalous and windows[k].t > (t_inject or 1e9)) else 0
        if run >= 5:
            first = windows[k - 4].t
            break
    # frozen model output (stored BEFORE any reveal)
    zs = [s.z for s in scores if s.anomalous and s.z is not None]
    if len(zs) >= 8:
        post = hm.posterior(zs[-15:])
        model_out = {"abstained": False, "label": post.label(), "top": post.top.value, "top_p": round(post.top_p, 4),
                     "ranked": [(h.value, round(p, 4)) for h, p in post.ranked()]}
    else:
        model_out = {"abstained": True, "reason": f"only {len(zs)} anomalous windows (need 8)"}
    result = {"n_windows": len(windows), "window_hash": window_hash(windows), "steps": steps,
              "first_flag_after_injection_s": None if first is None else float(first - (t_inject or 0)),
              "model_output_frozen": model_out, "provenance": "SIMULATED"}
    session["result"] = result
    session["status"] = "completed"
    return result


def reveal(session: Dict[str, Any]) -> Dict[str, Any]:
    if session["status"] != "completed":
        raise LabError("run the session before revealing it")
    session["revealed"] = True
    truth = session["config"]["fault"]["fault"] if session["config"]["fault"] else None
    out = session["result"]["model_output_frozen"]
    session["result"]["truth_match"] = {"truth": truth, "model": None if out["abstained"] else out["top"],
                                        "correct": (not out["abstained"]) and out["top"] == truth,
                                        "abstained": out["abstained"]}
    return session


def reproduce(session: Dict[str, Any], det, tt, hm) -> Dict[str, Any]:
    import copy
    clone = copy.deepcopy(session)
    clone["checklist"]["complete"] = True
    new = run_session(clone, det, tt, hm)
    return {"original_hash": session["result"]["window_hash"], "rerun_hash": new["window_hash"],
            "identical": new["window_hash"] == session["result"]["window_hash"]}


# ------------------------------------------------------------------------------------------ experiments
def run_experiment(fault: str, severity: float, speed_rpm: float, regime: str, repeats: int, seed0: int,
                   det, tt, hm, pred, horizon: int = 120) -> Dict[str, Any]:
    if regime not in REGIMES:
        raise LabError(f"unknown regime '{regime}'")
    if not (1 <= repeats <= 10):
        raise LabError("repeats must be 1..10")
    h = Hypothesis(fault)
    actions = [("CONTINUE_MONITORING", 0.0), ("REDUCE_SPEED", 0.7 * speed_rpm), ("STOP", 0.0)]
    rows, ranking, matched_ok = [], [], True
    for r in range(repeats):
        seed = seed0 + r
        pre_hashes, measured, predicted = set(), {}, {}
        for a, tgt in actions:
            sim = MotorSim(seed, regime=REGIMES[regime])
            sim.set_setpoint(speed_rpm)
            sim.run(300 if h == Hypothesis.COOLING_FAILURE else 60)
            sim.inject(h, severity)
            pre = sim.run(60)
            pre_hashes.add(window_hash(pre))
            if a == "CONTINUE_MONITORING":
                post, _ = posterior_from(pre, det, tt, hm)
                st = StateSummary.from_windows(pre)
                for aa, tt_ in actions:
                    predicted[aa] = pred.predict(post, st, aa, tt_, horizon)
            if a == "STOP":
                sim.stop()
            elif a == "REDUCE_SPEED":
                sim.set_setpoint(tgt)
            measured[a] = sim.run(horizon)
        matched_ok &= len(pre_hashes) == 1                  # identical starting conditions across actions
        losses = {}
        for a, _ in actions:
            m, p = measured[a], predicted[a]
            exc = max(max(w.housing for w in m) / 50.0, max(w.vib_rms for w in m) / 0.35, max(w.current for w in m) / 2.2)
            realised = max(exc - 1.0, 0.0)
            losses[a] = (round(realised, 2), {"CONTINUE_MONITORING": 0.0, "REDUCE_SPEED": 0.3, "STOP": 1.0}[a])
            for s in SIGNALS:
                y = np.array([getattr(w, s) for w in m[:horizon]])
                err = np.abs(p.mean[s] - y)
                inside = (y >= p.lo[s] - 1e-9) & (y <= p.hi[s] + 1e-9)
                rows.append({"repeat": r, "action": a, "signal": s, "mae": float(err.mean()),
                             "coverage": float(inside.mean()), "persistence_mae": float(np.abs(_persist(pre, s) - y).mean())})
            rows.append({"repeat": r, "action": a, "signal": "RISK", "predicted_risk": float(p.risk),
                         "realised_exceedance": bool(realised > 0)})
        best_measured = min(losses, key=lambda k: losses[k])
        order = sorted(predicted.values(), key=lambda p: (round(p.risk, 2), {"CONTINUE_MONITORING": 0, "REDUCE_SPEED": 0.3, "STOP": 1.0}[p.action]))
        ranking.append({"repeat": r, "predicted_best": order[0].action, "measured_best": best_measured,
                        "agree": order[0].action == best_measured,
                        "all_actions_tied_on_limits": len({v[0] for v in losses.values()}) == 1})
    per = {}
    for a, _ in actions:
        for s in SIGNALS:
            sel = [x for x in rows if x["action"] == a and x["signal"] == s]
            per[f"{a}/{s}"] = {"mae": float(np.mean([x["mae"] for x in sel])),
                               "persistence_mae": float(np.mean([x["persistence_mae"] for x in sel])),
                               "interval_coverage": float(np.mean([x["coverage"] for x in sel]))}
    risk_rows = [x for x in rows if x["signal"] == "RISK"]
    brier = float(np.mean([(x["predicted_risk"] - float(x["realised_exceedance"])) ** 2 for x in risk_rows]))
    return {"fault": fault, "severity": severity, "speed_rpm": speed_rpm, "regime": regime, "repeats": repeats,
            "seeds": [seed0 + i for i in range(repeats)], "matched_starting_conditions": bool(matched_ok),
            "per_action_signal": per, "risk_brier_score": brier, "ranking": ranking,
            "ranking_agreement": f"{sum(r['agree'] for r in ranking)} of {len(ranking)}",
            "ranking_ties": sum(r["all_actions_tied_on_limits"] for r in ranking),
            "validated_c2": False,
            "note": "Simulation experiment. Matched starting conditions by identical seed. Does not validate C2 on hardware.",
            "provenance": "SIMULATED"}


def _persist(pre: List[Window], signal: str) -> float:
    return float(np.mean([getattr(w, signal) for w in pre[-10:]]))
