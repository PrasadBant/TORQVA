"""Analyst workbench for the SOFTWARE SIMULATOR (simulation mode only; every record is SIMULATED / PREDICTED).

Four things, all built on the existing models rather than new ones:

* plan()            what C1 and the hypothesis model currently say, which features drive the ranking (a decomposition of the
                    hypothesis model's own log-likelihood), and the expected information gain of each C4 test.
* run_sequence()    an ordered diagnostic sequence (speed profile, T1, T3, T4) executed on a COPY of the live simulated motor
                    (same state, same injected fault, same random stream). The live run is not touched. Every window is the
                    simulator's own, scored by the live C1 detector; evidence is fused by the existing hypothesis model and the
                    learned C4 outcome signatures, only where those signatures apply.
* predict_targets() C2 predictions for analyst-chosen REDUCE_SPEED targets, plus the CONTINUE_MONITORING and STOP references,
                    each tied to the state it was computed from so a later request can tell when it is stale. A pure read
                    (GET): it changes no state and, like all of C2, has no path to the device.
* check_action() /  the deterministic gate and the Safety Supervisor applied to an analyst-selected action. Execution is only
  request_action()  possible by replacing the action that the pipeline itself is holding for human approval, and it goes through
                    Orchestrator.approve() -> Safety Supervisor -> dispatcher -> simulated device ack -> C5, like every action.

Nothing here can reach the physical device: it only reads and writes the simulator's Orchestrator.
"""
from __future__ import annotations

import copy
import itertools
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from .diagnostics import TESTS, obs_t1, run_test_on_sim
from .gate import decide
from .hypotheses import HYPS, Posterior
from .incident import S
from .lab import LabError, validate_profile
from .prediction import CHECK_HORIZONS, SIGNALS
from .schemas import ActionType, DecisionVerdict, GateVerdict, ProposalSource, ProposedAction, Role
from .sim import FEATURES

MAX_SEQUENCE_STEPS = 6
MAX_SEQUENCE_S = 2400                 # simulated seconds for a whole sequence (profile cap 1800 s + fixed tests)
MAX_TARGETS = 3
MAX_PREDICTION_AGE_S = 30.0           # a prediction older than this (simulation time) must be recomputed before it is acted on
T1_LEARNED = {"fraction": 0.70, "from_rpm": 1800.0}    # DiagnosticsModel.learn(): step-down to 70 % from 1800 rpm
FIXED_TEST_PARAMS = {"T1": "step down to 70 % of the current setpoint for 40 s (after 20 s before)",
                     "T3": "hold speed and observe 300 s", "T4": "run 10 s, disable the driver, observe the coast for 40 s"}
_ids = itertools.count(1)


class WorkbenchError(Exception):
    def __init__(self, msg: str, status: int = 409):
        super().__init__(msg)
        self.status = status


def _r(x, d=4):
    return None if x is None or not np.isfinite(x) else round(float(x), d)


def _ranked(post: Optional[Posterior]):
    return [(h.value, _r(p)) for h, p in post.ranked()] if post else []


def _post_view(post: Optional[Posterior]) -> Optional[Dict[str, Any]]:
    if post is None:
        return None
    return {"ranked": _ranked(post), "label": post.label(), "top": post.top.value, "top_p": _r(post.top_p),
            "margin": _r(post.margin), "ood": bool(post.ood), "n_windows": post.n_windows, "entropy_nats": _r(post.entropy)}


def limits_view(orch) -> Dict[str, Any]:
    lim = orch.sup.limits
    sp = float(orch.dev.sim.setpoint)
    return {"max_rpm": lim.max_rpm, "profile_hold_s": [5, 900], "profile_max_s": 1800, "sequence_max_s": MAX_SEQUENCE_S,
            "max_steps": MAX_SEQUENCE_STEPS, "setpoint_rpm": sp,
            "reduce_envelope_rpm": [round(sp * lim.min_speed_fraction, 1), sp] if sp > 0 else None,
            "reduce_envelope_note": f"REDUCE_SPEED must be at least {lim.min_speed_fraction:.0%} of the current setpoint and below it (Safety Supervisor)",
            "stop_limits": {"housing_c": lim.temp_stop_c, "current_a": lim.current_stop_a, "voltage_v": [lim.volt_min_v, lim.volt_max_v],
                            "vib_rms_g": lim.vib_rms_stop_g}}


def _round10(x: float) -> float:
    return float(round(x / 10.0) * 10.0)


def quick_rpm(orch) -> List[float]:
    """Quick-select speeds for a test profile: fractions of the CURRENT simulated setpoint, inside the simulator's range."""
    sp, mx = float(orch.dev.sim.setpoint), orch.sup.limits.max_rpm
    if sp <= 0:
        return []
    vals = {_round10(sp * f) for f in (1.0, 0.85, 0.7, 0.5)}
    return sorted((v for v in vals if 0 < v <= mx), reverse=True)


def suggested_targets(orch) -> List[Dict[str, Any]]:
    """Up to three REDUCE_SPEED targets inside the Safety Supervisor's envelope: the pipeline's own target (reduce_fraction) and a
    smaller and a larger reduction around it. Every one is still predicted, gated and supervised before anything can happen."""
    sp, lim = float(orch.dev.sim.setpoint), orch.sup.limits
    if sp <= 0:
        return []
    lo = sp * lim.min_speed_fraction
    base = orch.cfg.reduce_fraction
    out, seen = [], set()
    for frac, why in ((base, f"the pipeline's own reduction ({base:.0%} of setpoint)"), (min(0.9, base + 0.15), "a smaller reduction"),
                      (max(lim.min_speed_fraction, base - 0.2), "a larger reduction")):
        v = _round10(sp * frac)
        v = min(max(v, _round10(lo + 5)), _round10(sp - 10))
        if lo <= v < sp and v not in seen:
            seen.add(v)
            out.append({"target_rpm": v, "fraction": round(v / sp, 3), "why": why})
    return out


# ------------------------------------------------------------------------------------------------ plan (C1 + hypotheses + C4)
def _evidence_matrix(orch) -> Optional[np.ndarray]:
    zs = orch._evidence()
    return np.clip(np.vstack(zs), -30, 30) if zs else None


def hypothesis_evidence(hm, Z: Optional[np.ndarray], post: Optional[Posterior], dm) -> List[Dict[str, Any]]:
    """Per hypothesis: which features favour it or count against it COMPARED WITH ITS NEAREST COMPETITOR (the top hypothesis for every
    other one, the runner-up for the top one), using the hypothesis model's own per-feature log-likelihood terms averaged over the
    evidence windows; and which learned C4 outcome signature separates the two most."""
    hs = [h for h in HYPS if h in hm.mu]
    if not hs:
        return []
    probs = post.probs if post else {h: None for h in HYPS}
    terms = None
    if Z is not None:
        terms = {h: np.mean(-0.5 * ((Z - hm.mu[h]) ** 2 / hm.var[h] + np.log(hm.var[h])), axis=0) for h in hs}
        zbar = Z.mean(axis=0)
    order = sorted(hs, key=lambda h: -(probs.get(h) or 0.0))
    out = []
    for h in order:
        row: Dict[str, Any] = {"hypothesis": h.value, "probability": _r(probs.get(h)) if probs.get(h) is not None else None}
        rival = next((r for r in order if r != h), None)
        row["compared_with"] = rival.value if rival is not None else None
        if terms is not None and rival is not None:
            rel = terms[h] - terms[rival]
            idx = np.argsort(-rel)
            row["supporting"] = [{"feature": FEATURES[i], "observed_z": _r(zbar[i], 2), "signature_z": _r(hm.mu[h][i], 2), "relative_loglik": _r(rel[i], 3)}
                                 for i in idx[:3] if rel[i] > 0.05]
            row["contradicting"] = [{"feature": FEATURES[i], "observed_z": _r(zbar[i], 2), "signature_z": _r(hm.mu[h][i], 2), "relative_loglik": _r(rel[i], 3)}
                                    for i in idx[::-1][:3] if rel[i] < -0.05]
        best = None
        if rival is not None:
            for t, m in dm.models.items():
                if h in m.mu and rival in m.mu:
                    d = float(np.max(np.abs(m.mu[h] - m.mu[rival]) / np.sqrt(m.var[h] + m.var[rival])))
                    if best is None or d > best["separation"]:
                        best = {"test": t, "versus": rival.value, "separation": round(d, 2)}
        row["best_separating_test"] = best
        out.append(row)
    return out


