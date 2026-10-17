"""Analyst workbench (simulation only): diagnostic sequences run on a copy of the live simulated motor, C2 predictions for chosen
targets, and an analyst-selected action that still has to pass freshness, the deterministic gate and the Safety Supervisor."""
import hashlib
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.api import create_router
from torqva.auth import TokenAuth
from torqva.service import SimulationService


def entry(token, user, role):
    return {"sha256": hashlib.sha256(token.encode()).hexdigest(), "user": user, "role": role}


H = lambda t: {"Authorization": f"Bearer {t}"}
B = "/api/torqva"


@pytest.fixture(scope="module")
def svc():
    return SimulationService()


@pytest.fixture(scope="module")
def c(svc):
    app = FastAPI()
    app.include_router(create_router(svc, TokenAuth([entry("v", "vera", "viewer"), entry("o", "olga", "operator")])))
    return TestClient(app)


def start(c, approval=True, fault="imbalance", seed=4):
    r = c.post(f"{B}/simulation/start", json={"fault": fault, "severity": 0.5, "clears_below_rpm": 1500, "seed": seed,
                                               "require_human_approval": approval}, headers=H("o"))
    assert r.status_code == 200


def until_pending(c):
    for _ in range(6):
        c.post(f"{B}/simulation/step", json={"seconds": 30}, headers=H("o"))
        st = c.get(f"{B}/status", headers=H("v")).json()
        if st.get("pending_approval"):
            return st
    raise AssertionError("no action was held for approval")


def test_workbench_needs_a_simulation(svc, c):
    if svc.orch is None:
        assert c.get(f"{B}/simulation/workbench/plan", headers=H("v")).status_code == 409


def test_plan_reports_c1_tests_limits_and_quick_speeds(c):
    start(c)
    c.post(f"{B}/simulation/step", json={"seconds": 20}, headers=H("o"))
    p = c.get(f"{B}/simulation/workbench/plan", headers=H("v")).json()
    assert p["provenance"] == "SIMULATED"
    assert {t["test"] for t in p["tests"]} == {"T1", "T3", "T4"}
    assert p["limits"]["max_rpm"] == 3000 and p["limits"]["setpoint_rpm"] == 1800
    assert p["limits"]["reduce_envelope_rpm"] == [540.0, 1800.0]
    assert p["quick_rpm"] and all(0 < v <= 1800 for v in p["quick_rpm"])            # fractions of the live setpoint, never above it
    assert p["posterior"] is None and p["recommended_test"] is None                    # no ranking yet: nothing to recommend


def test_sequence_input_is_validated_on_the_backend(c):
    bad = [
        {"steps": [{"type": "profile", "profile": [{"rpm": 3500, "hold_s": 30}]}]},
        {"steps": [{"type": "profile", "profile": [{"rpm": 1500, "hold_s": 2}]}]},
        {"steps": [{"type": "profile", "profile": []}]},
        {"steps": [{"type": "T9"}]},
        {"steps": []},
        {"steps": [{"type": "profile", "profile": [{"rpm": 1500, "hold_s": 900}, {"rpm": 1200, "hold_s": 900}, {"rpm": 900, "hold_s": 100}]}]},
    ]
    for b in bad:
        assert c.post(f"{B}/simulation/workbench/sequence", json=b, headers=H("o")).status_code == 422, b
    ok = {"steps": [{"type": "profile", "profile": [{"rpm": 1500, "hold_s": 30}]}]}
    assert c.post(f"{B}/simulation/workbench/sequence", json=ok, headers=H("v")).status_code == 403   # viewers cannot run tests


def test_multi_step_profile_runs_on_a_copy_and_records_every_window(svc, c):
    early = c.post(f"{B}/simulation/workbench/sequence", json={"steps": [{"type": "profile", "profile": [{"rpm": 1500, "hold_s": 10}]}]}, headers=H("o")).json()
    assert early["scenario_truth"] is None and "had not happened" in early["scenario_note"]      # t = 20 s: injection is at 40 s
    c.post(f"{B}/simulation/step", json={"seconds": 25}, headers=H("o"))
    o = svc.orch
    t0, sp0 = o.now, o.dev.sim.setpoint
    body = {"steps": [{"type": "profile", "profile": [{"rpm": 1800, "hold_s": 40}, {"rpm": 1260, "hold_s": 40}, {"rpm": 900, "hold_s": 30}]},
                      {"type": "T3"}], "stop_when_confident": False}
    r = c.post(f"{B}/simulation/workbench/sequence", json=body, headers=H("o"))
    assert r.status_code == 200, r.text
    d = r.json()
    assert o.now == t0 and o.dev.sim.setpoint == sp0                                   # the live run did not move
    prof = d["results"][0]
    assert prof["status"] == "completed" and [s["target_rpm"] for s in prof["steps"]] == [1800, 1260, 900]
    for s in prof["steps"]:
        assert s["windows"] == {1800: 40, 1260: 40, 900: 30}[s["target_rpm"]]
        assert s["mean_rpm_settled"] is not None and abs(s["tracking_error_rpm"]) < 0.15 * s["target_rpm"]
    series = [x for x in d["series"] if x["test"] == "profile"]
    assert len(series) == 110 and {x["setpoint"] for x in series} == {1800.0, 1260.0, 900.0}
    assert all(x["rpm"] is not None for x in series)                                    # observed, not a smooth fabricated curve
    pair = prof["speed_scaling"][0]
    assert pair["speed_ratio"] < 1 and pair["t1_signature_applied"] is True            # 1800 -> 1260 is the learned 70 % step-down
    assert d["results"][1]["type"] == "T3" and len(d["results"][1]["observation"]) == 1
    assert d["assessment"]["category"] in {"consistent_with_baseline", "anomalous", "hypothesis_supported", "inconclusive", "invalid", "aborted"}
    assert d["scenario_truth"] == "imbalance"                                         # ground truth reported separately
    if any(r.get("posterior_after") and r["posterior_after"]["ood"] for r in d["results"]):
        assert d["assessment"]["category"] == "inconclusive"                         # an unfamiliar test outcome never 'supports' a fault
    log = c.get(f"{B}/log", headers=H("v")).json()
    assert any(x["kind"] == "diagnostic_run" and x["id"] == d["id"] for x in log)


