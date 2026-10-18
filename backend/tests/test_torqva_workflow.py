"""Unified diagnostic workflow (workflow.py): one request runs a selected C4 pattern and carries its evidence through diagnosis, C2, the gate,
the existing C3 path and C5 verification. Simulation runs end to end; physical mode is blocked at validation and never sends anything."""
import dataclasses
import hashlib
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva import workbench as wb
from torqva import workflow as wf
from torqva.api import create_router
from torqva.auth import TokenAuth
from torqva.schemas import Role
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


@pytest.fixture(autouse=True)
def fresh_registry():
    wf.reset()
    yield
    wf.reset()


def start(c, approval=True, fault="imbalance", seed=4, clears=1500):
    r = c.post(f"{B}/simulation/start", json={"fault": fault, "severity": 0.5, "clears_below_rpm": clears, "seed": seed,
                                               "require_human_approval": approval}, headers=H("o"))
    assert r.status_code == 200


def step(c, s):
    assert c.post(f"{B}/simulation/step", json={"seconds": s}, headers=H("o")).status_code == 200


def until_pending(c):
    for _ in range(8):
        step(c, 30)
        if c.get(f"{B}/status", headers=H("v")).json().get("pending_approval"):
            return
    raise AssertionError("no action was held for approval")


def run(c, pattern="T3", policy="require_confirmation", mode="SIMULATION", key=None, token="o"):
    body = {"mode": mode, "pattern": pattern, "execution_policy": policy}
    if key:
        body["idempotency_key"] = key
    return c.post(f"{B}/workflow/runs", json=body, headers=H(token))


def n_commands(c):
    return len(c.get(f"{B}/commands", headers=H("v")).json())


# ------------------------------------------------------------------------------------------------ patterns (C4 configuration)
def test_patterns_come_from_the_real_test_definitions_with_live_prerequisites(c):
    start(c)
    step(c, 20)
    p = c.get(f"{B}/workflow/patterns", params={"mode": "SIMULATION"}, headers=H("v")).json()
    ids = [x["id"] for x in p["patterns"]]
    assert ids == ["T1", "T3", "T4", "SWEEP", "ADAPTIVE"]
    t1 = p["patterns"][0]
    assert t1["investigates"] == wb.TEST_FOR["T1"] and t1["expected_observations"] == wb.OBS_MEANING["T1"]
    assert [s["rpm"] for s in t1["sequence"]] == [1800.0, 1260.0] and t1["duration_s"] == 60
    assert t1["signals"] == list(wb.TEST_SIGNALS["T1"])
    assert all(isinstance(q["ok"], bool) and q["check"] for x in p["patterns"] for q in x["prerequisites"])
    sweep = p["patterns"][3]
    assert all(540 <= s["rpm"] <= 1800 for s in sweep["sequence"])                      # inside the envelope, never above the setpoint
    ad = p["patterns"][4]
    assert not ad["available"] and any("hypothesis ranking" in q["check"] and not q["ok"] for q in ad["prerequisites"])
    assert all("not available" in x["availability"]["PHYSICAL"] for x in p["patterns"])


def test_physical_patterns_are_all_unavailable_for_the_firmware_reason_and_never_read_the_simulator(svc, c):
    start(c)
    step(c, 10)
    n = len(svc.orch.log)
    p = c.get(f"{B}/workflow/patterns", params={"mode": "PHYSICAL"}, headers=H("v")).json()
    assert p["provenance"] == "MEASURED"
    assert all(not x["available"] and x["sequence"] == [] for x in p["patterns"])
    assert all(any("no diagnostic-test command" in q["check"] for q in x["prerequisites"]) for x in p["patterns"])
    assert len(svc.orch.log) == n


def test_workflow_input_is_validated_and_role_checked_on_the_backend(c):
    start(c)
    step(c, 20)
    assert run(c, pattern="T9").status_code == 422
    assert run(c, mode="HYBRID").status_code == 422
    assert run(c, policy="always").status_code == 422
    assert run(c, key="bad key!").status_code == 422
    assert run(c, token="v").status_code == 403                                          # a viewer cannot start a workflow
    assert c.get(f"{B}/workflow/patterns", params={"mode": "X"}, headers=H("v")).status_code == 422


