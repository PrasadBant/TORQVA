"""Hypothesis ranking, C3 gate (all verdicts reachable) and C4 diagnostics on simulated data."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.detection import BaselineDetector, ThermalTracker
from torqva.diagnostics import DiagnosticsModel, run_test_on_sim
from torqva.gate import GateConfig, GateInputs, TestOption, decide
from torqva.hypotheses import HYPS, HypothesisModel, Posterior
from torqva.schemas import GateVerdict, Hypothesis
from torqva.sim import MotorSim

def test_posterior_identifies_true_fault_on_held_out_sessions(stack):
    det, tt, hm, dm, zs_for = stack
    correct = total = 0
    for h in HYPS:
        for seed in (201, 202, 203):
            post = hm.posterior(zs_for(h, 0.6, seed, 1500)[-15:])
            correct += int(post.top == h)
            total += 1
    assert correct / total >= 0.6, (correct, total)      # honest floor; see eval suite for the full table


def test_posterior_is_a_distribution_and_label_is_honest(stack):
    det, tt, hm, dm, zs_for = stack
    post = hm.posterior(zs_for(Hypothesis.IMBALANCE, 0.8, 301)[-15:])
    assert abs(sum(post.probs.values()) - 1.0) < 1e-9
    empty = hm.posterior([])
    assert empty.label() == "insufficient" and abs(empty.top_p - 1 / len(HYPS)) < 1e-9


def test_evidence_cap_prevents_overconfidence_from_many_correlated_windows(stack):
    det, tt, hm, dm, zs_for = stack
    z = zs_for(Hypothesis.IMBALANCE, 0.3, 302)
    p20 = hm.posterior(z[-20:])
    p_many = hm.posterior(z[-20:] * 50)           # same evidence repeated
    assert abs(p20.top_p - p_many.top_p) < 1e-6


def test_hypothesis_rollback(stack):
    det, tt, hm, dm, zs_for = stack
    import copy
    m = copy.deepcopy(hm)
    v = m.version
    m.fit({Hypothesis.IMBALANCE: [np.zeros(10)] * 6})
    m.rollback()
    assert np.allclose(m.mu[Hypothesis.IMBALANCE], hm.mu[Hypothesis.IMBALANCE]) and m.version == v + 2


# ---------------- C3 gate: every verdict ----------------
def post(top_p, margin=None):
    rest = (1 - top_p) / (len(HYPS) - 1)
    probs = {h: rest for h in HYPS}
    probs[HYPS[0]] = top_p
    if margin is not None:    # build a two-way tie-ish distribution
        probs = {h: 0.0 for h in HYPS}
        probs[HYPS[0]], probs[HYPS[1]] = top_p, top_p - margin
        left = 1 - top_p - (top_p - margin)
        for h in HYPS[2:]:
            probs[h] = left / (len(HYPS) - 2)
    return Posterior(probs, 10)


def gi(**kw):
    base = dict(mandatory_stop=False, risk=0.05, data_ok=True, sensor_unreliable=False, posterior=post(0.9),
                c2_trusted=True, best_test=TestOption("T1", 0.5, True), data_requests=0, max_data_requests=3,
                tests_run=0, max_tests=2)
    base.update(kw)
    return GateInputs(**base)


def test_gate_act_when_confident_and_trusted():
    d = decide(gi())
    assert d.verdict == GateVerdict.ACT and d.inputs["top_p"] == 0.9


def test_gate_mandatory_stop_ignores_confidence_and_everything_else():
    for p in (post(0.99), post(0.2)):
        d = decide(gi(mandatory_stop=True, posterior=p, data_ok=False))
        assert d.verdict == GateVerdict.SAFE_STOP


def test_gate_high_risk_stops():
    assert decide(gi(risk=0.7)).verdict == GateVerdict.SAFE_STOP


def test_gate_bad_data_requests_more_then_escalates():
    assert decide(gi(data_ok=False)).verdict == GateVerdict.REQUEST_MORE_DATA
    assert decide(gi(data_ok=False, sensor_unreliable=True)).verdict == GateVerdict.SENSOR_UNRELIABLE
    assert decide(gi(data_ok=False, data_requests=3)).verdict == GateVerdict.ESCALATE_HUMAN


def test_gate_ambiguous_runs_test_when_informative_and_safe():
    d = decide(gi(posterior=post(0.45, margin=0.05)))
    assert d.verdict == GateVerdict.RUN_DIAGNOSTIC_TEST and d.test == "T1"


def test_gate_untrusted_c2_blocks_act_even_if_confident():
    d = decide(gi(c2_trusted=False))
    assert d.verdict != GateVerdict.ACT


def test_gate_unsafe_or_uninformative_test_falls_back_to_more_data():
    amb = post(0.45, margin=0.05)
    assert decide(gi(posterior=amb, best_test=TestOption("T1", 0.5, False))).verdict == GateVerdict.REQUEST_MORE_DATA
    assert decide(gi(posterior=amb, best_test=TestOption("T1", 0.01, True))).verdict == GateVerdict.REQUEST_MORE_DATA
    assert decide(gi(posterior=amb, best_test=None)).verdict == GateVerdict.REQUEST_MORE_DATA


def test_gate_moderate_risk_and_uncertain_stops():
    assert decide(gi(posterior=post(0.45, margin=0.05), risk=0.4)).verdict == GateVerdict.SAFE_STOP


def test_gate_budgets_exhausted_escalates():
    d = decide(gi(posterior=post(0.45, margin=0.05), tests_run=2, data_requests=3))
    assert d.verdict == GateVerdict.ESCALATE_HUMAN


def test_gate_decision_always_logs_inputs_and_reason():
    d = decide(gi(posterior=post(0.45, margin=0.05)))
    assert d.reason and {"top", "top_p", "margin", "risk", "c2_trusted"} <= set(d.inputs)


# ---------------- C4 ----------------
def test_t1_distinguishes_imbalance_from_looseness_better_than_prior(stack):
    det, tt, hm, dm, zs_for = stack
    # ambiguous prior between the two
    prior = {h: 0.0 for h in HYPS}
    prior[Hypothesis.IMBALANCE] = prior[Hypothesis.LOOSENESS] = 0.5
    wins = n = 0
    for truth in (Hypothesis.IMBALANCE, Hypothesis.LOOSENESS):
        for seed in (401, 402, 403, 404):
            s = MotorSim(seed); s.set_setpoint(1800); s.run(60); s.inject(truth, 0.6)
            obs, _ = run_test_on_sim(s, "T1", tt)
            p = dm.update(Posterior(prior, 10), "T1", obs)
            wins += int(p.top == truth)
            n += 1
    assert wins / n >= 0.75, (wins, n)


def test_t4_coast_down_separates_overload_from_cooling_failure(stack):
    det, tt, hm, dm, zs_for = stack
    prior = {h: 0.0 for h in HYPS}
    prior[Hypothesis.OVERLOAD] = prior[Hypothesis.COOLING_FAILURE] = 0.5
    wins = n = 0
    for truth in (Hypothesis.OVERLOAD, Hypothesis.COOLING_FAILURE):
        for seed in (501, 502, 503, 504):
            s = MotorSim(seed); s.set_setpoint(1800); s.run(60); s.inject(truth, 0.7)
            obs, _ = run_test_on_sim(s, "T4", tt)
            p = dm.update(Posterior(prior, 10), "T4", obs)
            wins += int(p.top == truth)
            n += 1
    assert wins / n >= 0.75, (wins, n)


def test_information_gain_is_zero_when_already_certain_and_positive_when_ambiguous(stack):
    det, tt, hm, dm, zs_for = stack
    certain = Posterior({h: (1.0 if h == Hypothesis.IMBALANCE else 0.0) for h in HYPS}, 10)
    assert dm.expected_info_gain(certain, "T1") < 1e-6
    amb = {h: 0.0 for h in HYPS}
    amb[Hypothesis.OVERLOAD] = amb[Hypothesis.COOLING_FAILURE] = 0.5
    assert dm.expected_info_gain(Posterior(amb, 10), "T4") > 0.2


def test_best_test_respects_allowed_set(stack):
    det, tt, hm, dm, zs_for = stack
    amb = {h: 0.0 for h in HYPS}
    amb[Hypothesis.OVERLOAD] = amb[Hypothesis.COOLING_FAILURE] = 0.5
    t, g = dm.best_test(Posterior(amb, 10), ["T1"])
    assert t == "T1"
    assert dm.best_test(Posterior(amb, 10), []) is None


def test_t1_never_commands_a_higher_speed():
    s = MotorSim(1); s.set_setpoint(1500); s.run(30)
    _, ws = run_test_on_sim(s, "T1", fraction=0.7)
    assert max(w.setpoint for w in ws) <= 1500.0 + 1e-9
