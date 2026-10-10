"""Phase 13 hardening regressions: authorization matrix, malformed input, concurrency, dispatcher replay/duplicate handling, non-finite measurements, legacy route credentials, CORS.
Simulation only; no hardware."""
import hashlib
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.api import create_router, install_error_handlers
from torqva.auth import TokenAuth
from torqva.dispatch import CommandDispatcher
from torqva.gate import GateConfig, GateInputs, decide
from torqva.hypotheses import Posterior
from torqva.schemas import (ActionType, CommandStatus, Connection, DecisionVerdict, DeviceSafetyState, GateVerdict, Hypothesis as Hy, Mode, ProposalSource,
                            ProposedAction, Role)
from torqva.service import SimulationService
from torqva.supervisor import SafetySupervisor, SupervisorContext, SupervisorLimits, mandatory_stop_reasons


def entry(token, user, role):
    return {"sha256": hashlib.sha256(token.encode()).hexdigest(), "user": user, "role": role}


H = lambda t: {"Authorization": f"Bearer {t}"}
ENTRIES = [entry("v", "vera", "viewer"), entry("o", "olga", "operator"), entry("a", "adam", "admin")]


@pytest.fixture(scope="module")
def service():
    return SimulationService()


def make_client(service, entries=ENTRIES):
    app = FastAPI()
    app.include_router(create_router(service, TokenAuth(entries)))
    install_error_handlers(app)
    return TestClient(app, raise_server_exceptions=False)


# ----------------------------------------------------------------------------------------------------- authorization matrix
OPERATOR_ROUTES = [("POST", "/simulation/start", {"fault": None}), ("POST", "/simulation/step", {"seconds": 1}), ("POST", "/approvals/approve", None), ("POST", "/approvals/reject", None),
                   ("POST", "/lab/sessions", {}), ("POST", "/lab/experiments", {"fault": "imbalance"}), ("POST", "/attestation/candidates", None)]
ADMIN_ROUTES = [("POST", "/commands/reset-estop", None), ("GET", "/audit", None)]


@pytest.mark.parametrize("method,path,body", OPERATOR_ROUTES)
def test_viewer_cannot_use_operator_routes_and_nothing_changes(service, method, path, body):
    c = make_client(service)
    before = service.orch
    r = c.request(method, "/api/torqva" + path, headers=H("v"), json=body)
    assert r.status_code == 403
    assert service.orch is before
    assert c.request(method, "/api/torqva" + path, json=body).status_code == 401           # no token at all


@pytest.mark.parametrize("method,path,body", ADMIN_ROUTES)
def test_operator_cannot_use_admin_routes(service, method, path, body):
    c = make_client(service)
    assert c.request(method, "/api/torqva" + path, headers=H("o"), json=body).status_code == 403


def test_forged_and_malformed_authorization_headers_are_rejected(service):
    c = make_client(service)
    for h in ({"Authorization": "Bearer "}, {"Authorization": "Bearer nope"}, {"Authorization": "Basic dm9yYQ=="}, {"Authorization": "bearer" }, {"Authorization": "Bearer v v"}):
        assert c.get("/api/torqva/status", headers=h).status_code == 401, h


def test_stop_is_available_to_every_authenticated_role_and_only_makes_things_safer(service):
    c = make_client(service)
    c.post("/api/torqva/simulation/start", headers=H("o"), json={"fault": None})
    for t in ("v", "o", "a"):
        r = c.post("/api/torqva/commands/stop", headers=H(t))
        assert r.status_code == 200, (t, r.text)


# ----------------------------------------------------------------------------------------------------- malformed input never becomes a 500
BAD_START = [{"seed": 10 ** 30}, {"seed": -1}, {"severity": "a"}, {"severity": 1e308}, {"setpoint_rpm": "NaN"}, {"inject_after_s": -1}, {"fault": 5}, {"fault": "x" * 100}, [], "x", None]
RAW_BAD = [b"{not json", b'{"seed": NaN}', b'{"setpoint_rpm": NaN}', b'{"clears_below_rpm": Infinity}', b'{"severity": NaN}', b"\xff\xfe", b""]