# ------------------------------------------------------------------------------------------------ healthy motor
def test_a_healthy_motor_gets_no_intervention_and_no_command(svc, c):
    start(c, fault=None, clears=None)
    step(c, 30)
    n = n_commands(c)
    r = run(c, "T3").json()
    assert r["status"] == "COMPLETED" and r["outcome"] == "NO_INTERVENTION_NEEDED"
    assert r["context"]["diagnosis"]["condition"] == "NO_ANOMALY_DETECTED"
    assert r["context"]["predictions"]["available"] is False and "conditional on a fault-hypothesis ranking" in r["context"]["predictions"]["reason"]
    rec = r["context"]["recommendation"]
    assert rec["action"] == "CONTINUE_MONITORING" and rec["target_rpm"] is None and rec["adjustments"][0]["change_rpm"] == 0
    assert [s["stage"] for s in r["stages"]] == list(wf.STAGES[:7])
    assert n_commands(c) == n


# ------------------------------------------------------------------------------------------------ C4 -> C1 -> C2 -> C3 -> C5
def test_one_request_runs_the_test_diagnoses_predicts_and_recommends_then_authorization_executes_and_c5_verifies(svc, c):
    start(c)
    until_pending(c)
    n = n_commands(c)
    r = run(c, "T3", key="wf-chain-0001").json()
    assert r["status"] == "AWAITING_AUTHORIZATION", r["blockers"]
    # C4: the selected pattern actually ran (a diagnostic_run record exists) on a copy, with its observations
    t = r["context"]["test"]
    assert svc.orch.get("diagnostic_run", t["run_id"]) is not None and t["stages"][0]["test"] == "T3" and t["stages"][0]["observation"]
    assert t["simulated_seconds"] == 300 and t["provenance"] == "SIMULATED"
    # C1: diagnosis from the test-updated ranking, with traceable feature evidence
    dx = r["context"]["diagnosis"]
    assert dx["condition"] == "FAULT_HYPOTHESIS_SUPPORTED" and dx["primary"]["hypothesis"] == "imbalance"
    assert dx["hypotheses"] and dx["hypotheses"][0]["supporting"]
    assert dx["scenario_truth"] == "imbalance" and "never used by TORQVA" in dx["scenario_note"]
    # C2: every candidate computed with its own target
    pr = r["context"]["predictions"]
    targets = [x["target_rpm"] for x in pr["candidates"]]
    assert len(set(targets)) == len(targets) == 3 and len({x["candidate_id"] for x in pr["candidates"] + pr["references"]}) == 5
    for x in pr["candidates"]:
        assert abs(x["mean"]["rpm"][-1] - x["target_rpm"]) < 0.05 * x["target_rpm"]        # its own target, not a relabelled result
        assert 540 <= x["target_rpm"] < 1800
    # the recommendation: an explicit action, RPM, adjustment and rationale
    rec = r["context"]["recommendation"]
    assert rec["kind"] == "INTERVENTION" and rec["action"] == "REDUCE_SPEED"
    assert rec["target_rpm"] == 1260.0 and rec["current_setpoint_rpm"] == 1800.0 and rec["change_rpm"] == -540.0
    assert rec["gate"]["verdict"] == "ACT" and rec["why"] and rec["predicted_outcome"]["rows"]
    assert rec["adjustments"][0]["parameter"] == "speed setpoint" and rec["adjustments"][0]["to_rpm"] == 1260.0
    assert n_commands(c) == n                                                            # nothing is sent before authorization
    # C3: authorization carries the exact recommendation into the existing path
    a = c.post(f"{B}/workflow/runs/{r['id']}/authorize", headers=H("o")).json()
    assert a["status"] == "VERIFYING_OUTCOME"
    iv = a["context"]["intervention"]
    assert iv["command"]["action"] == "REDUCE_SPEED" and iv["command"]["params"] == {"rpm": 1260.0} and iv["receipt_id"].startswith("R-")
    assert iv["candidate_id"] == rec["candidate_id"]
    assert n_commands(c) == n + 1
    again = c.post(f"{B}/workflow/runs/{r['id']}/authorize", headers=H("o"))
    assert again.status_code == 409 and "never re-sent" in again.json()["detail"]
    assert n_commands(c) == n + 1
    assert c.post(f"{B}/workflow/runs/{r['id']}/cancel", json={}, headers=H("o")).status_code == 409
    # C5: verification is read from the pipeline's own assessment, after simulated time passes
    for _ in range(10):
        step(c, 20)
        g = c.get(f"{B}/workflow/runs/{r['id']}", headers=H("v")).json()
        if g["status"] != "VERIFYING_OUTCOME":
            break
    assert g["status"] == "COMPLETED" and g["outcome"] == "RECOVERY_VERIFIED"
    v = g["context"]["verification"]
    assert v["assessment"]["by"].startswith("C5") and v["command"]["accepted"] and v["post_ack_windows"] > 0
    assert v["predicted_vs_observed"] and all("inside_interval" in x for x in v["predicted_vs_observed"])
    # traceable: stored record and audit events
    stored = svc.store.get("workflow", f"{svc.orch.session}/{r['id']}")
    assert stored["status"] == "COMPLETED" and stored["context"]["intervention"]["command_id"] == iv["command_id"]
    events = [l for l in svc.orch.log if l["kind"] == "workflow" and l["id"] == r["id"]]
    assert [e["event"] for e in events] == ["started", "awaiting_authorization", "dispatched", "verified"]
    assert [e["to"] for e in g["events"]][-3:] == ["EXECUTING_ACTION", "VERIFYING_OUTCOME", "COMPLETED"]