def test_a_coast_down_ends_the_sequence_honestly(c):
    r = c.post(f"{B}/simulation/workbench/sequence", json={"steps": [{"type": "T4"}, {"type": "T1"}]}, headers=H("o")).json()
    assert r["results"][0]["status"] == "completed"
    assert r["results"][1]["status"] == "skipped" and "stopped" in r["results"][1]["reason"]


def test_predictions_need_a_ranking_then_return_distinct_candidates(svc, c):
    start(c, seed=4)
    c.post(f"{B}/simulation/step", json={"seconds": 5}, headers=H("o"))
    assert c.get(f"{B}/simulation/workbench/predict", params={"targets": [1400]}, headers=H("v")).status_code == 409
    until_pending(c)
    assert c.get(f"{B}/simulation/workbench/predict", params={"targets": [0]}, headers=H("v")).status_code == 422
    assert c.get(f"{B}/simulation/workbench/predict", params={"targets": [1, 2, 3, 4]}, headers=H("v")).status_code == 422
    r = c.get(f"{B}/simulation/workbench/predict", params={"targets": [1400, 1260, 500]}, headers=H("v")).json()
    cands = r["candidates"]
    assert [x["target_rpm"] for x in cands] == [1400, 1260, 500] and len({x["candidate_id"] for x in cands}) == 3
    assert all(x["horizons_s"] == [30, 60, 120] and set(x["mean"]) >= {"rpm", "housing"} for x in cands)
    assert cands[0]["within_supervisor_envelope"] and not cands[2]["within_supervisor_envelope"]      # 500 < 30 % of 1800
    assert cands[0]["mean"]["rpm"][-1] != cands[1]["mean"]["rpm"][-1]                                # a real recalculation per target
    assert {x["action"] for x in r["references"]} == {"CONTINUE_MONITORING", "STOP"}
    assert r["basis"]["setpoint_rpm"] == 1800 and r["basis"]["posterior_top"]
    n_log, n_cmd, t = len(svc.orch.log), len(c.get(f"{B}/commands", headers=H("v")).json()), svc.orch.now
    c.get(f"{B}/simulation/workbench/predict", params={"targets": [1300]}, headers=H("v"))
    assert (len(svc.orch.log), len(c.get(f"{B}/commands", headers=H("v")).json()), svc.orch.now) == (n_log, n_cmd, t)   # a prediction is a pure read


def test_hypothesis_evidence_is_the_models_own_likelihood_against_the_nearest_rival(c):
    p = c.get(f"{B}/simulation/workbench/plan", headers=H("v")).json()
    hs = p["hypotheses"]
    top, second = hs[0], hs[1]
    assert top["hypothesis"] == p["posterior"]["top"] and top["compared_with"] == second["hypothesis"]
    assert second["compared_with"] == top["hypothesis"]
    assert top["supporting"] and all(x["relative_loglik"] > 0 for x in top["supporting"])
    assert second["contradicting"] and all(x["relative_loglik"] < 0 for x in second["contradicting"])
    assert p["evidence_windows"] >= p["min_evidence_windows"] and p["top_features"]


