"""Phase 8: C1 robustness extensions (simulation only). Control behaviour must be unchanged; adaptation must be validated,
trusted-only, versioned, auditable and reversible; unfamiliar regimes must be explicit; the final test set must stay untouched."""
import copy
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva import c1_study
from torqva.c1_robust import (AdaptiveBaselineDetector, CoherenceConfig, ReferenceConfig, ReferenceRegistry,
                              RobustBaselineDetector, assess_session)
from torqva.detection import BaselineDetector, ThermalTracker
from torqva.hypotheses import HYPS
from torqva.pipeline import Orchestrator, PipelineConfig
from torqva.prediction import InterventionPredictor
from torqva.scenarios import action_cases
from torqva.schemas import Hypothesis, Mode
from torqva.sim import MotorSim
from torqva.simdevice import SimDevice
from torqva.store import Store
from torqva.supervisor import SafetySupervisor, SupervisorLimits
from torqva.c1_study import Condition, build_session, train_models


@pytest.fixture(scope="module")
def models():
    tt, c1, c4, ad4, pooled = train_models()
    return tt, c1, ad4


def session(models, cond, fault=None, sev=0.0, seed=9777, sp=1650):
    tt = models[0]
    return build_session(cond, seed, sp, fault, sev, tt)[:2]


BASE = Condition("t_base", "val")
GAIN = Condition("t_gain", "val", gain=1.25)
NOISE = Condition("t_noise", "val", noise_mult=2.0)


# ---------------- the control is unchanged ----------------
def test_adaptive_detector_without_reference_is_bit_identical_to_the_control(models):
    tt, c1, _ = models
    ad = AdaptiveBaselineDetector()
    sim = MotorSim(0); data = []
    for sp in c1_study.SPEEDS_LEARNED:
        sim.set_setpoint(sp); data += sim.run(90)
    tt.reset(data[0].housing)
    for w in data:
        tt.update(w)
    ad.fit(data)
    ctrl = BaselineDetector(); ctrl.fit(data)
    for cond, f in ((BASE, None), (NOISE, "looseness"), (GAIN, "imbalance")):
        warm, obs = session(models, cond, f, 0.3)
        for w in warm + obs:
            a, b = ctrl.score(w), ad.score(w)
            assert (a.value, a.threshold, a.anomalous, a.status) == (b.value, b.threshold, b.anomalous, b.status)


# ---------------- reference estimation, validation, trust ----------------
def test_reference_recovers_a_healthy_vibration_gain_and_noise(models):
    _, _, ad = models
    warm, _ = session(models, GAIN)
    p = ReferenceRegistry().propose(ad, warm, trusted=True)
    assert p.accepted and 1.18 < p.reference.gain < 1.32
    warm, _ = session(models, BASE)
    p = ReferenceRegistry().propose(ad, warm, trusted=True)
    assert p.accepted and 0.95 < p.reference.gain < 1.05 and max(p.reference.nu) == 1.0
    warm, _ = session(models, NOISE)
    p = ReferenceRegistry().propose(ad, warm, trusted=True)
    assert p.accepted and max(p.reference.nu) > 1.4


@pytest.mark.parametrize("kw", [dict(trusted=False), dict(trusted=True, incident_open=True), dict(trusted=True, in_cooldown=True)])
def test_untrusted_observations_never_update(models, kw):
    _, _, ad = models
    warm, _ = session(models, GAIN)
    reg = ReferenceRegistry()
    p = reg.propose(ad, warm, **kw)
    assert not p.accepted and p.reason == "untrusted_observations" and reg.active is None
    assert [e["event"] for e in reg.log] == ["proposed", "rejected"]


def test_invalid_or_short_warmup_is_rejected(models):
    _, _, ad = models
    warm, _ = session(models, BASE)
    bad = [copy.copy(w) for w in warm]; bad[20].valid = False
    assert ReferenceRegistry().propose(ad, bad, trusted=True).reason == "invalid_telemetry_in_warmup"
    assert ReferenceRegistry().propose(ad, warm[:15], trusted=True).reason == "insufficient_steady_warmup"