def test_auto_when_permitted_executes_in_the_same_request(c):
    start(c)
    until_pending(c)
    n = n_commands(c)
    r = run(c, "T3", policy="auto_when_permitted").json()
    assert r["status"] == "VERIFYING_OUTCOME" and r["context"]["authorization"]["decision"] == "AUTHORIZED"
    assert "pre-authorized" in r["context"]["authorization"]["how"]
    assert n_commands(c) == n + 1


def test_a_double_click_with_the_same_key_never_runs_a_second_test(svc, c):
    start(c)
    until_pending(c)
    runs0 = len(svc.orch.records("diagnostic_run"))
    a = run(c, "T3", key="dbl-click-0001").json()
    b = run(c, "T3", key="dbl-click-0001").json()
    assert b["id"] == a["id"] and b.get("replayed") is True
    assert len(svc.orch.records("diagnostic_run")) == runs0 + 1
    assert run(c, "T1", key="dbl-click-0001").status_code == 409


def test_declining_sends_nothing_and_leaves_the_pipelines_held_action_alone(svc, c):
    start(c)
    until_pending(c)
    n = n_commands(c)
    r = run(c, "T3").json()
    d = c.post(f"{B}/workflow/runs/{r['id']}/cancel", json={"reason": "not now"}, headers=H("o")).json()
    assert d["status"] == "CANCELLED" and d["outcome"] == "INTERVENTION_DECLINED"
    assert svc.orch.pending is not None and n_commands(c) == n
    assert c.post(f"{B}/workflow/runs/{r['id']}/authorize", headers=H("o")).status_code == 409


def test_a_stale_recommendation_expires_and_cannot_be_authorized(c):
    start(c)
    until_pending(c)
    n = n_commands(c)
    r = run(c, "T3").json()
    step(c, 40)                                                                          # past MAX_PREDICTION_AGE_S of simulated time
    g = c.get(f"{B}/workflow/runs/{r['id']}", headers=H("v")).json()
    assert g["status"] == "PARTIAL" and g["outcome"] == "AUTHORIZATION_EXPIRED"
    assert c.post(f"{B}/workflow/runs/{r['id']}/authorize", headers=H("o")).status_code == 409
    assert n_commands(c) == n


def test_a_safety_rejection_at_execution_sends_nothing(svc, c):
    start(c)
    until_pending(c)
    r = run(c, "T3").json()
    n = n_commands(c)
    o = svc.orch
    o.buf[-1] = dataclasses.replace(o.buf[-1], valid=False)                              # the sensors fail between recommendation and authorization
    a = c.post(f"{B}/workflow/runs/{r['id']}/authorize", headers=H("o")).json()
    assert a["status"] == "PARTIAL" and a["outcome"] == "INTERVENTION_REJECTED"
    assert any("Safety Supervisor refuses" in b and "sensors_not_valid" in b for b in a["blockers"])
    assert n_commands(c) == n and a["context"].get("intervention") is None


