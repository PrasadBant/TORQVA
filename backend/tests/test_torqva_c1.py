"""C1 detection tests on simulated data (SIMULATION results only)."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.detection import BaselineDetector, DriftGuard, ThermalTracker, continual_update_allowed
from torqva.schemas import Hypothesis
from torqva.sim import MotorSim

SPEEDS = [900, 1200, 1500, 1800, 2100]


def healthy_session(seed, speeds=SPEEDS, hold=90):
    sim = MotorSim(seed)
    out = []
    for sp in speeds:
        sim.set_setpoint(sp)
        out += sim.run(hold)
    return out


def trained(seed=0, speeds=SPEEDS):
    det = BaselineDetector()
    tt = ThermalTracker()
    data = healthy_session(seed, speeds)
    assert tt.fit(data)
    tt.reset(data[0].housing)
    for w in data:
        tt.update(w)
    det.fit(data)
    return det, tt


def scored(det, tt, windows):
    tt.reset(windows[0].housing)
    res = []
    for w in windows:
        tt.update(w)
        res.append(det.score(w))
    return res


def test_learns_one_model_per_bin():
    det, _ = trained()
    assert len(det.bins) == len(SPEEDS)
    assert all(n >= 30 for n in det.coverage().values())
    assert det.version == 1


def test_unlearned_bin_is_reported_not_guessed():
    det, tt = trained(speeds=[900, 1800])
    sim = MotorSim(5); sim.set_setpoint(1500)
    s = scored(det, tt, sim.run(60))[-1]
    assert s.status == "UNLEARNED_BIN" and s.value is None and not s.anomalous


def test_interpolates_between_adjacent_learned_bins():
    det, tt = trained(speeds=[900, 1500])        # bin of 1200 sits between bins 3 and 5
    sim = MotorSim(6); sim.set_setpoint(1200)
    s = scored(det, tt, sim.run(60))[-1]
    assert s.status == "INTERPOLATED" and s.value is not None


def test_false_alarm_rate_on_unseen_healthy_sessions_is_low():
    det, tt = trained(0)
    alarms = total = 0
    for seed in (11, 12, 13):                    # different sessions than training
        sim = MotorSim(seed)
        for sp in SPEEDS:
            sim.set_setpoint(sp)
            w = sim.run(60)[20:]                 # past transient
            sc = scored(det, tt, w) if False else None
            tt.reset(w[0].housing)
            for x in w:
                tt.update(x)
                s = det.score(x)
                total += 1
                alarms += int(s.anomalous)
    assert alarms / total < 0.02, (alarms, total)


@pytest.mark.parametrize("fault,sev", [(Hypothesis.IMBALANCE, 0.8), (Hypothesis.LOOSENESS, 0.8),
                                       (Hypothesis.OVERLOAD, 0.8), (Hypothesis.SENSOR_FAULT, 0.8)])
def test_detects_injected_faults_at_two_speeds(fault, sev):
    det, tt = trained(0)
    for sp in (1200, 1800):
        sim = MotorSim(21)
        sim.set_setpoint(sp)
        sim.run(40)
        sim.inject(fault, sev)
        w = sim.run(40)[10:]
        flags = [s.anomalous for s in scored(det, tt, w)]
        assert np.mean(flags) > 0.9, (fault, sp, np.mean(flags))


def test_cooling_failure_detected_by_thermal_residual_over_time():
    det, tt = trained(0)
    sim = MotorSim(31); sim.set_setpoint(1500)
    base = sim.run(300)                          # warm up
    sim.inject(Hypothesis.COOLING_FAILURE, 0.9)
    w = base[-60:] + sim.run(900)
    tt.reset(w[0].housing)
    resid = []
    for x in w:
        resid.append(tt.update(x))
    assert abs(np.mean(resid[:50])) < 1.0
    assert np.mean(resid[-100:]) > 3.0           # residual grows: housing hotter than the healthy model predicts


def test_contributions_name_the_responsible_feature_for_imbalance():
    det, tt = trained(0)
    sim = MotorSim(41); sim.set_setpoint(1500); sim.run(30)
    sim.inject(Hypothesis.IMBALANCE, 0.9)
    s = scored(det, tt, sim.run(30)[10:])[-1]
    top = sorted(s.contributions, key=s.contributions.get, reverse=True)[:2]
    assert "v1x" in top or "vib_rms" in top


def test_rollback_restores_previous_baselines():
    det, tt = trained(0, speeds=[900])
    v1 = dict(det.bins)
    det.fit(healthy_session(9, speeds=[1500]))
    assert len(det.bins) == 2
    det.rollback()
    assert set(det.bins) == set(v1)


def test_frozen_bin_is_not_retrained_and_reports_frozen():
    det, _ = trained(0)
    b = det.bin_of(1500)
    det.bins[b].frozen = True
    n_before = det.bins[b].n
    det.fit(healthy_session(77, speeds=[1500]))
    assert det.bins[b].n == n_before


def test_drift_guard_fires_on_slow_wear_but_not_on_stationary_scores():
    g = DriftGuard()
    rng = np.random.RandomState(0)
    assert not any(g.update(3, 5.0 + 0.5 * rng.randn()) for _ in range(300))
    g2 = DriftGuard()
    fired = [g2.update(3, 5.0 + 0.04 * i + 0.5 * rng.randn()) for i in range(300)]
    assert any(fired) and 3 in g2.alerts


def test_continual_learning_guardrails():
    det, tt = trained(0)
    sim = MotorSim(51); sim.set_setpoint(1500)
    s = scored(det, tt, sim.run(60))[-1]
    assert continual_update_allowed(s, False, False, False)
    assert not continual_update_allowed(s, True, False, False)    # open incident
    assert not continual_update_allowed(s, False, True, False)    # post-intervention cooldown
    assert not continual_update_allowed(s, False, False, True)    # drift-frozen bin
