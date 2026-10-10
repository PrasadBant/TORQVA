"""Lab: reproducible sessions, checklist enforcement, blind integrity, matched experiments, regimes (simulation)."""
import hashlib
import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva import lab
from torqva.api import create_router
from torqva.auth import TokenAuth
from torqva.schemas import Hypothesis
from torqva.service import SimulationService
from torqva.sim import REGIMES, MotorSim


def entry(t, u, r):
    return {"sha256": hashlib.sha256(t.encode()).hexdigest(), "user": u, "role": r}


ENTRIES = [entry("v", "vera", "viewer"), entry("o", "olga", "operator"), entry("a", "adam", "admin")]
H = lambda t: {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="module")
def service():
    return SimulationService()


@pytest.fixture(scope="module")
def c(service):
    app = FastAPI()
    app.include_router(create_router(service, TokenAuth(ENTRIES)))
    return TestClient(app)


BODY = {"purpose": "fault_run", "regime": "baseline", "seed": 5, "fault": "imbalance", "severity": 0.6, "inject_at_s": 30,
        "profile": [{"rpm": 1500, "hold_s": 90}], "settings": {"mass_g": 12, "radius_mm": 40}}


def make_ready(c, body=None, who="o"):
    s = c.post("/api/torqva/lab/sessions", json=body or BODY, headers=H(who)).json()
    items = {k: True for k in ("guard", "masses", "estop", "clear", "limits")}
    c.post(f"/api/torqva/lab/sessions/{s['id']}/checklist", json={"items": items}, headers=H(who))
    return s["id"]


# ---------------- regimes ----------------
def test_regimes_are_registered_and_baseline_is_default():
    assert {"baseline", "noisy", "session_shift", "confusable_sensor", "intermittent", "hard"} <= set(REGIMES)
    assert REGIMES["baseline"].noise_mult == 1.0 and not REGIMES["baseline"].session_offsets


def test_baseline_regime_reproduces_original_simulator_exactly():
    a = MotorSim(3); a.set_setpoint(1500)
    b = MotorSim(3, regime=REGIMES["baseline"]); b.set_setpoint(1500)
    assert [w.vib_rms for w in a.run(30)] == [w.vib_rms for w in b.run(30)]


def test_noisy_regime_has_larger_spread_and_session_shift_moves_healthy_baseline():
    import numpy as np
    def vib_sd(reg, seed=1):
        s = MotorSim(seed, regime=REGIMES[reg]); s.set_setpoint(1500); s.run(20)
        return float(np.std([w.vib_rms for w in s.run(200)]))
    assert vib_sd("noisy") > 1.5 * vib_sd("baseline")
    means = []
    for seed in range(8):
        s = MotorSim(seed, regime=REGIMES["session_shift"]); s.set_setpoint(1500); s.run(20)
        means.append(np.mean([w.vib_rms for w in s.run(50)]))
    assert np.std(means) / np.mean(means) > 0.03                       # healthy sessions differ from one another


def test_confusable_sensor_fault_mimics_looseness_at_one_speed_but_not_across_speeds():
    import numpy as np
    def harmonic(fault, rpm, regime="confusable_sensor"):
        s = MotorSim(11, regime=REGIMES[regime]); s.set_setpoint(rpm); s.run(40); s.inject(fault, 0.7)
        w = s.run(40)[10:]
        return float(np.mean([x.v2x + x.v3x for x in w]))
    # at 1500 rpm both give a similar harmonic level (hard to tell apart by one window)
    a, b = harmonic(Hypothesis.LOOSENESS, 1500), harmonic(Hypothesis.SENSOR_FAULT, 1500)
    assert 0.4 < a / b < 2.5
    # across speeds looseness scales with rpm, the sensor noise does not: the physical discriminator
    loose_ratio = harmonic(Hypothesis.LOOSENESS, 900) / harmonic(Hypothesis.LOOSENESS, 1800)
    sens_ratio = harmonic(Hypothesis.SENSOR_FAULT, 900) / harmonic(Hypothesis.SENSOR_FAULT, 1800)
    assert loose_ratio < 0.7 and sens_ratio > 0.8