def test_an_emergency_stop_after_the_recommendation_expires_it(svc, c):
    start(c)
    until_pending(c)
    r = run(c, "T3").json()
    n = n_commands(c)
    svc.orch.dev.inject_estop("TEST_ESTOP")                                              # the setpoint drops to 0: the basis no longer holds
    a = c.post(f"{B}/workflow/runs/{r['id']}/authorize", headers=H("o"))
    assert a.status_code == 409 and "AUTHORIZATION_EXPIRED" in a.json()["detail"] and "setpoint changed" in a.json()["detail"]
    assert n_commands(c) == n


def test_restarting_the_simulation_cancels_a_pending_authorization(c):
    start(c)
    until_pending(c)
    r = run(c, "T3").json()
    start(c, fault=None, clears=None)
    g = c.get(f"{B}/workflow/runs/{r['id']}", headers=H("v")).json()
    assert g["status"] == "CANCELLED" and g["outcome"] == "SIMULATION_RESTARTED"
    assert c.post(f"{B}/workflow/runs/{r['id']}/authorize", headers=H("o")).status_code == 409


def test_a_newer_recommendation_supersedes_an_older_one(c):
    start(c)
    until_pending(c)
    a = run(c, "T3").json()
    b = run(c, "T3").json()
    assert b["status"] == "AWAITING_AUTHORIZATION"
    g = c.get(f"{B}/workflow/runs/{a['id']}", headers=H("v")).json()
    assert g["status"] == "CANCELLED" and g["outcome"] == "SUPERSEDED"


def test_when_the_pipeline_already_acted_the_workflow_never_sends_a_second_command(svc, c):
    start(c, approval=False)
    step(c, 90)
    n = n_commands(c)
    r = run(c, "T3", policy="auto_when_permitted").json()
    assert r["status"] == "PARTIAL" and r["outcome"] == "RECOMMENDATION_NOT_EXECUTABLE"
    assert r["context"]["execution_check"]["pipeline_command"] is not None
    assert n_commands(c) == n


# ------------------------------------------------------------------------------------------------ failures and blocked prerequisites
def test_an_emergency_stop_blocks_the_workflow_before_any_test(svc, c):
    start(c)
    step(c, 20)
    svc.orch.dev.inject_estop("TEST_ESTOP")
    runs0 = len(svc.orch.records("diagnostic_run"))
    r = run(c, "T1").json()
    assert r["status"] == "BLOCKED" and r["stages"][-1]["status"] == "blocked"
    assert any("emergency stop" in b for b in r["blockers"])
    assert len(svc.orch.records("diagnostic_run")) == runs0


def test_invalid_recent_telemetry_blocks_the_workflow(svc, c):
    start(c)
    step(c, 20)
    o = svc.orch
    o.buf[-10:] = [dataclasses.replace(w, valid=False) for w in o.buf[-10:]]
    r = run(c, "T3").json()
    assert r["status"] == "BLOCKED" and any("recent windows valid" in b for b in r["blockers"])


def test_a_stage_failure_is_reported_as_failed_with_the_evidence_kept(svc, c, monkeypatch):
    start(c)
    until_pending(c)
    n = n_commands(c)

    def boom(*a, **k):
        raise RuntimeError("model unavailable")
    monkeypatch.setattr(wf, "_predictions", boom)
    r = run(c, "T3").json()
    assert r["status"] == "FAILED" and r["outcome"] == "WORKFLOW_FAILED" and "model unavailable" in r["error"]
    assert r["context"]["test"]["run_id"] and r["context"]["diagnosis"]                    # evidence up to the failure is kept
    assert r["stages"][-1]["stage"] == "CALCULATING_PREDICTIONS" and r["stages"][-1]["status"] == "failed"
    assert n_commands(c) == n


# ------------------------------------------------------------------------------------------------ physical mode
def test_a_physical_workflow_is_blocked_at_validation_and_sends_nothing(svc, c):
    start(c)
    step(c, 10)
    log0, cmds0 = len(svc.orch.log), len(svc.bridge.command_list())
    r = run(c, "T1", mode="PHYSICAL", policy="auto_when_permitted").json()
    assert r["status"] == "BLOCKED" and r["provenance"] == "MEASURED" and r["session"] is None
    assert [s["stage"] for s in r["stages"]] == ["VALIDATING"]
    assert any("no diagnostic-test command" in b for b in r["blockers"])
    assert r["context"]["initial_telemetry"]["values"] == {}                               # nothing fresh: no value is invented
    assert len(svc.bridge.command_list()) == cmds0 and len(svc.orch.log) == log0
    assert c.post(f"{B}/workflow/runs/{r['id']}/authorize", headers=H("o")).status_code == 409
    sims = c.get(f"{B}/workflow/runs", params={"mode": "SIMULATION"}, headers=H("v")).json()
    assert r["id"] not in [x["id"] for x in sims]                                           # the modes never share a list