@pytest.mark.parametrize("body", BAD_START)
def test_bad_simulation_start_bodies_are_422(service, body):
    c = make_client(service)
    assert c.post("/api/torqva/simulation/start", headers=H("o"), json=body).status_code in (400, 422)


@pytest.mark.parametrize("raw", RAW_BAD)
def test_raw_malformed_and_non_finite_json_is_a_4xx_not_a_500(service, raw):
    c = make_client(service)
    r = c.post("/api/torqva/simulation/start", headers={**H("o"), "Content-Type": "application/json"}, content=raw)
    assert 400 <= r.status_code < 500, (raw, r.status_code, r.text[:100])


def test_oversized_lab_payloads_are_refused(service):
    c = make_client(service)
    assert c.post("/api/torqva/lab/sessions", headers=H("o"), json={"notes": "n" * 5000}).status_code == 422
    assert c.post("/api/torqva/lab/sessions", headers=H("o"), json={"settings": {"a": "x" * 20000}}).status_code == 422
    assert c.post("/api/torqva/lab/sessions", headers=H("o"), json={"profile": [{"rpm": 1000, "hold_s": 10}] * 60}).status_code == 422
    assert c.post("/api/torqva/lab/experiments", headers=H("o"), json={"fault": "imbalance", "seed0": 10 ** 30}).status_code == 422


# ----------------------------------------------------------------------------------------------------- concurrency: STOP is never queued behind a long run
def test_stop_is_not_blocked_by_a_long_step_and_state_stays_consistent():
    svc = SimulationService()
    c = make_client(svc)
    assert c.post("/api/torqva/simulation/start", headers=H("o"), json={"fault": None}).status_code == 200
    errors, done = [], threading.Event()

    def stepper():
        try:
            r = c.post("/api/torqva/simulation/step", headers=H("o"), json={"seconds": 300})
            if r.status_code != 200:
                errors.append(r.text)
        except Exception as e:                                       # pragma: no cover
            errors.append(repr(e))
        finally:
            done.set()

    t = threading.Thread(target=stepper); t.start()
    time.sleep(0.2)
    worst = 0.0
    while not done.is_set():
        t0 = time.time()
        r = c.post("/api/torqva/commands/stop", headers=H("v"))
        worst = max(worst, time.time() - t0)
        assert r.status_code == 200, r.text
        assert c.get("/api/torqva/status", headers=H("v")).status_code == 200
        time.sleep(0.05)
    t.join()
    assert not errors, errors
    assert worst < 1.5, f"STOP waited {worst:.2f}s behind a running step"          # one simulated second at a time, never the whole 300 s


def test_concurrent_restarts_and_steps_do_not_crash():
    svc = SimulationService()
    c = make_client(svc)
    c.post("/api/torqva/simulation/start", headers=H("o"), json={"fault": "imbalance"})
    errs = []

    def hammer(fn):
        try:
            for _ in range(15):
                r = fn()
                if r.status_code >= 500:
                    errs.append((r.status_code, r.text[:80]))
        except Exception as e:                                       # pragma: no cover
            errs.append(repr(e))
    ths = [threading.Thread(target=hammer, args=(f,)) for f in (
        lambda: c.post("/api/torqva/simulation/step", headers=H("o"), json={"seconds": 3}),
        lambda: c.post("/api/torqva/simulation/start", headers=H("o"), json={"fault": None, "seed": 5}),
        lambda: c.get("/api/torqva/telemetry", headers=H("v")),
        lambda: c.get("/api/torqva/status", headers=H("v")))]
    [t.start() for t in ths]; [t.join() for t in ths]
    assert not errs, errs[:3]