@pytest.mark.parametrize("fault", ["imbalance", "looseness", "sensor_fault"])
def test_a_fault_present_in_the_trusted_warmup_is_not_absorbed(models, fault):
    """Even if a human wrongly attests the warm-up, a channel-selective fault must not become the new normal."""
    tt, _, ad = models
    cond = Condition("hid", "test", fault_in_warmup=True)
    warm, obs, _ = build_session(cond, 9778, 1650, fault, 0.3, tt)
    reg = ReferenceRegistry()
    p = reg.propose(ad, warm, trusted=True)
    assert not p.accepted and p.reason in ("incoherent_vibration_channels", "self_check_failed", "sensitivity_lost")
    assert assess_session(ad, obs, ref=reg.active, regime_aware=True).verdict == "FAULT"


def test_candidate_must_not_be_blind_to_a_one_x_fault(models):
    """A very noisy warm-up inside the envelope would inflate scales; the sensitivity probe must refuse it (or the fault stays flagged)."""
    _, _, ad = models
    warm, obs = session(models, Condition("n3", "test", noise_mult=3.0), "imbalance", 0.3)
    reg = ReferenceRegistry()
    reg.propose(ad, warm, trusted=True)
    a = assess_session(ad, obs, ref=reg.active, regime_aware=False)
    assert a.verdict in ("FAULT",) or reg.active is None


def test_versioning_audit_and_rollback_leave_the_trained_baseline_untouched(models):
    _, _, ad = models
    before = copy.deepcopy({b: (m.mean.copy(), m.scale.copy(), m.prec.copy(), m.threshold) for b, m in ad.bins.items()})
    events = []
    reg = ReferenceRegistry(audit=events.append)
    w1, _ = session(models, GAIN, seed=9780); w2, _ = session(models, NOISE, seed=9781)
    p1 = reg.propose(ad, w1, trusted=True); p2 = reg.propose(ad, w2, trusted=True)
    assert p1.accepted and p2.accepted and reg.active.version == 2
    assert reg.rollback().version == 1                      # last known good
    assert reg.rollback() is None                           # unadapted trained baseline
    with pytest.raises(RuntimeError):
        reg.rollback()
    assert [e["event"] for e in reg.log].count("rolled_back") == 2 and events == reg.log
    for b, m in ad.bins.items():                            # the active model is immutable
        assert np.array_equal(before[b][0], m.mean) and np.array_equal(before[b][1], m.scale) \
            and np.array_equal(before[b][2], m.prec) and before[b][3] == m.threshold


# ---------------- session verdicts ----------------
def test_healthy_gain_and_noise_shift_is_flagged_by_control_but_unfamiliar_or_healthy_with_candidates(models):
    _, c1, ad = models
    for cond in (GAIN, NOISE):
        warm, obs = session(models, cond)
        assert assess_session(ad, obs).verdict == "FAULT"                                       # control rule
        a = assess_session(ad, obs, regime_aware=True)
        assert a.verdict == "UNFAMILIAR" and a.reason.startswith(("explained", "uncertain"))     # never a confirmed fault
        reg = ReferenceRegistry(); reg.propose(ad, warm, trusted=True)
        assert assess_session(ad, obs, ref=reg.active, regime_aware=True).verdict == "HEALTHY"


@pytest.mark.parametrize("fault,sev", [("imbalance", 0.3), ("looseness", 0.3), ("overload", 0.6), ("sensor_fault_lookalike", 0.6)])
def test_genuine_faults_stay_faults_under_a_nuisance_shift(models, fault, sev):
    for cond in (BASE, GAIN):
        warm, obs = session(models, cond, fault, sev)
        reg = ReferenceRegistry(); reg.propose(ad := models[2], warm, trusted=True)
        assert assess_session(ad, obs, ref=reg.active, regime_aware=True).verdict == "FAULT"
        assert assess_session(ad, obs, regime_aware=True).verdict == "FAULT"