def test_even_fresh_physical_telemetry_cannot_satisfy_the_workflow(svc, c, monkeypatch):
    snap = {"handshake": True, "origin": "physical_device", "telemetry_fresh": True, "last_rx_unix": 1.0,
            "values": {"rpm": {"value": 1500.0, "valid": True, "stale": False}, "current": {"value": None, "valid": False, "stale": False}},
            "analysis": {"missing_inputs": ["vib_rms", "v1x", "v2x", "v3x", "vhf"]}, "control_blockers": []}
    monkeypatch.setattr(svc.bridge, "snapshot", lambda: snap)
    r = run(c, "SWEEP", mode="PHYSICAL").json()
    assert r["status"] == "BLOCKED"
    assert r["context"]["initial_telemetry"]["values"] == {"rpm": 1500.0, "current": None}   # an invalid reading is null, never zero
    assert any("missing vib_rms" in b for b in r["blockers"]) and any("no diagnostic-test command" in b for b in r["blockers"])


def test_the_bridge_really_rejects_a_test_command(svc):
    rec = svc.bridge.request_command("RUN_TEST", {"test": 1}, "olga", Role.ADMIN)          # port-less bridge: rejected before any send
    assert "UNSUPPORTED_COMMAND" in rec.public()["reasons"]
    assert tuple(wf.PHYSICAL_COMMANDS) == ("STOP", "START", "SET_SPEED")


# ------------------------------------------------------------------------------------------------ units
def test_invalid_transitions_are_refused():
    w = wf._new("SIMULATION", "T1", "require_confirmation", None, "u", Role.OPERATOR, 3)
    with pytest.raises(wf.WorkflowError):
        wf._stage(w, "EXECUTING_ACTION", 0.0)
    wf._stage(w, "VALIDATING", 0.0)
    with pytest.raises(wf.WorkflowError):
        wf._stage(w, "VERIFYING_OUTCOME", 0.0)
    for frm, tos in wf.NEXT.items():
        assert tos <= set(wf.STAGES) | set(wf.TERMINAL), frm


def _v(label, action, target, risk, status="supported", env=True, default=False):
    return {"candidate_id": label, "label": label, "action": action, "target_rpm": target, "risk": risk, "status": status, "status_reasons": [],
            "within_supervisor_envelope": env, "pipeline_default": default}


def test_ranking_follows_the_pipeline_rule_and_never_prefers_a_lower_speed_for_its_own_sake():
    from torqva.gate import GateConfig
    g = GateConfig()
    views = [_v("A", "REDUCE_SPEED", 1260, 0.0, default=True), _v("B", "REDUCE_SPEED", 1530, 0.0), _v("C", "REDUCE_SPEED", 900, 0.0),
             _v("Continue", "CONTINUE_MONITORING", None, 0.0), _v("Stop", "STOP", 0.0, 0.0)]
    r = wf._rank(views, 1800.0, g)
    assert r[0]["label"] == "Continue" and not r[0]["eligible"]
    assert next(x for x in r if x["eligible"])["label"] == "A"                              # ties keep the pipeline's own target
    views[1]["risk"] = -0.0
    views[0]["risk"], views[2]["risk"] = 0.2, 0.2                                           # a real risk difference wins over the default
    assert next(x for x in wf._rank(views, 1800.0, g) if x["eligible"])["label"] == "B"
    bad = [_v("A", "REDUCE_SPEED", 1260, 0.1, status="unsupported"), _v("B", "REDUCE_SPEED", 1530, 0.7), _v("C", "REDUCE_SPEED", 900, 0.1, env=False),
           _v("Stop", "STOP", 0.0, 0.3)]
    r = wf._rank(bad, 1800.0, g)
    why = {x["label"]: x["excluded_because"] for x in r}
    assert "unsupported" in why["A"] and "stop threshold" in why["B"] and "envelope" in why["C"] and why["Stop"] is None