# ---------------- sessions ----------------
def test_session_requires_complete_checklist_before_running(c):
    s = c.post("/api/torqva/lab/sessions", json=BODY, headers=H("o")).json()
    r = c.post(f"/api/torqva/lab/sessions/{s['id']}/run", headers=H("o"))
    assert r.status_code == 422 and "checklist" in r.json()["detail"]
    c.post(f"/api/torqva/lab/sessions/{s['id']}/checklist", json={"items": {"guard": True, "estop": True}}, headers=H("o"))
    assert c.post(f"/api/torqva/lab/sessions/{s['id']}/run", headers=H("o")).status_code == 422     # still incomplete


def test_unknown_checklist_item_and_bad_inputs_are_422(c):
    s = c.post("/api/torqva/lab/sessions", json=BODY, headers=H("o")).json()
    assert c.post(f"/api/torqva/lab/sessions/{s['id']}/checklist", json={"items": {"bogus": True}}, headers=H("o")).status_code == 422
    assert c.post("/api/torqva/lab/sessions", json={**BODY, "regime": "nope"}, headers=H("o")).status_code == 422
    assert c.post("/api/torqva/lab/sessions", json={**BODY, "fault": "gremlins"}, headers=H("o")).status_code == 422
    assert c.post("/api/torqva/lab/sessions", json={**BODY, "profile": [{"rpm": 5000, "hold_s": 90}]}, headers=H("o")).status_code == 422
    assert c.post("/api/torqva/lab/sessions", json={**BODY, "profile": [{"rpm": 1500, "hold_s": 2}]}, headers=H("o")).status_code == 422
    assert c.post("/api/torqva/lab/sessions", json={**BODY, "purpose": "joyride"}, headers=H("o")).status_code == 422


def test_run_records_fault_injection_result_and_reproduces_bit_for_bit(c):
    sid = make_ready(c)
    r = c.post(f"/api/torqva/lab/sessions/{sid}/run", headers=H("o")).json()
    assert r["status"] == "completed" and r["result"]["provenance"] == "SIMULATED"
    assert r["config"]["fault"]["fault"] == "imbalance" and r["fault_settings"]["mass_g"] == 12     # injection record kept
    assert r["result"]["first_flag_after_injection_s"] is not None and r["result"]["first_flag_after_injection_s"] < 15
    rep = c.post(f"/api/torqva/lab/sessions/{sid}/reproduce", headers=H("o")).json()
    assert rep["identical"] and rep["original_hash"] == rep["rerun_hash"]
    # a different seed gives a different hash
    sid2 = make_ready(c, {**BODY, "seed": 6})
    r2 = c.post(f"/api/torqva/lab/sessions/{sid2}/run", headers=H("o")).json()
    assert r2["result"]["window_hash"] != r["result"]["window_hash"]


def test_a_session_cannot_be_run_twice(c):
    sid = make_ready(c)
    c.post(f"/api/torqva/lab/sessions/{sid}/run", headers=H("o"))
    assert c.post(f"/api/torqva/lab/sessions/{sid}/run", headers=H("o")).status_code == 409