def test_stale_out_of_envelope_and_viewer_requests_are_refused(svc, c):
    basis = c.get(f"{B}/simulation/workbench/predict", params={"targets": [1400]}, headers=H("v")).json()["basis"]
    old = {**basis, "t": basis["t"] - 100}
    chk = c.post(f"{B}/simulation/workbench/check", json={"action": "REDUCE_SPEED", "target_rpm": 1400, "basis": old}, headers=H("v")).json()
    assert not chk["executable"] and chk["stale"]
    hi = c.post(f"{B}/simulation/workbench/check", json={"action": "REDUCE_SPEED", "target_rpm": 2000, "basis": basis}, headers=H("v")).json()
    assert not hi["executable"] and "reduce_target_outside_envelope" in hi["supervisor"]["reasons"]
    assert c.post(f"{B}/simulation/workbench/request", json={"action": "REDUCE_SPEED", "target_rpm": 1400, "basis": basis}, headers=H("v")).status_code == 403
    assert c.post(f"{B}/simulation/workbench/request", json={"action": "REDUCE_SPEED", "target_rpm": 1400, "basis": old}, headers=H("o")).status_code == 409
    assert svc.orch.pending is not None                                                # nothing was dispatched by the refusals


@pytest.mark.parametrize("mutate,expect", [
    (lambda p: setattr(p, "status", "unsupported") or setattr(p, "status_reasons", ["forced_for_test"]), "unsupported"),
    (lambda p: setattr(p, "risk", 0.95), "stop threshold"),
])
def test_a_target_the_pipeline_would_never_act_on_is_refused_by_the_backend(svc, c, monkeypatch, mutate, expect):
    real = svc.orch.pred.predict
    def forced(post, st, action, target_rpm=0.0, H=120):
        p = real(post, st, action, target_rpm, H)
        if action == "REDUCE_SPEED" and abs(target_rpm - 1400) < 1e-6:
            mutate(p)
        return p
    monkeypatch.setattr(svc.orch.pred, "predict", forced)
    basis = c.get(f"{B}/simulation/workbench/predict", params={"targets": [1400]}, headers=H("v")).json()["basis"]
    chk = c.post(f"{B}/simulation/workbench/check", json={"action": "REDUCE_SPEED", "target_rpm": 1400, "basis": basis}, headers=H("o")).json()
    assert not chk["executable"] and any(expect in b for b in chk["blockers"]), chk["blockers"]
    r = c.post(f"{B}/simulation/workbench/request", json={"action": "REDUCE_SPEED", "target_rpm": 1400, "basis": basis}, headers=H("o"))
    assert r.status_code == 409 and expect in r.json()["detail"]
    assert svc.orch.pending is not None                                                # still held; nothing was dispatched
    assert not [x for x in c.get(f"{B}/commands", headers=H("v")).json() if x["action"] == "REDUCE_SPEED"]


def test_selected_target_goes_through_gate_and_supervisor_to_the_simulated_device(svc, c):
    basis = c.get(f"{B}/simulation/workbench/predict", params={"targets": [1400]}, headers=H("v")).json()["basis"]
    viewer = c.post(f"{B}/simulation/workbench/check", json={"action": "REDUCE_SPEED", "target_rpm": 1400, "basis": basis}, headers=H("v")).json()
    assert not viewer["executable"] and "viewer_not_authorised" in viewer["supervisor"]["reasons"]
    chk = c.post(f"{B}/simulation/workbench/check", json={"action": "REDUCE_SPEED", "target_rpm": 1400, "basis": basis}, headers=H("o")).json()
    assert chk["gate"]["verdict"] == "ACT" and chk["executable"], chk["blockers"]
    r = c.post(f"{B}/simulation/workbench/request", json={"action": "REDUCE_SPEED", "target_rpm": 1400, "basis": basis, "candidate_id": "P1-A"}, headers=H("o"))
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["command"]["action"] == "REDUCE_SPEED" and d["command"]["params"] == {"rpm": 1400.0}
    assert svc.orch.pending is None
    again = c.post(f"{B}/simulation/workbench/request", json={"action": "REDUCE_SPEED", "target_rpm": 1400, "basis": basis}, headers=H("o"))
    assert again.status_code == 409                                                    # nothing is waiting any more: no second dispatch
    cmds = [x for x in c.get(f"{B}/commands", headers=H("v")).json() if x["action"] == "REDUCE_SPEED"]
    assert len(cmds) == 1 and cmds[0]["params"]["rpm"] == 1400
    log = c.get(f"{B}/log", headers=H("v")).json()
    assert any(x["kind"] == "analyst_action" and x["target_rpm"] == 1400 for x in log)
    # an acknowledgement is not recovery: C5 decides later from fresh windows
    st = c.get(f"{B}/status", headers=H("v")).json()
    assert st["incident"]["state"] in ("AWAITING_ACK", "VERIFYING_RECOVERY", "COMMAND_SENT")


def test_without_a_held_action_the_analyst_cannot_execute(c):
    start(c, approval=False, seed=4)
    for _ in range(3):
        c.post(f"{B}/simulation/step", json={"seconds": 30}, headers=H("o"))
    st = c.get(f"{B}/status", headers=H("v")).json()
    basis = {"t": st["t"], "setpoint_rpm": st["device"]["setpoint_rpm"]}
    r = c.post(f"{B}/simulation/workbench/request", json={"action": "REDUCE_SPEED", "target_rpm": 900, "basis": basis}, headers=H("o"))
    assert r.status_code == 409