def test_unseen_speed_is_unfamiliar_not_silently_healthy(models):
    _, c1, ad = models
    cond = Condition("hi", "test", speeds=(2400.0,))
    warm, obs = session(models, cond, "imbalance", 0.6, sp=2400.0)
    assert assess_session(ad, obs).verdict == "HEALTHY"                      # control: silent
    a = assess_session(ad, obs, regime_aware=True)
    assert a.verdict == "UNFAMILIAR" and a.reason == "operating_region_not_in_trained_bins"


def test_abrupt_shift_after_warmup_is_uncertain_not_a_fault(models):
    _, _, ad = models
    warm, obs = session(models, Condition("step", "test", step=(60.0, 1.2)))
    reg = ReferenceRegistry(); assert reg.propose(ad, warm, trusted=True).accepted
    assert assess_session(ad, obs, ref=reg.active, regime_aware=True).verdict == "UNFAMILIAR"


def test_robust_detector_is_a_drop_in(models):
    r = RobustBaselineDetector(rel_floor=0.05)
    r.fit(train_models()[4])
    _, obs = session(models, BASE, "imbalance", 0.6)
    assert assess_session(r, obs).verdict == "FAULT"
    _, obs = session(models, BASE)
    assert assess_session(r, obs).verdict == "HEALTHY"


# ---------------- evaluation hygiene ----------------
def test_final_test_seeds_are_disjoint_from_train_validation_and_all_earlier_evaluations():
    test = set(c1_study.TEST_SEEDS_H) | set(c1_study.TEST_SEEDS_F)
    tuned = set(c1_study.TRAIN_SEEDS) | set(c1_study.VAL_SEEDS_H) | set(c1_study.VAL_SEEDS_F)
    earlier = {0, 101, 102, 11, 12, *range(201, 206), *range(301, 304), *range(401, 404), *range(501, 506), *range(601, 604),
               *range(701, 711), 8001, 8002, 8101, 8102, 8103, 8201, 8202, *range(8301, 8307), 21, 22}
    assert not test & tuned and not test & earlier
    assert {c.split for c in c1_study.VAL_CONDITIONS} == {"val"} and {c.split for c in c1_study.TEST_CONDITIONS} == {"test"}
    held_out = {c.name for c in c1_study.TEST_CONDITIONS} - {c.name for c in c1_study.VAL_CONDITIONS}
    assert len(held_out) >= 12                                              # most test regimes never appear in validation


def test_final_stage_refuses_to_run_without_a_frozen_validation_selection(monkeypatch, tmp_path):
    monkeypatch.setattr(c1_study, "SELECTION_FILE", str(tmp_path / "missing.json"))
    with pytest.raises(SystemExit):
        c1_study.stage_final()


def test_every_session_record_carries_seed_config_truth_and_outcome(models):
    tt, c1, ad = models
    v = [c1_study.VariantSpec("control", c1, plain_control=True), c1_study.VariantSpec("B+C", ad, use_ref=True, regime_aware=True)]
    recs = c1_study.run_conditions([BASE], v, tt, (9790,), (9790,), ReferenceConfig(), CoherenceConfig(), "t")[:2]
    for r in recs:
        assert {"session_id", "seed", "sim_config", "truth", "model_version", "results"} <= set(r)
        assert r["results"]["B+C"]["verdict"] in ("HEALTHY", "FAULT", "UNFAMILIAR")


# ---------------- pipeline integration (opt-in; default behaviour unchanged) ----------------
@pytest.fixture(scope="module")
def pstack(stack):
    det, tt, hm, dm, _ = stack
    ad = AdaptiveBaselineDetector(); ad.__dict__.update(copy.deepcopy(det.__dict__)); ad.reference = None
    pred = InterventionPredictor(); pred.fit(tt)
    cal = [c for h in HYPS for sev in (0.3, 0.6, 0.9) for seed in (11, 12) for sp in (1200, 1800)
           for c in action_cases(h, sev, seed, sp, det, tt, hm)]
    pred.calibrate(cal)
    return ad, tt, hm, dm, pred