# ----------------------------------------------------------------------------------------------------- dispatcher: replay, duplicates, malformed acks
def _approved(action=ActionType.SET_SPEED, params=None):
    sup = SafetySupervisor(SupervisorLimits(vib_rms_stop_g=2.0, max_rpm=3000.0, auto_approve_in_simulation=True))
    ctx = SupervisorContext(mode=Mode.SIMULATION, hardware_control_enabled=True, connection=Connection.CONNECTED, device_state=DeviceSafetyState.OK, telemetry_age_s=0.0,
                            sensors_valid=True, motor_running=True, current_setpoint_rpm=1800.0)
    d = sup.check(ProposedAction(action=action, source=ProposalSource.HUMAN, role=Role.OPERATOR, params=params or {"rpm": 1500.0}, human_approved=True), ctx)
    assert d.verdict == DecisionVerdict.ALLOW
    return d.approved


def test_dispatcher_ignores_malformed_acks_instead_of_raising():
    sent = []
    disp = CommandDispatcher(sent.append, "k")
    rec = disp.dispatch(_approved(), 0.0)
    for bad in ({"id": "abc"}, {"id": None}, {"id": [1]}, {"id": {"x": 1}}, {"id": True}, {"id": 10 ** 400}, {"id": float("nan")}, {}, {"id": rec.id, "status": "NOT_A_STATUS"}):
        disp.on_ack(bad, 0.5)                                              # must not raise
    assert disp.records[rec.id].status == CommandStatus.PENDING


def test_an_ack_cannot_reopen_expire_or_time_out_a_command_and_duplicates_are_idempotent():
    sent = []
    disp = CommandDispatcher(sent.append, "k")
    rec = disp.dispatch(_approved(), 0.0)
    disp.on_ack({"id": rec.id, "status": "ACCEPTED"}, 0.1)
    n_history = len(rec.history)
    for st in ("PENDING", "TIMEOUT", "EXPIRED", "ACCEPTED"):
        disp.on_ack({"id": rec.id, "status": st}, 0.2)
    assert rec.status == CommandStatus.ACCEPTED and len(rec.history) == n_history
    resent_before = len(sent)
    disp.poll(10.0)                                                        # an ACCEPTED command is never re-sent
    assert len(sent) == resent_before
    disp.on_ack({"id": rec.id, "status": "COMPLETED"}, 0.3)
    disp.on_ack({"id": rec.id, "status": "ACCEPTED"}, 0.4)                 # replay of an older ack after completion
    assert rec.status == CommandStatus.COMPLETED


def test_dispatch_still_refuses_anything_the_supervisor_did_not_mint():
    disp = CommandDispatcher(lambda s: None, "k")
    with pytest.raises(PermissionError):
        disp.dispatch(object(), 0.0)


# ----------------------------------------------------------------------------------------------------- measurements: missing or garbled data is never healthy
@pytest.mark.parametrize("field", ["housing_c", "current_a", "voltage_v", "vib_rms_g"])
@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_measurement_is_a_mandatory_stop_reason(field, bad):
    ctx = SupervisorContext(mode=Mode.SIMULATION, hardware_control_enabled=True, connection=Connection.CONNECTED, device_state=DeviceSafetyState.OK, telemetry_age_s=0.0,
                            sensors_valid=True, motor_running=True, **{field: bad})
    assert "measurement_not_finite" in mandatory_stop_reasons(ctx, SupervisorLimits(vib_rms_stop_g=2.0, max_rpm=3000.0))
    sup = SafetySupervisor(SupervisorLimits(vib_rms_stop_g=2.0, max_rpm=3000.0))
    d = sup.check(ProposedAction(action=ActionType.SET_SPEED, source=ProposalSource.HUMAN, role=Role.OPERATOR, params={"rpm": 1500.0}, human_approved=True), ctx)
    assert d.verdict == DecisionVerdict.REJECT and d.mandatory_stop                       # no non-stop action while a reading is garbage
    assert sup.check(ProposedAction(action=ActionType.STOP, source=ProposalSource.HUMAN, role=Role.VIEWER), ctx).verdict == DecisionVerdict.ALLOW


