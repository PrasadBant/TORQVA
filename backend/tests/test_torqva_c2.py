"""C2 intervention outcome prediction (simulation). Self-consistent sim => optimistic; see docs for the caveat."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.hypotheses import HYPS, Posterior
from torqva.prediction import (ACTIONS, SIGNALS, InterventionPredictor, StateSummary, persistence_prediction)
from torqva.scenarios import action_cases
from torqva.schemas import Hypothesis

A = ("CONTINUE_MONITORING", "REDUCE_SPEED", "STOP")


@pytest.fixture(scope="module")
def c2(stack):
    det, tt, hm, dm, zs_for = stack
    pred = InterventionPredictor()
    pred.fit(tt)
    cal = [c for h in HYPS for sev in (0.3, 0.6, 0.9) for seed in (11, 12) for sp in (1200, 1800)
           for c in action_cases(h, sev, seed, sp, det, tt, hm)]
    pred.calibrate(cal)
    test = [c for h in HYPS for sev in (0.4, 0.8) for seed in (21, 22) for sp in (1500, 2000)
            for c in action_cases(h, sev, seed, sp, det, tt, hm)]
    pred.evaluate_coverage(test)
    return pred, test, (det, tt, hm)


def mae(pred, test, action, signal, use_persistence):
    errs = []
    for st, post, act, tgt, truth in test:
        if act != action:
            continue
        y = np.array([getattr(w, signal) for w in truth[:120]])
        yhat = persistence_prediction(st, 120)[signal] if use_persistence else pred._mixture(post, st, act, tgt, 120)[0][signal]
        errs.append(np.mean(np.abs(yhat - y)))
    return float(np.mean(errs))


@pytest.mark.parametrize("action", ["REDUCE_SPEED", "STOP"])
@pytest.mark.parametrize("signal", SIGNALS)
def test_beats_persistence_on_held_out_scenarios_for_speed_changing_actions(c2, action, signal):
    pred, test, _ = c2
    assert mae(pred, test, action, signal, False) < mae(pred, test, action, signal, True)


def test_beats_persistence_on_housing_temperature_even_when_continuing(c2):
    pred, test, _ = c2
    assert mae(pred, test, "CONTINUE_MONITORING", "housing", False) < mae(pred, test, "CONTINUE_MONITORING", "housing", True)


def test_interval_coverage_on_held_out_is_reasonable_but_reported_not_assumed(c2):
    pred, test, _ = c2
    assert pred.coverage
    assert np.mean(list(pred.coverage.values())) >= 0.75


def test_intervals_contain_the_mean_and_are_not_tighter_than_sensor_noise(c2):
    pred, test, _ = c2
    st, post, act, tgt, _ = test[1]
    p = pred.predict(post, st, act, tgt)
    for s in SIGNALS:
        assert np.all(p.lo[s] <= p.mean[s] + 1e-9) and np.all(p.hi[s] >= p.mean[s] - 1e-9)
    assert p.provenance == "PREDICTED"


def test_stop_predicts_zero_current_and_decaying_speed(c2):
    pred, test, _ = c2
    st, post, *_ = test[0]
    p = pred.predict(post, st, "STOP")
    assert p.mean["current"][-1] == 0.0 and p.mean["rpm"][-1] < 0.05 * st.rpm


def test_reduce_never_predicts_speed_above_start(c2):
    pred, test, _ = c2
    st, post, *_ = test[0]
    p = pred.predict(post, st, "REDUCE_SPEED", 0.7 * st.setpoint)
    assert p.mean["rpm"].max() <= st.rpm + 1e-6


def test_compare_ranks_by_risk_then_cost(c2):
    pred, test, _ = c2
    st, post, *_ = test[0]
    ranked = pred.compare(post, st, 0.7 * st.setpoint)
    assert {r.action for r in ranked} == set(A)
    keys = [(round(r.risk, 2), {"CONTINUE_MONITORING": 0, "REDUCE_SPEED": 0.3, "STOP": 1}[r.action]) for r in ranked]
    assert keys == sorted(keys)


def test_hot_motor_makes_continue_riskier_than_stop(c2):
    pred, test, _ = c2
    hot = StateSummary(rpm=2000, setpoint=2000, current=2.0, housing=49.0, ambient=22.0, vib_rms=0.1)
    post = Posterior({h: (1.0 if h == Hypothesis.COOLING_FAILURE else 0.0) for h in HYPS}, 10)
    r = {p.action: p.risk for p in pred.compare(post, hot, 1400)}
    assert r["CONTINUE_MONITORING"] > r["STOP"]


def test_uncalibrated_predictor_is_not_trusted(stack):
    det, tt, hm, dm, zs_for = stack
    p = InterventionPredictor()
    t = p.trust(Posterior({h: 1 / 6 for h in HYPS}, 10), True)
    assert not t.trusted and "not_calibrated" in t.reasons and "posterior_too_flat" in t.reasons


def test_unfamiliar_operating_point_reduces_trust(c2):
    pred, test, _ = c2
    flat = Posterior({h: (0.9 if h == HYPS[0] else 0.02) for h in HYPS}, 10)
    t = pred.trust(flat, op_familiar=False)
    assert not t.trusted and "operating_point_unfamiliar" in t.reasons


def test_unvalidated_until_experiments(c2):
    pred, *_ = c2
    assert pred.validated_by_experiments is False