def plan(orch, dm, hm) -> Dict[str, Any]:
    w = orch.buf[-1] if orch.buf else None
    sc = orch.scores[-1] if orch.scores else None
    post = orch.post
    Z = _evidence_matrix(orch)
    feats = []
    if Z is not None:
        zbar = Z.mean(axis=0)
        feats = [{"feature": FEATURES[i], "mean_z": _r(zbar[i], 2)} for i in np.argsort(-np.abs(zbar))[:6]]
    ctx = orch._ctx()
    tests = []
    for t in TESTS:
        from .pipeline import TEST_PARAMS
        d = orch.sup.check(ProposedAction(action=ActionType.RUN_TEST, params=dict(TEST_PARAMS[t]), source=ProposalSource.GATE, role=orch.role), ctx)
        tests.append({"test": t, "fixed_parameters": FIXED_TEST_PARAMS[t],
                      "expected_info_gain_nats": _r(max(0.0, dm.expected_info_gain(post, t)), 3) if (post and t in dm.models) else None,
                      "pipeline_may_run": t in orch.cfg.allowed_tests,
                      "supervisor_now": {"verdict": d.verdict.value, "reasons": d.reasons}})
    allowed = [x["test"] for x in tests if x["supervisor_now"]["verdict"] in ("ALLOW", "DEFER")]
    bt = dm.best_test(post, allowed) if (post and allowed) else None
    g = orch.last_gate
    return {
        "provenance": "SIMULATED", "t": orch.now,
        "window": None if w is None else {"t": w.t, "rpm": w.rpm, "setpoint": w.setpoint, "current": w.current, "voltage": w.voltage,
                                          "power": w.power, "housing": w.housing, "vib_rms": w.vib_rms, "valid": w.valid, "driven": w.driven},
        "c1": None if sc is None else {"status": sc.status, "anomalous": bool(sc.anomalous),
                                       "score_over_threshold": _r(sc.value / sc.threshold, 3) if (sc.value is not None and sc.threshold) else None,
                                       "anomalous_run": orch.anom_run, "confirm_windows": orch.cfg.confirm_windows},
        "incident": None if orch.inc is None else {"id": orch.inc.id, "state": orch.inc.state.value, "tests_run": orch.inc.tests_run},
        "evidence_windows": 0 if Z is None else int(Z.shape[0]), "min_evidence_windows": orch.cfg.min_evidence_windows,
        "top_features": feats, "posterior": _post_view(post), "hypotheses": hypothesis_evidence(hm, Z, post, dm),
        "tests": tests,
        "recommended_test": None if not bt else {"test": bt[0], "expected_info_gain_nats": _r(max(0.0, bt[1]), 3),
                                                  "worth_running": bt[1] >= orch.gate_cfg.min_info_gain_nats,
                                                  "gate_min_info_gain_nats": orch.gate_cfg.min_info_gain_nats},
        "gate": None if g is None else {"verdict": g.verdict.value, "reason": g.reason, "test": g.test},
        "limits": limits_view(orch), "quick_rpm": quick_rpm(orch), "suggested_targets": suggested_targets(orch),
        "sufficiency": sufficiency(orch, dm),
    }


# ------------------------------------------------------------------------------------------------ diagnostic sequence (C4)
def _limit_crossed(w, lim) -> Optional[str]:
    if w.housing >= lim.temp_stop_c:
        return f"housing {w.housing:.1f} °C reached the {lim.temp_stop_c:.0f} °C stop limit"
    if w.current >= lim.current_stop_a:
        return f"current {w.current:.2f} A reached the {lim.current_stop_a:.1f} A stop limit"
    if w.driven and not (lim.volt_min_v <= w.voltage <= lim.volt_max_v):
        return f"voltage {w.voltage:.2f} V left the {lim.volt_min_v:.1f}–{lim.volt_max_v:.1f} V range"
    if lim.vib_rms_stop_g > 0 and w.vib_rms >= lim.vib_rms_stop_g:
        return f"vibration {w.vib_rms:.3f} g reached the {lim.vib_rms_stop_g:.2f} g stop limit"
    return None


def _row(w, sc, step: int, test: str) -> Dict[str, Any]:
    return {"t": round(w.t, 1), "test": test, "step": step, "setpoint": _r(w.setpoint, 1), "rpm": _r(w.rpm, 1), "current": _r(w.current, 4),
            "voltage": _r(w.voltage, 3), "power": _r(w.power, 3), "housing": _r(w.housing, 3), "vib_rms": _r(w.vib_rms, 4), "valid": bool(w.valid),
            "score": _r(sc.value / sc.threshold, 3) if (sc.value is not None and sc.threshold) else None, "score_status": sc.status,
            "anomalous": bool(sc.anomalous)}