def test_blind_session_hides_truth_until_revealed_and_model_output_is_frozen_first(c):
    sid = make_ready(c, {**BODY, "blind": True, "fault": "looseness", "seed": 8})
    shown = c.get(f"/api/torqva/lab/sessions/{sid}", headers=H("v")).json()
    assert shown["config"]["fault"] == "HIDDEN (blind session)" and shown["fault_settings"].startswith("HIDDEN")
    ran = c.post(f"/api/torqva/lab/sessions/{sid}/run", headers=H("o")).json()
    assert ran["config"]["fault"] == "HIDDEN (blind session)"              # still hidden after the run
    assert "truth_match" not in ran["result"] and "model_output_frozen" in ran["result"]
    listed = [x for x in c.get("/api/torqva/lab/sessions", headers=H("v")).json() if x["id"] == sid][0]
    assert listed["config"]["fault"] == "HIDDEN (blind session)"
    frozen = ran["result"]["model_output_frozen"]
    rev = c.post(f"/api/torqva/lab/sessions/{sid}/reveal", headers=H("o")).json()
    assert rev["config"]["fault"]["fault"] == "looseness"
    assert rev["result"]["model_output_frozen"] == frozen                   # reveal did not change the frozen output
    assert rev["result"]["truth_match"]["truth"] == "looseness"


def test_cannot_reveal_before_running(c):
    sid = make_ready(c, {**BODY, "blind": True})
    assert c.post(f"/api/torqva/lab/sessions/{sid}/reveal", headers=H("o")).status_code == 422


def test_healthy_session_abstains_instead_of_guessing(c):
    sid = make_ready(c, {**BODY, "fault": None, "seed": 9})
    r = c.post(f"/api/torqva/lab/sessions/{sid}/run", headers=H("o")).json()
    assert r["result"]["model_output_frozen"]["abstained"] is True


def test_viewer_cannot_create_or_run_and_everything_is_audited(c, service):
    assert c.post("/api/torqva/lab/sessions", json=BODY, headers=H("v")).status_code == 403
    assert c.post("/api/torqva/lab/sessions/L-0001/run", headers=H("v")).status_code == 403
    kinds = {x["kind"] for x in c.get("/api/torqva/audit", headers=H("a")).json()}
    assert {"lab_session_created", "lab_checklist", "lab_session_run", "lab_session_reproduced"} <= kinds
    cl = [x for x in c.get("/api/torqva/audit", params={"kind": "lab_checklist"}, headers=H("a")).json() if x["detail"]["complete"]]
    assert cl and cl[0]["actor"] == "olga"


def test_checklist_and_regimes_endpoints(c):
    cl = c.get("/api/torqva/lab/checklist", headers=H("v")).json()
    assert {i["key"] for i in cl["items"]} == {"guard", "masses", "estop", "clear", "limits"} and "not a safety mechanism" in cl["note"]
    assert any(x["name"] == "hard" for x in c.get("/api/torqva/lab/regimes", headers=H("v")).json())


# ---------------- experiments ----------------
def test_experiment_uses_matched_starting_conditions_and_reports_per_action_results(c):
    r = c.post("/api/torqva/lab/experiments", json={"fault": "imbalance", "severity": 0.6, "speed_rpm": 1800, "repeats": 3},
               headers=H("o"))
    assert r.status_code == 200, r.text
    x = r.json()
    assert x["matched_starting_conditions"] is True and x["validated_c2"] is False and x["provenance"] == "SIMULATED"
    assert len(x["ranking"]) == 3 and "per_action_signal" in x
    stop_rpm = x["per_action_signal"]["STOP/rpm"]
    assert stop_rpm["mae"] < stop_rpm["persistence_mae"]
    assert 0.0 <= x["risk_brier_score"] <= 1.0
    assert all(0.0 <= v["interval_coverage"] <= 1.0 for v in x["per_action_signal"].values())
    assert c.get("/api/torqva/lab/experiments", headers=H("v")).json()[-1]["id"] == x["id"]


def test_experiment_validation_and_roles(c):
    assert c.post("/api/torqva/lab/experiments", json={"fault": "imbalance", "repeats": 50}, headers=H("o")).status_code == 422
    assert c.post("/api/torqva/lab/experiments", json={"fault": "gremlins"}, headers=H("o")).status_code == 422
    assert c.post("/api/torqva/lab/experiments", json={"fault": "imbalance", "regime": "nope"}, headers=H("o")).status_code == 422
    assert c.post("/api/torqva/lab/experiments", json={"fault": "imbalance"}, headers=H("v")).status_code == 403