def test_nan_speed_parameters_are_rejected():
    sup = SafetySupervisor(SupervisorLimits(vib_rms_stop_g=2.0, max_rpm=3000.0))
    ctx = SupervisorContext(mode=Mode.SIMULATION, hardware_control_enabled=True, connection=Connection.CONNECTED, device_state=DeviceSafetyState.OK, telemetry_age_s=0.0,
                            sensors_valid=True, motor_running=True, current_setpoint_rpm=1800.0)
    for act in (ActionType.SET_SPEED, ActionType.REDUCE_SPEED):
        d = sup.check(ProposedAction(action=act, source=ProposalSource.HUMAN, role=Role.OPERATOR, params={"rpm": float("nan")}, human_approved=True), ctx)
        assert d.verdict == DecisionVerdict.REJECT, act


# ----------------------------------------------------------------------------------------------------- gate: untrusted / conflicted / uncorroborated evidence never authorises ACT
def _confident(**kw):
    return Posterior({Hy.IMBALANCE: 0.98, **{h: 0.004 for h in Hy if h != Hy.IMBALANCE}}, 20, **kw)


@pytest.mark.parametrize("kw,c2_trusted", [({}, False), ({"conflict": True}, True), ({"uncorroborated": True}, True), ({"ood": True}, True)])
def test_gate_never_acts_on_untrusted_conflicted_uncorroborated_or_unfamiliar_evidence(kw, c2_trusted):
    gi = GateInputs(mandatory_stop=False, risk=0.4, data_ok=True, sensor_unreliable=False, posterior=_confident(**kw), c2_trusted=c2_trusted, best_test=None,
                    data_requests=0, max_data_requests=2, tests_run=1, max_tests=2, op_point_familiar=True)
    assert decide(gi).verdict != GateVerdict.ACT


# ----------------------------------------------------------------------------------------------------- legacy hardware-facing routes
@pytest.fixture()
def legacy(monkeypatch):
    import main
    monkeypatch.delenv("TORQVA_DEVICE_KEY", raising=False)
    return main, TestClient(main.app, raise_server_exceptions=False)


def test_legacy_device_routes_require_the_device_key_when_configured(legacy, monkeypatch):
    main, c = legacy
    monkeypatch.setenv("TORQVA_DEVICE_KEY", "s3cret-device-key")
    assert c.post("/api/ingest", json={}).status_code == 401
    assert c.get("/api/device/commands").status_code == 401
    assert c.post("/api/device/command-ack", json={"command_id": "x", "status": "ACK"}).status_code == 401
    assert c.post("/api/baseline/result", json={}).status_code == 401
    assert c.post("/api/ingest", json={}, headers={"X-Device-Key": "wrong"}).status_code == 401
    r = c.get("/api/device/commands", headers={"X-Device-Key": "s3cret-device-key"})
    assert r.status_code == 200


def test_legacy_baseline_mutations_need_an_operator_when_bearer_auth_is_configured(legacy, monkeypatch):
    main, c = legacy
    monkeypatch.setattr(main, "_torqva_auth", TokenAuth(ENTRIES))
    for path in ("/api/baseline/start", "/api/baseline/cancel", "/api/baseline/reset"):
        assert c.post(path).status_code == 401
        assert c.post(path, headers=H("v")).status_code == 403
        assert c.post(path, headers=H("o")).status_code == 200
    assert c.post("/api/motor", json={"command": "ON"}).status_code == 401


def test_cors_is_not_a_wildcard_and_does_not_allow_credentials(legacy):
    main, c = legacy
    r = c.options("/api/status", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in r.headers
    ok = c.options("/api/status", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    assert "access-control-allow-credentials" not in ok.headers