def _summary(rows: List[Dict], target: Optional[float]) -> Dict[str, Any]:
    settled = rows[len(rows) // 2:] or rows                      # second half of a hold: past the speed transient
    def m(k, rs=settled):
        v = [r[k] for r in rs if r[k] is not None and r["valid"]]
        return _r(float(np.mean(v)), 4) if v else None
    scored = [r for r in rows if r["score"] is not None]
    rpm = m("rpm")
    return {"target_rpm": target, "windows": len(rows), "valid_windows": sum(r["valid"] for r in rows), "scored_windows": len(scored),
            "mean_rpm_settled": rpm, "tracking_error_rpm": _r(rpm - target, 1) if (rpm is not None and target) else None,
            "mean_current": m("current"), "mean_voltage": m("voltage"), "mean_power": m("power"), "mean_vib_rms": m("vib_rms"),
            "housing_start": rows[0]["housing"] if rows else None, "housing_end": rows[-1]["housing"] if rows else None,
            "flagged_fraction": _r(sum(r["anomalous"] for r in scored) / len(scored), 3) if scored else None,
            "mean_score_over_threshold": _r(float(np.mean([r["score"] for r in scored])), 3) if scored else None,
            "unscored_statuses": sorted({r["score_status"] for r in rows if r["score"] is None})}


def validate_sequence(steps: Sequence[Dict[str, Any]], max_rpm: float) -> List[Dict[str, Any]]:
    if not steps:
        raise WorkbenchError("the sequence is empty", 422)
    if len(steps) > MAX_SEQUENCE_STEPS:
        raise WorkbenchError(f"at most {MAX_SEQUENCE_STEPS} tests per sequence", 422)
    out, total = [], 0
    for s in steps:
        kind = s.get("type")
        if kind == "profile":
            try:
                prof = validate_profile(list(s.get("profile") or []), max_rpm=max_rpm)
            except LabError as e:
                raise WorkbenchError(f"speed profile: {e}", 422)
            total += sum(p["hold_s"] for p in prof)
            out.append({"type": "profile", "profile": prof})
        elif kind in TESTS:
            total += {"T1": 60, "T3": 300, "T4": 50}[kind]
            out.append({"type": kind})
        else:
            raise WorkbenchError(f"unknown test type '{kind}'", 422)
    if total > MAX_SEQUENCE_S:
        raise WorkbenchError(f"sequence lasts {total:.0f} simulated seconds; the limit is {MAX_SEQUENCE_S}", 422)
    return out


def run_sequence(orch, dm, hm, steps: Sequence[Dict[str, Any]], stop_when_confident: bool = True, user: str = "",
                 scenario: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    lim = orch.sup.limits
    seq = validate_sequence(steps, lim.max_rpm)
    if orch.dev.estop:
        raise WorkbenchError("the simulated device has latched an emergency stop; clear it before testing")
    if orch.test_running:
        raise WorkbenchError(f"the pipeline is running test {orch.test_running} on the live simulation; wait for it to finish")
    if orch.dev.sim.setpoint <= 0:
        raise WorkbenchError("the simulated motor is stopped; diagnostic tests need it running (as the Safety Supervisor requires)")

    sim = copy.deepcopy(orch.dev.sim)                     # same physical state, injected fault and random stream as the live run
    det = copy.deepcopy(orch.det)
    tt = copy.deepcopy(orch.tt)
    post0 = orch.post
    post = post0 if post0 is not None else Posterior({h: 1.0 / len(HYPS) for h in HYPS}, 0)
    informed = [post0 is not None]
    unfamiliar: List[str] = []                            # tests whose outcome was unlike every learned signature                        # a uniform prior that no evidence has updated is "no ranking", not 1/6 each
    view = lambda p: _post_view(p) if informed[0] else None
    rows: List[Dict[str, Any]] = []
    wins: List[Any] = []                                  # the simulator's Window objects, aligned with rows
    results: List[Dict[str, Any]] = []
    all_z: List[np.ndarray] = []
    stop_reason = None

    def take(ws, step, test):
        crossed = None
        for w in ws:
            tt.update(w)
            sc = det.score(w)
            rows.append(_row(w, sc, step, test)); wins.append(w)
            if sc.anomalous and sc.z is not None and w.valid:
                all_z.append(sc.z)
            crossed = crossed or _limit_crossed(w, lim)
        return crossed

    for k, spec in enumerate(seq):
        kind = spec["type"]
        if stop_reason:
            results.append({"index": k, "type": kind, "status": "skipped", "reason": stop_reason})
            continue
        if sim.setpoint <= 0:
            results.append({"index": k, "type": kind, "status": "skipped", "reason": "the simulated motor is not driven (a coast-down leaves it stopped)"})
            stop_reason = "an earlier test left the simulated motor stopped"
            continue
        before_post = post
        start = len(rows)
        res: Dict[str, Any] = {"index": k, "type": kind, "status": "completed", "posterior_before": view(before_post)}
        if kind == "profile":
            steps_out, crossed = [], None
            for i, st in enumerate(spec["profile"]):
                sim.set_setpoint(st["rpm"])
                s0 = len(rows)
                for _ in range(int(st["hold_s"])):
                    crossed = take([sim.step(1.0)], i, "profile") or crossed
                    if crossed:
                        break
                steps_out.append({"step": i, "hold_s": st["hold_s"], "_range": (s0, len(rows)), **_summary(rows[s0:], st["rpm"])})
                if crossed:
                    break
            res["steps"] = steps_out
            # speed scaling between consecutive settled steps: the same observation T1 computes, for every pair
            pairs, applied = [], None
            for a, b in zip(steps_out, steps_out[1:]):
                (a0, a1), (b0, b1) = a["_range"], b["_range"]
                if a1 - a0 < 20 or b1 - b0 < 20 or not a["mean_rpm_settled"] or not b["mean_rpm_settled"]:
                    continue
                wa, wb = wins[a0:a1], wins[b0:b1]
                ratio = b["mean_rpm_settled"] / a["mean_rpm_settled"]
                if abs(np.log(ratio)) < 0.05:
                    continue
                obs = obs_t1(wa[len(wa) // 2:], wb[-15:])
                pair = {"from_step": a["step"], "to_step": b["step"], "speed_ratio": round(ratio, 3), "vib_1x_speed_exponent": _r(obs[0], 3),
                        "harmonics_speed_exponent": _r(obs[1], 3), "log_change_current_per_rpm": _r(obs[2], 4)}
                learned = (0.62 <= ratio <= 0.78) and abs(a["mean_rpm_settled"] - T1_LEARNED["from_rpm"]) <= 0.2 * T1_LEARNED["from_rpm"]
                if learned and applied is None and "T1" in dm.models:
                    post = dm.update(post, "T1", obs)
                    informed[0] = True
                    if post.ood:
                        unfamiliar.append(f"profile step pair {a['step'] + 1}→{b['step'] + 1}")
                    applied = pair["from_step"]
                    pair["t1_signature_applied"] = True
                else:
                    pair["t1_signature_applied"] = False
                pairs.append(pair)
            res["speed_scaling"] = pairs
            for x in steps_out:
                x.pop("_range", None)
            res["t1_signature_note"] = ("The learned T1 outcome signature (a 70 % step-down from about 1800 rpm) was applied to one step pair."
                                        if applied is not None else "No step pair matched the conditions the T1 signature was learned at "
                                        "(a step-down to 62–78 % from 1440–2160 rpm), so the exponents are reported as observations only.")
            if crossed:
                res["status"], res["reason"] = "aborted", crossed
        else:
            ws, obs = None, None
            if kind == "T1":
                obs, ws = _run_fixed(sim, "T1", tt)
            elif kind == "T3":
                obs, ws = _run_fixed(sim, "T3", tt)
            else:
                obs, ws = _run_fixed(sim, "T4", tt)
            crossed = take(ws, 0, kind)
            res["observation"] = [_r(x, 4) for x in obs]
            res["observation_meaning"] = {"T1": ["1x vibration speed exponent", "2x+3x harmonics speed exponent", "log change of current per rpm"],
                                          "T3": ["housing thermal-residual slope, °C per 100 s"], "T4": ["ln tau of the coast-down (s)"]}[kind]
            res["fixed_parameters"] = FIXED_TEST_PARAMS[kind]
            res["summary"] = _summary(rows[start:], None)
            if crossed:
                res["status"], res["reason"] = "aborted", crossed
            elif kind in dm.models:
                post = dm.update(post, kind, obs)
                informed[0] = True
                if post.ood:
                    unfamiliar.append(kind)
                res["signature_applied"] = True
        valid_frac = (sum(r["valid"] for r in rows[start:]) / max(1, len(rows) - start))
        if res["status"] == "completed" and valid_frac < 0.8:
            res["status"], res["reason"] = "invalid", f"only {valid_frac:.0%} of the windows were valid"
        res["posterior_after"] = view(post)
        res["windows"] = [len(rows) - start]
        results.append(res)
        if res["status"] in ("aborted", "invalid"):
            stop_reason = f"test {k + 1} was {res['status']}: {res.get('reason')}"
        elif stop_when_confident and post.label() == "confident" and not post.ood and k < len(seq) - 1:
            stop_reason = "the evidence became sufficient (confident ranking); the remaining tests were not needed"

    # multi-speed C1 evidence fused by the hypothesis model, with the test-updated ranking as the prior
    fused = None
    if len(all_z) >= orch.cfg.min_evidence_windows:
        fused = hm.posterior(all_z[-3 * orch.cfg.posterior_windows:], prior=dict(post.probs))
    final = fused or post
    if fused is not None:
        informed[0] = True
    scored = [r for r in rows if r["score"] is not None]
    flagged = (sum(r["anomalous"] for r in scored) / len(scored)) if scored else None
    statuses = [r["status"] for r in results]
    speeds = sorted({r["setpoint"] for r in rows if r["setpoint"]})
    if "aborted" in statuses:
        cat = ("aborted", next(r["reason"] for r in results if r["status"] == "aborted"))
    elif "invalid" in statuses or not scored:
        cat = ("invalid", "required measurements were unavailable or invalid" if scored else "no window could be scored by C1 at these speeds")
    elif unfamiliar:
        cat = ("inconclusive", f"the outcome of {', '.join(unfamiliar)} was unlike every learned signature, so no hypothesis is treated as supported")
    elif informed[0] and final.label() == "confident" and not final.ood and (flagged or 0) > 0:
        cat = ("hypothesis_supported", f"the evidence supports '{final.top.value}' ({final.top_p:.0%}, margin {final.margin:.2f})")
    elif (flagged or 0) >= 0.2:
        cat = ("anomalous", f"{flagged:.0%} of scored windows were above the learned threshold; the cause is not yet clear")
    elif (flagged or 0) < 0.05 and len(scored) >= 0.8 * len(rows):
        cat = ("consistent_with_baseline", f"{flagged:.0%} of scored windows were flagged over the tested setpoints")
    else:
        cat = ("inconclusive", "the evidence neither clearly matches the baseline nor a fault signature")
    ran = {r["type"] for r in results if r["status"] == "completed"}
    left = [t for t in TESTS if t not in ran and t in dm.models]
    nxt = dm.best_test(final, left) if left else None

    rid = f"D-{next(_ids):04d}"
    record = {
        "id": rid, "provenance": "SIMULATED", "executed_on": "a copy of the live simulated motor (the live run was not changed)",
        "started_at_sim_t": orch.now, "requested_by": user, "sequence": seq, "results": results,
        "fused": {"posterior": _post_view(fused), "evidence_windows": len(all_z),
                  "note": "C1 evidence from all tested speeds, ranked by the hypothesis model with the test-updated ranking as prior"
                  if fused else f"only {len(all_z)} anomalous windows (the model needs {orch.cfg.min_evidence_windows}); no fused ranking"},
        "posterior_start": _post_view(post0), "posterior_final": view(final),
        "assessment": {"category": cat[0], "detail": cat[1], "tested_setpoints_rpm": speeds,
                       "baseline_note": "C1 compares each window with the healthy baseline learned per speed bin; windows in an unlearned bin are not compared"
                       + (f" (unscored: {', '.join(sorted({r['score_status'] for r in rows if r['score'] is None}))})" if len(scored) < len(rows) else "")},
        "recommended_next": None if not nxt else {"test": nxt[0], "expected_info_gain_nats": _r(max(0.0, nxt[1]), 3),
                                                  "worth_running": nxt[1] >= orch.gate_cfg.min_info_gain_nats},
        "scenario_truth": (orch.dev.sim.truth.fault.value if orch.dev.sim.truth.fault else None),
        "scenario_note": _scenario_note(orch, scenario),
        "limits": limits_view(orch),
    }
    orch._put("diagnostic_run", rid, {k: v for k, v in record.items()}, "SIMULATED", orch.now)
    orch._log("diagnostic_run", id=rid, tests=[s["type"] for s in seq], category=cat[0], statuses=statuses)
    return {**record, "series": rows if len(rows) <= 2400 else rows[:: int(np.ceil(len(rows) / 2400))]}


def _scenario_note(orch, sc: Optional[Dict[str, Any]]) -> str:
    truth = orch.dev.sim.truth.fault
    if truth is not None:
        return f"the copy carries the injected fault ({truth.value}); it is scenario ground truth, not a TORQVA diagnosis"
    if sc and sc.get("fault") and orch.now < float(sc.get("inject_after_s") or 0):
        return (f"the scenario injects {sc['fault']} at t = {sc['inject_after_s']} s, which had not happened when the test started; "
                "the copy ran without it")
    return "no fault was active in the simulated motor when the test started"


def _run_fixed(sim, test, tt):
    return run_test_on_sim(sim, test, copy.deepcopy(tt))


# ------------------------------------------------------------------------------------------------ predictions for chosen targets (C2)
def basis_of(orch) -> Dict[str, Any]:
    post = orch.post
    return {"t": orch.now, "setpoint_rpm": float(orch.dev.sim.setpoint), "incident": orch.inc.id if orch.inc else None,
            "posterior_top": post.top.value if post else None, "posterior_label": post.label() if post else None,
            "posterior_windows": post.n_windows if post else 0}


def stale_reasons(orch, basis: Optional[Dict[str, Any]]) -> List[str]:
    if not basis:
        return ["no prediction basis was supplied"]
    now = basis_of(orch)
    why = []
    if now["t"] - float(basis.get("t", -1e9)) > MAX_PREDICTION_AGE_S:
        why.append(f"computed {now['t'] - float(basis.get('t', 0)):.0f} s of simulation time ago (limit {MAX_PREDICTION_AGE_S:.0f} s)")
    if abs(now["setpoint_rpm"] - float(basis.get("setpoint_rpm", -1))) > 0.5:
        why.append("the setpoint changed since it was computed")
    if now["incident"] != basis.get("incident"):
        why.append("the incident changed")
    if now["posterior_top"] != basis.get("posterior_top") or now["posterior_label"] != basis.get("posterior_label"):
        why.append("the hypothesis ranking changed")
    return why


def _pred_view(p, cid: str, basis: Dict[str, Any], sp: float, env_lo: float) -> Dict[str, Any]:
    idx = [h - 1 for h in CHECK_HORIZONS]
    env_ok = p.action != "REDUCE_SPEED" or (env_lo <= p.target_rpm < sp)
    return {"candidate_id": cid, "action": p.action, "target_rpm": _r(p.target_rpm, 1) if p.action == "REDUCE_SPEED" else (0.0 if p.action == "STOP" else None),
            "horizons_s": list(CHECK_HORIZONS),
            "mean": {s: [_r(p.mean[s][i], 4) for i in idx] for s in p.mean},
            "lo": {s: [_r(p.lo[s][i], 4) for i in idx] for s in p.lo}, "hi": {s: [_r(p.hi[s][i], 4) for i in idx] for s in p.hi},
            "risk": _r(p.risk, 4), "risk_by_signal": {k: _r(v, 4) for k, v in p.risk_by_signal.items()},
            "status": p.status, "status_reasons": p.status_reasons, "interval_method": p.interval_method,
            "interval_meaning": "90 % interval for a single future 1 s simulated measurement; not a guarantee and not a probability of success",
            "within_supervisor_envelope": bool(env_ok), "basis": basis, "provenance": "PREDICTED"}


def predict_targets(orch, targets: Sequence[float]) -> Dict[str, Any]:
    if orch.post is None:
        raise WorkbenchError("C2 predictions are conditional on a fault-hypothesis ranking, and none exists yet in this run")
    if len(orch.buf) < 10:
        raise WorkbenchError("at least 10 simulated windows are needed to summarise the current state")
    sp = float(orch.dev.sim.setpoint)
    lim = orch.sup.limits
    ts = []
    for t in targets:
        t = float(t)
        if not np.isfinite(t) or not (0 < t <= lim.max_rpm):
            raise WorkbenchError(f"target {t} rpm is outside (0, {lim.max_rpm:.0f}] rpm", 422)
        if t not in ts:
            ts.append(t)
    if not ts:
        raise WorkbenchError("give at least one target rpm", 422)
    if len(ts) > MAX_TARGETS:
        raise WorkbenchError(f"at most {MAX_TARGETS} targets", 422)
    st = orch._state_summary()
    basis = basis_of(orch)
    env_lo = sp * lim.min_speed_fraction
    seq = next(_ids)
    cands = [_pred_view(orch.pred.predict(orch.post, st, "REDUCE_SPEED", t), f"P{seq}-{chr(65 + i)}", basis, sp, env_lo) for i, t in enumerate(ts)]
    refs = [_pred_view(orch.pred.predict(orch.post, st, a, 0.0), f"P{seq}-{a}", basis, sp, env_lo) for a in ("CONTINUE_MONITORING", "STOP")]
    trust = orch.pred.trust(orch.post, op_familiar=orch.last_status in ("OK", "INTERPOLATED", "FROZEN"), st=st)
    out = {"request_id": f"P{seq}", "provenance": "PREDICTED", "basis": basis,
           "current": {"rpm": _r(st.rpm, 1), "setpoint_rpm": sp, "housing": _r(st.housing, 2), "current": _r(st.current, 3), "vib_rms": _r(st.vib_rms, 4),
                       "averaged_windows": st.n_state},
           "candidates": cands, "references": refs, "trust": {"trusted": trust.trusted, "reasons": trust.reasons},
           "risk_limits": orch.pred.risk_limits, "validated_by_experiments": bool(orch.pred.validated_by_experiments),
           "limits": limits_view(orch), "suggested_targets": suggested_targets(orch), "max_age_s": MAX_PREDICTION_AGE_S}
    return out                                            # a pure read: nothing is stored or logged; the prediction acted on is logged at request time


# ------------------------------------------------------------------------------------------------ analyst action (C3)
def _proposal(orch, action: str, target: Optional[float], role: Role, user: str, why: str) -> ProposedAction:
    if action == "REDUCE_SPEED":
        if target is None or not np.isfinite(float(target)):
            raise WorkbenchError("REDUCE_SPEED needs a target rpm", 422)
        return ProposedAction(action=ActionType.REDUCE_SPEED, params={"rpm": float(target)}, source=ProposalSource.HUMAN, role=role,
                              requested_by=user, human_approved=True, incident_id=orch.inc.id if orch.inc else None, rationale=why)
    if action == "STOP":
        return ProposedAction(action=ActionType.STOP, source=ProposalSource.HUMAN, role=role, requested_by=user, human_approved=True,
                              incident_id=orch.inc.id if orch.inc else None, rationale=why)
    raise WorkbenchError(f"action '{action}' cannot be selected here (REDUCE_SPEED or STOP)", 422)


def check_action(orch, action: str, target: Optional[float], basis: Optional[Dict[str, Any]], role: Role, user: str = "") -> Dict[str, Any]:
    """Dry run: gate + Safety Supervisor + freshness for the selected action. Changes nothing."""
    p = _proposal(orch, action, target, role, user, "analyst check")
    stale = stale_reasons(orch, basis)
    gate = None
    if orch.inc is not None and orch.post is not None:
        gi, trust = orch.gate_inputs()
        d = decide(gi, orch.gate_cfg)
        gate = {"verdict": d.verdict.value, "reason": d.reason, "test": d.test, "c2_trust_reasons": trust.reasons}
    sup = orch.sup.check(p, orch._ctx())
    pend = orch.pending
    waiting = orch.inc is not None and orch.inc.state == S.AWAITING_APPROVAL and pend is not None and pend.action in (ActionType.REDUCE_SPEED, ActionType.STOP)
    blockers = []
    if not waiting:
        blockers.append("no action is waiting for a human decision: the pipeline only holds an action for approval when the scenario requires "
                        "human approval and the gate has reached ACT" if orch.inc else "there is no open incident")
    if stale:
        blockers.append("the prediction is stale: " + "; ".join(stale))
    if action == "REDUCE_SPEED" and (gate is None or gate["verdict"] != GateVerdict.ACT.value):
        blockers.append(f"the decision gate does not allow acting now ({gate['verdict']}: {gate['reason']})" if gate else "the decision gate cannot evaluate without an incident and a ranking")
    if sup.verdict == DecisionVerdict.REJECT:
        blockers.append("the Safety Supervisor refuses it: " + ", ".join(sup.reasons))
    st = orch._state_summary() if orch.buf else None
    fresh = None
    if st is not None and orch.post is not None:
        pr = orch.pred.predict(orch.post, st, action, float(target or 0.0))
        lim = orch.sup.limits; sp = float(orch.dev.sim.setpoint)
        fresh = _pred_view(pr, f"X-{next(_ids)}", basis_of(orch), sp, sp * lim.min_speed_fraction)
        # The pipeline never acts on a prediction that declares itself unsupported (pipeline._on_action_evaluation), and the gate treats a
        # predicted risk at or above risk_high as a stop condition. The analyst's target is held to the same two rules. STOP is exempt:
        # it can only make the system safer and the Safety Supervisor always allows it.
        if action == "REDUCE_SPEED":
            if pr.status != "supported":
                blockers.append(f"C2 marks the prediction for this target {pr.status.replace('_', ' ')}" + (f" ({', '.join(pr.status_reasons)})" if pr.status_reasons else "")
                                + "; the pipeline never acts on such a prediction")
            if pr.risk >= orch.gate_cfg.risk_high:
                blockers.append(f"the predicted risk for this target ({pr.risk:.2f}) is at or above the gate's stop threshold ({orch.gate_cfg.risk_high:.2f})")
    elif action == "REDUCE_SPEED":
        blockers.append("no prediction can be computed for this target (no hypothesis ranking or telemetry yet)")
    return {"action": action, "target_rpm": target, "gate": gate, "supervisor": {"verdict": sup.verdict.value, "reasons": sup.reasons},
            "pending": None if pend is None else {"action": pend.action.value, "params": pend.params, "rationale": pend.rationale},
            "awaiting_decision": bool(waiting), "stale": stale, "blockers": blockers, "executable": not blockers,
            "prediction_now": fresh, "basis_now": basis_of(orch), "provenance": "SIMULATED"}


def _features(orch) -> List[Dict[str, Any]]:
    Z = _evidence_matrix(orch)
    if Z is None:
        return []
    zbar = Z.mean(axis=0)
    return [{"feature": FEATURES[i], "mean_z": _r(zbar[i], 2)} for i in np.argsort(-np.abs(zbar))[:6]]


def request_action(orch, action: str, target: Optional[float], basis: Optional[Dict[str, Any]], candidate_id: Optional[str],
                   role: Role, user: str = "", scenario: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    from .investigation import write_receipt
    chk = check_action(orch, action, target, basis, role, user)
    chk["basis_supplied"] = basis
    rid = f"R-{next(_ids):04d}"
    req = {"action": action, "target_rpm": target, "candidate_id": candidate_id, "requested_by": user, "role": role.value}
    feats = _features(orch)
    if not chk["executable"]:                                       # a refusal leaves a receipt too, so it is as visible as an acceptance
        write_receipt(orch, rid, req, "REFUSED", chk, feats, scenario)
        orch._log("analyst_action", action=action, target_rpm=target, candidate=candidate_id, receipt=rid, decision="REFUSED", blockers=chk["blockers"])
        raise WorkbenchError("; ".join(chk["blockers"]) + f" (decision receipt {rid})")
    why = f"Analyst selected {action}" + (f" to {float(target):.0f} rpm" if action == "REDUCE_SPEED" else "") + f" (candidate {candidate_id or '—'})"
    p = _proposal(orch, action, target, role, user, why)
    pred = orch.pred.predict(orch.post, orch._state_summary(), action, float(target or 0.0))
    orch._pred_choice, orch._predicted_at = pred, orch.now          # the prediction_check record compares against THIS target
    import copy as _copy
    frozen = _copy.deepcopy(chk)                                    # the evidence as it stood before anything was dispatched
    orch._log("analyst_action", action=action, target_rpm=target, candidate=candidate_id, gate=(chk["gate"] or {}).get("verdict"),
              supervisor=chk["supervisor"]["verdict"], replaces=chk["pending"], receipt=rid)
    before = orch.cmd
    orch.pending = p
    orch.approve(role)                                              # -> Safety Supervisor -> dispatcher; nothing else can send
    rec = orch.cmd if orch.cmd is not before else None              # never report an earlier command as this request's
    write_receipt(orch, rid, req, "ACCEPTED" if rec is not None else "REFUSED", frozen, feats, scenario, command_id=rec.id if rec else None)
    return {"requested": {"action": action, "target_rpm": target, "candidate_id": candidate_id}, "receipt_id": rid, "gate": chk["gate"],
            "supervisor": chk["supervisor"], "prediction_at_request": chk["prediction_now"],
            "command": None if rec is None else {"id": rec.id, "action": rec.action.value, "params": rec.params, "status": rec.status.value},
            "incident_state": orch.inc.state.value if orch.inc else None,
            "note": "Dispatched to the simulated device; an acknowledgement is not recovery. C5 decides from fresh windows after the ack.",
            "provenance": "SIMULATED"}


# ================================================================================================ adaptive diagnostic testing (C4)
# Evidence-sufficiency statuses. Each is assigned by one rule below, nowhere else:
#   SUFFICIENT_EVIDENCE      the ranking meets the gate's own confidence rule (gate.decide: p >= p_confident, margin >= margin_confident,
#                            not unfamiliar / conflicted / uncorroborated, and a look-alike diagnosis has had a test)
#   MORE_EVIDENCE_REQUIRED   not yet sufficient, and either no ranking exists yet or an eligible test is expected to remove at least the
#                            gate's minimum information gain
#   INVALID_INPUT            the recent windows (or a test's windows) fail validity, or a stop limit was crossed during a test
#   TEST_NOT_SUPPORTED       no remaining test is runnable here (no learned signature, motor not driven, required signal missing)
#   INCONCLUSIVE             not sufficient, and no eligible test is worth running, the budget is exhausted, or a test outcome was
#                            unlike every learned signature
SUFFICIENCY = ("SUFFICIENT_EVIDENCE", "MORE_EVIDENCE_REQUIRED", "INVALID_INPUT", "TEST_NOT_SUPPORTED", "INCONCLUSIVE")
TEST_SIGNALS = {"T1": ("rpm", "current", "v1x", "v2x", "v3x"), "T3": ("housing", "current", "ambient"), "T4": ("rpm",)}
TEST_FOR = {"T1": "imbalance vs looseness vs a faulty vibration channel", "T3": "cooling failure vs overload",
            "T4": "friction / overload vs cooling or electrical faults"}
MAX_ADAPTIVE_BUDGET = len(TESTS)
OBS_MEANING = {"T1": ["1x vibration speed exponent", "2x+3x harmonics speed exponent", "log change of current per rpm"],
               "T3": ["housing thermal-residual slope, °C per 100 s"], "T4": ["ln tau of the coast-down (s)"]}


def _sufficient(post: Optional[Posterior], tests_run: int, gcfg) -> Tuple[bool, str]:
    if post is None:
        return False, "no hypothesis ranking exists yet"
    needs_test = post.top.value in gcfg.test_required_for and tests_run == 0
    why = []
    if post.top_p < gcfg.p_confident:
        why.append(f"top probability {post.top_p:.2f} < {gcfg.p_confident:.2f}")
    if post.margin < gcfg.margin_confident:
        why.append(f"margin {post.margin:.2f} < {gcfg.margin_confident:.2f}")
    flags = {"ood": "evidence unlike every learned signature", "conflict": "test evidence conflicts with the ranking",
             "uncorroborated": "the test's own likelihood does not support the top hypothesis"}
    why += [txt for flag, txt in flags.items() if getattr(post, flag, False)]
    if needs_test:
        why.append(f"'{post.top.value}' cannot be told from its look-alike without a speed-step test")
    if why:
        return False, "; ".join(why)
    return True, f"'{post.top.value}' at {post.top_p:.2f}, margin {post.margin:.2f}, meets the gate's confidence rule"


def _test_options(post: Optional[Posterior], ws: Sequence, driven: bool, tt, dm, done: Sequence[str]) -> List[Dict[str, Any]]:
    """Every C4 test with its prerequisites checked against the given windows. Gain is computed only for eligible tests."""
    out = []
    recent = list(ws)[-10:]
    valid = sum(w.valid for w in recent) / len(recent) if recent else 0.0
    for t in TESTS:
        pre = [("learned outcome signature", t in dm.models, "learned in simulation" if t in dm.models else "no signature learned"),
               ("not already run in this investigation", t not in done, "" if t not in done else "already run"),
               ("motor driven", bool(driven), "" if driven else "the simulated motor is not driven")]
        missing = [s for s in TEST_SIGNALS[t] if not recent or not all(np.isfinite(getattr(w, s, np.nan)) for w in recent)]
        pre.append(("required signals present: " + ", ".join(TEST_SIGNALS[t]), not missing, ("missing: " + ", ".join(missing)) if missing else ""))
        pre.append(("recent windows valid (>= 80 %)", valid >= 0.8, f"{valid:.0%} valid"))
        if t == "T3":
            pre.append(("thermal model fitted", bool(getattr(tt, "fitted", False)), ""))
        ok = all(p[1] for p in pre)
        gain = _r(max(0.0, dm.expected_info_gain(post, t)), 3) if (ok and post is not None) else None
        out.append({"test": t, "distinguishes": TEST_FOR[t], "eligible": ok, "expected_info_gain_nats": gain,
                    "prerequisites": [{"check": c, "ok": bool(v), "detail": d} for c, v, d in pre], "ends_with_motor_stopped": t == "T4"})
    return out


def sufficiency(orch, dm) -> Dict[str, Any]:
    """The evidence-sufficiency status of the live run, before anything is run."""
    post, gcfg = orch.post, orch.gate_cfg
    tests_run = orch.inc.tests_run if orch.inc else 0
    done = [l["test"] for l in orch.log if l.get("kind") == "test_result" and orch.inc and l.get("incident") == orch.inc.id]
    opts = _test_options(post, orch.buf, orch.dev.sim.setpoint > 0, orch.tt, dm, done)
    recent = orch.buf[-10:]
    valid = (sum(w.valid for w in recent) / len(recent)) if recent else 0.0
    ok, why = _sufficient(post, tests_run, gcfg)
    worth = sorted([o for o in opts if o["eligible"] and (o["expected_info_gain_nats"] or 0) >= gcfg.min_info_gain_nats],
                   key=lambda o: -o["expected_info_gain_nats"])
    if recent and valid < 0.8:
        st, why = "INVALID_INPUT", f"only {valid:.0%} of the last {len(recent)} windows are valid"
    elif ok:
        st = "SUFFICIENT_EVIDENCE"
    elif post is None or worth:
        st = "MORE_EVIDENCE_REQUIRED"
        if worth:
            why += f"; {worth[0]['test']} is expected to remove {worth[0]['expected_info_gain_nats']:.2f} nats"
    elif not any(o["eligible"] for o in opts):
        st, why = "TEST_NOT_SUPPORTED", why + "; no remaining test is runnable"
    else:
        st, why = "INCONCLUSIVE", why + f"; no eligible test is expected to remove {gcfg.min_info_gain_nats:.2f} nats or more"
    baseline = orch.scores[-1].status if orch.scores else None
    return {"status": st, "reason": why, "tests": opts, "tests_run_in_incident": tests_run,
            "c1_baseline_for_current_speed": baseline not in (None, "UNLEARNED_BIN"), "c1_window_status": baseline,
            "rule": "SUFFICIENT_EVIDENCE uses the decision gate's own confidence rule (GateConfig)",
            "min_info_gain_nats": gcfg.min_info_gain_nats}


def run_adaptive(orch, dm, hm, budget: int = 3, user: str = "", scenario: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Choose, run and re-assess C4 tests one at a time on a copy of the live simulated motor, by expected information gain among the
    tests whose prerequisites hold, until the evidence is sufficient, nothing worth running remains, an input fails, or the budget ends."""
    if not (1 <= int(budget) <= MAX_ADAPTIVE_BUDGET):
        raise WorkbenchError(f"budget must be 1–{MAX_ADAPTIVE_BUDGET} tests", 422)
    if orch.dev.estop:
        raise WorkbenchError("the simulated device has latched an emergency stop; clear it before testing")
    if orch.test_running:
        raise WorkbenchError(f"the pipeline is running test {orch.test_running} on the live simulation; wait for it to finish")
    lim, gcfg = orch.sup.limits, orch.gate_cfg
    sim, det, tt = copy.deepcopy(orch.dev.sim), copy.deepcopy(orch.det), copy.deepcopy(orch.tt)
    post = orch.post
    tests_run = orch.inc.tests_run if orch.inc else 0
    ws_hist = list(orch.buf[-30:])
    rows: List[Dict[str, Any]] = []
    stages: List[Dict[str, Any]] = []
    done: List[str] = []
    final_status, final_reason = None, None
    while True:
        ok, why = _sufficient(post, tests_run, gcfg)
        if ok:
            final_status, final_reason = "SUFFICIENT_EVIDENCE", why
            break
        if post is None:
            final_status, final_reason = "MORE_EVIDENCE_REQUIRED", "no hypothesis ranking exists yet: C1 must flag a persistent anomaly first, so no test can be chosen"
            break
        if len(stages) >= budget:
            final_status, final_reason = "INCONCLUSIVE", f"the test budget ({budget}) is used up and {why}"
            break
        recent = ws_hist[-10:]
        if recent and sum(w.valid for w in recent) / len(recent) < 0.8:
            final_status, final_reason = "INVALID_INPUT", "the recent windows are not valid enough to plan a test"
            break
        opts = _test_options(post, ws_hist, sim.setpoint > 0, tt, dm, done)
        eligible = [o for o in opts if o["eligible"]]
        if not eligible:
            final_status = "TEST_NOT_SUPPORTED"
            final_reason = "no remaining test is runnable: " + "; ".join(
                f"{o['test']}: {next((p['detail'] or p['check']) for p in o['prerequisites'] if not p['ok'])}" for o in opts)
            break
        best = max(eligible, key=lambda o: o["expected_info_gain_nats"])
        if best["expected_info_gain_nats"] < gcfg.min_info_gain_nats:
            final_status = "INCONCLUSIVE"
            final_reason = (f"{why}; the most informative eligible test ({best['test']}) would remove only {best['expected_info_gain_nats']:.2f} nats "
                            f"(the gate requires {gcfg.min_info_gain_nats:.2f})")
            break
        alts = []
        for o in opts:
            if o["test"] == best["test"]:
                continue
            if not o["eligible"]:
                failed = [p["check"] + (f" ({p['detail']})" if p["detail"] else "") for p in o["prerequisites"] if not p["ok"]]
                because = "prerequisite failed: " + "; ".join(failed)
            else:
                because = f"lower expected gain ({o['expected_info_gain_nats']:.2f} nats)"
            alts.append({"test": o["test"], "eligible": o["eligible"], "expected_info_gain_nats": o["expected_info_gain_nats"], "not_selected_because": because})
        stage = {"index": len(stages), "selected": best["test"], "distinguishes": best["distinguishes"],
                 "leading_hypotheses": [(h.value, _r(p)) for h, p in post.ranked()[:2]], "why_more_evidence": why,
                 "expected_info_gain_nats": best["expected_info_gain_nats"],
                 "selection_reason": f"largest expected information gain among the eligible tests ({best['expected_info_gain_nats']:.2f} nats)",
                 "alternatives": alts, "required_signals": list(TEST_SIGNALS[best["test"]]), "posterior_before": _post_view(post)}
        obs, ws = _run_fixed(sim, best["test"], tt)
        s0, crossed = len(rows), None
        for w in ws:
            tt.update(w)
            sc = det.score(w)
            rows.append(_row(w, sc, len(stages), best["test"]))
            crossed = crossed or _limit_crossed(w, lim)
        ws_hist += ws
        stage.update(observation=[_r(x, 4) for x in obs], observation_meaning=OBS_MEANING[best["test"]], summary=_summary(rows[s0:], None))
        valid = sum(w.valid for w in ws) / max(1, len(ws))
        done.append(best["test"])
        if crossed or valid < 0.8:
            stage.update(status="aborted" if crossed else "invalid", reason=crossed or f"only {valid:.0%} of the test's windows were valid",
                         posterior_after=_post_view(post), ranking_changed=False)
            stages.append(stage)
            final_status, final_reason = "INVALID_INPUT", f"{best['test']} {stage['status']}: {stage['reason']}"
            break
        new = dm.update(post, best["test"], obs)
        tests_run += 1
        stage.update(status="completed", posterior_after=_post_view(new), ranking_changed=new.top != post.top,
                     top_probability_change=_r(new.top_p - post.top_p, 3))
        stages.append(stage)
        post = new
        if new.ood:
            final_status, final_reason = "INCONCLUSIVE", f"the {best['test']} outcome was unlike every learned signature; no diagnosis is forced"
            break
    rid = f"A-{next(_ids):04d}"
    record = {"id": rid, "mode": "adaptive", "provenance": "SIMULATED", "executed_on": "a copy of the live simulated motor (the live run was not changed)",
              "started_at_sim_t": orch.now, "requested_by": user, "budget": budget, "stages": stages, "status": final_status, "reason": final_reason,
              "posterior_start": _post_view(orch.post), "posterior_final": _post_view(post),
              "stopping_rule": ("stop at SUFFICIENT_EVIDENCE (the gate's confidence rule), when no eligible test reaches the gate's minimum "
                                "information gain, on invalid input or an unfamiliar outcome, or when the budget is used"),
              "scenario_truth": (orch.dev.sim.truth.fault.value if orch.dev.sim.truth.fault else None), "scenario_note": _scenario_note(orch, scenario)}
    orch._put("diagnostic_run", rid, record, "SIMULATED", orch.now)
    orch._log("diagnostic_run", id=rid, mode="adaptive", tests=[s["selected"] for s in stages], status=final_status)
    return {**record, "series": rows}


# ================================================================================================ counterfactual experiment lab (C2)
# Every branch starts from ONE deep copy of the live simulated motor (state, injected fault and random stream) taken under the service
# lock, so all candidates see identical starting conditions; each branch gets its own copy of that snapshot. Snapshots are kept in memory
# (the last MAX_SNAPSHOTS) so an experiment can be re-run exactly; the recorded inputs are stored with the result.
_SNAPSHOTS: Dict[str, Dict[str, Any]] = {}
MAX_SNAPSHOTS = 20
CF_HORIZONS = (30, 60, 120, 180, 300)
CF_SIGNALS = ("rpm", "current", "voltage", "power", "housing", "vib_rms")


def _digest(obj) -> str:
    import hashlib
    import pickle
    return hashlib.sha256(pickle.dumps(obj, protocol=4)).hexdigest()[:16]


def _branch(snap: Dict[str, Any], action: str, target: Optional[float], horizon: int, risk_limits: Dict[str, float]) -> Dict[str, Any]:
    from .lab import window_hash
    from .schemas import Hypothesis
    sim, det, tt = copy.deepcopy(snap["sim"]), copy.deepcopy(snap["det"]), copy.deepcopy(snap["tt"])
    inj = dict(snap["inject"]) if snap.get("inject") else None      # the scenario's scheduled injection, applied as the service applies it
    t0 = sim.t
    if action == "REDUCE_SPEED":
        sim.set_setpoint(float(target))
    elif action == "STOP":
        sim.stop()
    rows, wins = [], []
    for _ in range(horizon):
        if inj and not inj["done"] and sim.t >= inj["at"]:
            sim.inject(Hypothesis(inj["fault"]), inj["severity"], inj["clears_below_rpm"])
            inj["done"] = True
        w = sim.step(1.0)
        tt.update(w)
        sc = det.score(w)
        r = _row(w, sc, 0, action)
        r["dt"] = round(w.t - t0, 1)
        rows.append(r)
        wins.append(w)
    last = rows[-10:]

    def mean(k):
        v = [x[k] for x in last if x[k] is not None]
        return _r(float(np.mean(v)), 4) if v else None

    scored = [x for x in rows if x["score"] is not None]
    over = {s: sum(1 for x in rows if x[s] is not None and x[s] > lv) for s, lv in risk_limits.items() if s in CF_SIGNALS}
    metrics = {"final_mean_last_10s": {s: mean(s) for s in CF_SIGNALS},
               "max": {s: _r(max((x[s] for x in rows if x[s] is not None), default=float("nan")), 4) for s in ("housing", "current", "vib_rms")},
               "seconds_above_warn_limit": over, "exceeded_a_warn_limit": any(v > 0 for v in over.values()),
               "c1_flagged_fraction": _r(sum(x["anomalous"] for x in scored) / len(scored), 3) if scored else None,
               "c1_scored_windows": len(scored), "valid_windows": sum(x["valid"] for x in rows)}
    return {"rows": rows, "metrics": metrics, "window_hash": window_hash(wins)}


def counterfactual(orch, targets: Sequence[float], include_continue: bool, include_stop: bool, horizon: int,
                   scenario: Optional[Dict[str, Any]] = None, injected: bool = True, user: str = "") -> Dict[str, Any]:
    lim = orch.sup.limits
    if horizon not in CF_HORIZONS:
        raise WorkbenchError(f"horizon must be one of {CF_HORIZONS} s", 422)
    ts = []
    for t in targets:
        t = float(t)
        if not np.isfinite(t) or not (0 < t <= lim.max_rpm):
            raise WorkbenchError(f"target {t} rpm is outside (0, {lim.max_rpm:.0f}] rpm", 422)
        if t not in ts:
            ts.append(t)
    if len(ts) > MAX_TARGETS:
        raise WorkbenchError(f"at most {MAX_TARGETS} targets", 422)
    cands = ([("CONTINUE_MONITORING", None)] if include_continue else []) + [("REDUCE_SPEED", t) for t in ts] + ([("STOP", 0.0)] if include_stop else [])
    if len(cands) < 2:
        raise WorkbenchError("choose at least two candidates to compare", 422)
    if len(orch.buf) < 10:
        raise WorkbenchError("at least 10 simulated windows are needed before branching")
    if orch.dev.estop:
        raise WorkbenchError("the simulated device has latched an emergency stop; there is nothing to branch from")
    sc = dict(scenario or {})
    inject = ({"fault": sc["fault"], "severity": sc["severity"], "clears_below_rpm": sc.get("clears_below_rpm"),
               "at": float(sc["inject_after_s"]), "done": False} if sc.get("fault") and not injected else None)
    snap = {"sim": copy.deepcopy(orch.dev.sim), "det": copy.deepcopy(orch.det), "tt": copy.deepcopy(orch.tt), "inject": inject}
    sp = float(orch.dev.sim.setpoint)
    post, st = orch.post, orch._state_summary()
    rid = f"CF-{next(_ids):04d}"
    w0 = orch.buf[-1]
    inputs = {"start_sim_t": orch.now, "session": orch.session, "scenario": sc, "seed": sc.get("seed"), "setpoint_rpm": sp,
              "candidates": [{"action": a, "target_rpm": t} for a, t in cands], "horizon_s": horizon,
              "scheduled_injection_in_branches": inject, "state_digest": _digest(snap["sim"]),
              "model_versions": {"hypothesis_model": orch.hm.version, "c4_signatures": orch.dm.version, "c2_predictor": orch.pred.version,
                                 "c1_detector": getattr(orch.det, "version", None)}}
    branches = []
    for a, t in cands:
        label = {"CONTINUE_MONITORING": "Continue", "STOP": "STOP (coast)"}.get(a) or f"Reduce to {t:.0f} rpm"
        b = {"action": a, "target_rpm": t, "label": label, "within_supervisor_envelope": a != "REDUCE_SPEED" or (sp * lim.min_speed_fraction <= t < sp)}
        try:
            run = _branch(snap, a, t, horizon, orch.pred.risk_limits)
            b.update(status="completed", observed=run["rows"], metrics=run["metrics"], window_hash=run["window_hash"])
        except Exception as e:                              # a failed branch is reported as failed, never as a result
            b.update(status="failed", error=f"{type(e).__name__}: {e}")
        if post is None:
            b["prediction"] = {"unavailable": "C2 is conditional on a hypothesis ranking and none exists yet"}
        elif b["status"] == "completed":
            p = orch.pred.predict(post, st, a, float(t or 0.0))
            hs = [h for h in CHECK_HORIZONS if h <= horizon]
            obs_at = {h: next((r for r in b["observed"] if abs(r["dt"] - h) < 0.51), None) for h in hs}
            prow = []
            for h in hs:
                for s in p.mean:
                    o = obs_at[h][s] if obs_at[h] else None
                    lo, hi = float(p.lo[s][h - 1]), float(p.hi[s][h - 1])
                    prow.append({"horizon_s": h, "signal": s, "predicted_mean": _r(p.mean[s][h - 1], 4), "lo": _r(lo, 4), "hi": _r(hi, 4),
                                 "observed": o, "inside_interval": (o is not None and lo - 1e-9 <= o <= hi + 1e-9)})
            b["prediction"] = {"status": p.status, "status_reasons": p.status_reasons, "interval_method": p.interval_method, "rows": prow}
        branches.append(b)
    record = {"id": rid, "provenance": "SIMULATED", "requested_by": user, "inputs": inputs,
              "start": {"t": w0.t, "rpm": w0.rpm, "setpoint": w0.setpoint, "current": w0.current, "voltage": w0.voltage, "housing": w0.housing,
                        "vib_rms": w0.vib_rms, "valid": w0.valid, "injected_fault": orch.dev.sim.truth.fault.value if orch.dev.sim.truth.fault else None},
              "branches": branches, "risk_limits": orch.pred.risk_limits,
              "metric_definitions": {
                  "final_mean_last_10s": "mean of the last 10 simulated 1 s windows of the branch",
                  "max": "largest value over the horizon",
                  "seconds_above_warn_limit": "number of 1 s windows above the C2 predictor's warning limit for that signal",
                  "c1_flagged_fraction": "windows above the C1 threshold / windows C1 could score",
                  "inside_interval": "the observed simulated value at that horizon lies inside C2's 90 % interval (one sample, not a coverage estimate)"},
              "note": ("Observed values are simulated branch trajectories from identical starting conditions; predictions are C2 outputs made at the "
                       "start. Branches act on simulator copies, not on the device, and do not change the live run.")}
    _SNAPSHOTS[rid] = snap
    while len(_SNAPSHOTS) > MAX_SNAPSHOTS:
        _SNAPSHOTS.pop(next(iter(_SNAPSHOTS)))
    orch._put("counterfactual", rid, record, "SIMULATED", orch.now)
    orch._log("counterfactual", id=rid, candidates=[b["label"] for b in branches], horizon_s=horizon)
    return record


def counterfactual_get(orch, rid: str) -> Dict[str, Any]:
    rec = orch.get("counterfactual", rid)
    if rec is None:
        raise WorkbenchError(f"experiment {rid} was not found in this run", 404)
    rec.pop("_provenance", None)
    rec["rerunnable"] = rid in _SNAPSHOTS
    return rec


def counterfactual_rerun(orch, rid: str) -> Dict[str, Any]:
    rec = counterfactual_get(orch, rid)
    snap = _SNAPSHOTS.get(rid)
    if snap is None:
        raise WorkbenchError(f"the starting state of {rid} is no longer held in memory (only the last {MAX_SNAPSHOTS} are kept and none survive a "
                             "backend restart); its recorded inputs remain available")
    out = []
    for b in rec["branches"]:
        if b["status"] != "completed":
            out.append({"label": b["label"], "identical": None, "note": "the original branch failed"})
            continue
        run = _branch(snap, b["action"], b["target_rpm"], rec["inputs"]["horizon_s"], rec["risk_limits"])
        out.append({"label": b["label"], "original_hash": b["window_hash"], "rerun_hash": run["window_hash"], "identical": run["window_hash"] == b["window_hash"]})
    return {"id": rid, "state_digest": rec["inputs"]["state_digest"], "state_digest_now": _digest(snap["sim"]), "branches": out,
            "identical": all(x["identical"] for x in out if x["identical"] is not None)}