def make_orch(pstack, cfg, gain=1.0, attest=False, seed=3, start=True):
    ad, tt, hm, dm, pred = pstack
    sim = MotorSim(seed); sim.vib_gain = gain
    dev = SimDevice(sim, control_enabled=True)
    o = Orchestrator(dev, copy.deepcopy(ad), copy.deepcopy(tt), hm, dm, copy.deepcopy(pred),
                     SafetySupervisor(SupervisorLimits(vib_rms_stop_g=2.0, max_rpm=3000.0)), Store(), cfg, mode=Mode.SIMULATION)
    if attest:
        o.attest_healthy_warmup()
    if start:
        dev.send_line('{"id":9999,"type":"SET_SPEED","p":1650,"p2":0,"p3":0,"ttl":5000,"age":0,"seq":0,"k":"%s"}' % dev.key)
        dev.poll_lines()
    return o


def test_pipeline_default_is_unchanged_and_never_adapts(pstack):
    o = make_orch(pstack, PipelineConfig(), gain=1.25)
    for _ in range(120):
        o.step()
    assert o.det.reference is None and not [l for l in o.log if l["kind"] == "c1_reference"]
    assert o.incidents_done or o.inc or o.dismissed                        # a +25 % healthy gain still trips the control


def test_pipeline_does_not_adapt_without_human_attestation(pstack):
    o = make_orch(pstack, PipelineConfig(adaptive_warmup_s=40), gain=1.25, attest=False)
    for _ in range(120):
        o.step()
    assert o.det.reference is None


def test_pipeline_attested_warmup_adapts_is_audited_and_reversible(pstack):
    o = make_orch(pstack, PipelineConfig(adaptive_warmup_s=40), gain=1.25, attest=True)
    for _ in range(130):
        o.step()
    assert o.det.reference is not None and 1.15 < o.det.reference.gain < 1.35
    ev = [l for l in o.log if l["kind"] == "c1_reference"]
    assert [e["event"] for e in ev] == ["proposed", "accepted"]
    assert not o.incidents_done and o.inc is None and not o.dismissed       # healthy session: no false incident
    assert o.regime_assessment().verdict == "HEALTHY"
    o.rollback_reference()
    assert o.det.reference is None and [l["event"] for l in o.log if l["kind"] == "c1_reference"][-1] == "rolled_back"


def test_pipeline_real_fault_after_attested_warmup_is_still_detected(pstack):
    o = make_orch(pstack, PipelineConfig(adaptive_warmup_s=40), gain=1.25, attest=True)
    for _ in range(60):
        o.step()
    o.dev.sim.inject(Hypothesis.IMBALANCE, 0.5)
    for _ in range(80):
        o.step()
    assert o.inc is not None or o.incidents_done


def test_pipeline_hard_limits_are_not_delayed_by_a_pending_warmup(pstack, monkeypatch):
    import torqva.pipeline as pl
    o = make_orch(pstack, PipelineConfig(adaptive_warmup_s=60), attest=True)
    for _ in range(10):
        o.step()
    assert o.inc is None and o._warmup_pending()
    monkeypatch.setattr(pl, "mandatory_stop_reasons", lambda ctx, lim: ["housing_over_limit"])
    o.step(); o.step()
    assert o.inc is not None                                                # incident opened with the warm-up still pending
    assert any(l["kind"] == "mandatory_stop" for l in o.log)                # and the deterministic stop path ran


def test_pending_warmup_is_bounded_and_scoring_resumes_if_motor_never_reaches_steady_state(pstack):
    o = make_orch(pstack, PipelineConfig(adaptive_warmup_s=20), attest=True, start=False)      # motor never started
    for _ in range(70):
        o.step()
    assert not o._warmup_pending() and o.det.reference is None
    assert any(l["kind"] == "c1_reference" and l.get("event") == "abandoned" for l in o.log)
