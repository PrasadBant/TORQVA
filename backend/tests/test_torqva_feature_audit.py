"""Feature audit (Oct 2026): the real API router, real SimulationService and real (port-less) device bridge, exercised over HTTP.

Covers what the older API tests did not: every route's authentication, the complete viewer/operator/admin matrix, device-command authorization,
the WebSocket handshake, commissioning validation through the API, simulation determinism and an honest non-recovery outcome.
No serial port is opened (conftest disables auto-connect for the whole session) and no command reaches any device.
"""
import hashlib
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute, APIWebSocketRoute
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.api import create_router, install_error_handlers
from torqva.auth import TokenAuth
from torqva.service import SimulationService

P = "/api/torqva"
H = lambda t: {"Authorization": f"Bearer {t}"}
ENTRIES = [{"sha256": hashlib.sha256(t.encode()).hexdigest(), "user": u, "role": r} for t, u, r in
           (("v-tok", "vera", "viewer"), ("o-tok", "olga", "operator"), ("a-tok", "adam", "admin"))]

# The intended minimum role of every HTTP route (README / backend/README.md). A new route must be added here deliberately.
ROLE = {
    ("GET", "/me"): "viewer", ("GET", "/evaluation/latest"): "viewer", ("GET", "/evaluation/c2c4"): "viewer", ("GET", "/devices"): "viewer",
    ("GET", "/status"): "viewer", ("GET", "/telemetry"): "viewer", ("GET", "/incidents"): "viewer", ("GET", "/decisions"): "viewer",
    ("GET", "/predictions"): "viewer", ("GET", "/commands"): "viewer", ("GET", "/prediction-checks"): "viewer", ("GET", "/outcomes"): "viewer",
    ("GET", "/cases"): "viewer", ("GET", "/log"): "viewer",
    ("GET", "/simulation/workbench/plan"): "viewer", ("GET", "/simulation/workbench/predict"): "viewer", ("POST", "/simulation/workbench/check"): "viewer",
    ("POST", "/simulation/workbench/sequence"): "operator", ("POST", "/simulation/workbench/request"): "operator",
    ("POST", "/simulation/start"): "operator", ("POST", "/simulation/step"): "operator", ("POST", "/approvals/approve"): "operator",
    ("POST", "/approvals/reject"): "operator", ("POST", "/commands/stop"): "viewer", ("POST", "/commands/reset-estop"): "admin",
    ("GET", "/lab/regimes"): "viewer", ("GET", "/lab/checklist"): "viewer", ("GET", "/lab/sessions"): "viewer", ("GET", "/lab/sessions/{sid}"): "viewer",
    ("POST", "/lab/sessions"): "operator", ("POST", "/lab/sessions/{sid}/checklist"): "operator", ("POST", "/lab/sessions/{sid}/run"): "operator",
    ("POST", "/lab/sessions/{sid}/reveal"): "operator", ("POST", "/lab/sessions/{sid}/reproduce"): "operator", ("GET", "/lab/experiments"): "viewer",
    ("POST", "/lab/experiments"): "operator",
    ("GET", "/attestation/candidates"): "viewer", ("GET", "/attestation/candidates/{cid}"): "viewer", ("GET", "/attestation/references"): "viewer",
    ("GET", "/attestation/events"): "viewer", ("GET", "/attestation/warmup"): "viewer", ("POST", "/attestation/warmup/start"): "operator",
    ("POST", "/attestation/warmup/end"): "operator", ("POST", "/attestation/candidates"): "operator", ("POST", "/attestation/candidates/{cid}/refresh"): "operator",
    ("POST", "/attestation/candidates/{cid}/attest"): "operator", ("POST", "/attestation/candidates/{cid}/reject"): "operator",
    ("POST", "/attestation/candidates/{cid}/revoke"): "operator", ("POST", "/attestation/references/{version}/activate"): "operator",
    ("POST", "/attestation/references/rollback"): "operator",
    ("GET", "/audit"): "admin",
    ("GET", "/device/status"): "viewer", ("GET", "/device/history"): "viewer", ("GET", "/device/ports"): "admin", ("POST", "/device/connect"): "admin",
    ("POST", "/device/disconnect"): "admin", ("POST", "/device/commands"): "viewer", ("GET", "/device/commands"): "viewer",
    ("GET", "/device/commissioning"): "viewer", ("POST", "/device/commissioning/items/{item_id}"): "admin",
    ("PUT", "/device/commissioning/limits"): "admin", ("POST", "/device/commissioning/enable"): "admin",
}
RANK = {"viewer": 0, "operator": 1, "admin": 2}
LIMITS = {"max_current_a": 2.5, "min_voltage_v": 18.0, "max_voltage_v": 24.0, "max_temp_c": 60.0, "max_rpm": 3000.0, "max_duty_pct": 30.0}


def make(service):
    app = FastAPI()
    app.include_router(create_router(service, TokenAuth(ENTRIES)))
    install_error_handlers(app)                                                                 # as main.py does
    return app, TestClient(app)


@pytest.fixture(scope="module")
def ctx():
    service = SimulationService()
    app, c = make(service)
    yield service, app, c
    if service.bridge.autoconnect is not None:
        service.bridge.autoconnect.stop()


def http_routes(app):
    out = []
    for r in app.routes:
        if isinstance(r, APIRoute):
            for m in r.methods - {"HEAD", "OPTIONS"}:
                out.append((m, r.path[len(P):]))
    return out


def call(c, method, path, token=None):
    url = P + path.replace("{sid}", "L-0000").replace("{cid}", "C-0000").replace("{version}", "1").replace("{item_id}", "estop")
    return c.request(method, url, headers=H(token) if token else {}, json=None if method == "GET" else {})


# ------------------------------------------------------------------------------------------------ isolation of the test session itself
def test_the_test_session_never_scans_or_opens_a_serial_port(ctx):
    service, _, _ = ctx
    st = service.bridge.autoconnect.status()
    assert st["scan"] is False and st["port"] is None and st["attempts"] == 0
    assert service.bridge.snapshot()["connection"] == "DISCONNECTED"


# ------------------------------------------------------------------------------------------------ authentication of every route
def test_every_http_route_is_listed_with_an_intended_role(ctx):
    _, app, _ = ctx
    routes = set(http_routes(app))
    assert routes == set(ROLE), {"unlisted": sorted(routes - set(ROLE)), "missing": sorted(set(ROLE) - routes)}


def test_every_http_route_refuses_a_missing_or_wrong_token(ctx):
    _, app, c = ctx
    for method, path in http_routes(app):
        assert call(c, method, path).status_code == 401, (method, path)
        assert call(c, method, path, "not-a-token").status_code == 401, (method, path)


def test_viewer_and_operator_are_refused_every_route_above_their_role_and_the_refusal_is_audited(ctx):
    _, app, c = ctx
    for (method, path), need in ROLE.items():
        for token, have in (("v-tok", "viewer"), ("o-tok", "operator")):
            if RANK[have] < RANK[need]:
                r = call(c, method, path, token)
                assert r.status_code == 403, (method, path, have, r.status_code)
    denied = c.get(P + "/audit", params={"kind": "denied"}, headers=H("a-tok")).json()
    assert any(d["actor"] == "olga" and d["detail"]["needed"] == "admin" for d in denied)


# ------------------------------------------------------------------------------------------------ physical commands (no device attached)
def test_only_an_admin_may_request_start_or_speed_and_every_role_may_request_stop(ctx):
    service, _, c = ctx
    for token in ("v-tok", "o-tok"):
        for body in ({"action": "START", "duty_pct": 20}, {"action": "SET_SPEED", "rpm": 900}):
            assert c.post(P + "/device/commands", json=body, headers=H(token)).status_code == 403, (token, body)
    for token in ("v-tok", "o-tok", "a-tok"):
        r = c.post(P + "/device/commands", json={"action": "STOP"}, headers=H(token))
        assert r.status_code == 200 and r.json()["state"] in ("REJECTED", "FAILED"), r.json()     # accepted as a request, refused: no device
    r = c.post(P + "/device/commands", json={"action": "START", "duty_pct": 20}, headers=H("a-tok")).json()
    assert r["state"] == "REJECTED" and r["reasons"], r                                           # authorised role, still refused by the interlocks
    assert not any(x["state"] in ("EXECUTED", "ACKNOWLEDGED", "SENT") for x in service.bridge.command_list())


def test_device_command_payloads_are_validated_and_bad_requests_are_recorded_as_rejected_never_sent(ctx):
    service, _, c = ctx
    post = lambda body: c.post(P + "/device/commands", json=body, headers=H("a-tok"))
    for body in ({}, {"action": "SET_SPEED", "rpm": "fast"}, {"action": "SET_SPEED", "rpm": -100}, {"action": "START", "duty_pct": 250}):
        assert post(body).status_code == 422, body                                                 # malformed or out of range: refused before the bridge
    nan = c.post(P + "/device/commands", content='{"action":"START","duty_pct":NaN}', headers={**H("a-tok"), "Content-Type": "application/json"})
    assert nan.status_code == 422
    unknown, no_rpm = post({"action": "SPIN"}).json(), post({"action": "SET_SPEED"}).json()        # well-formed but unusable: a recorded, rejected request
    assert unknown["state"] == "REJECTED" and unknown["reasons"] == ["UNSUPPORTED_COMMAND"]
    assert no_rpm["state"] == "REJECTED" and any("INVALID_PARAMETER" in r for r in no_rpm["reasons"])   # a missing value is never defaulted
    assert not any(x["state"] in ("EXECUTED", "ACKNOWLEDGED", "SENT") for x in service.bridge.command_list())


# ------------------------------------------------------------------------------------------------ WebSocket
def test_websocket_requires_a_valid_first_message_token_and_is_read_only(ctx):
    _, _, c = ctx
    with c.websocket_connect(P + "/ws") as ws:
        ws.send_json({"type": "auth", "token": "wrong"})
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_json()
        assert e.value.code == 4401
    with c.websocket_connect(P + "/ws") as ws:
        ws.send_json({"type": "auth", "token": "v-tok"})
        snap = ws.receive_json()
        assert snap["type"] == "snapshot" and snap["data"]["handshake"] is False and snap["data"]["origin"] == "none"
        ws.send_json({"type": "command", "action": "STOP"})                                          # commands are never accepted over the socket
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_json()
        assert e.value.code == 4400


# ------------------------------------------------------------------------------------------------ commissioning through the API
def test_commissioning_limits_need_every_value_the_confirmation_and_evidence_and_never_enable_motion(ctx):
    service, _, c = ctx
    url = P + "/device/commissioning/limits"
    phrase = c.get(P + "/device/commissioning", headers=H("v-tok")).json()["limits_confirm_phrase"]
    for missing in ("min_voltage_v", "max_voltage_v", "max_current_a"):
        body = {**{k: v for k, v in LIMITS.items() if k != missing}, "evidence": "bench datasheet review", "confirm": phrase}
        assert c.put(url, json=body, headers=H("a-tok")).status_code == 422, missing           # nothing is defaulted on the operator's behalf
    assert c.put(url, json={**LIMITS, "evidence": "bench datasheet review", "confirm": "yes"}, headers=H("a-tok")).status_code == 422
    assert c.put(url, json={**LIMITS, "min_voltage_v": 25.0, "evidence": "bench datasheet review", "confirm": phrase}, headers=H("a-tok")).status_code == 422
    assert c.put(url, json={**LIMITS, "evidence": "bench datasheet review", "confirm": phrase}, headers=H("o-tok")).status_code == 403
    ok = c.put(url, json={**LIMITS, "evidence": "bench datasheet review", "confirm": phrase}, headers=H("a-tok"))
    assert ok.status_code == 200, ok.text
    rec = ok.json()
    assert rec["limits"]["min_voltage_v"] == 18.0 and rec["limits"]["max_voltage_v"] == 24.0 and rec["limits"]["by"] == "adam"
    assert rec["physical_control_enabled"] is False                                                 # approving limits is not enabling motion
    assert "PHYSICAL CONTROL DISABLED" in service.bridge.control_blockers()


# ------------------------------------------------------------------------------------------------ simulation: determinism and honest outcomes
def _run(seed, fault, clears_below_rpm, steps=6):
    service = SimulationService()
    _, c = make(service)
    c.post(P + "/simulation/start", json={"fault": fault, "severity": 0.6, "clears_below_rpm": clears_below_rpm, "seed": seed}, headers=H("o-tok"))
    for _ in range(steps):
        c.post(P + "/simulation/step", json={"seconds": 100}, headers=H("o-tok"))
    g = lambda path: c.get(P + path, headers=H("v-tok")).json()
    return g("/incidents"), g("/decisions"), g("/outcomes"), g("/commands"), g("/telemetry")


def test_the_same_scenario_and_seed_reproduce_the_same_incident_decisions_and_outcome():
    a, b = _run(11, "imbalance", 1500), _run(11, "imbalance", 1500)
    strip = lambda recs, keys: [{k: r.get(k) for k in keys} for r in recs]
    assert strip(a[0], ("state", "history")) == strip(b[0], ("state", "history"))
    assert strip(a[1], ("verdict", "reason")) == strip(b[1], ("verdict", "reason"))
    assert strip(a[2], ("outcome", "action", "command_executed")) == strip(b[2], ("outcome", "action", "command_executed"))
    assert [s["rpm"] for s in a[4]["samples"]] == [s["rpm"] for s in b[4]["samples"]]


def test_a_fault_that_does_not_clear_is_never_reported_as_recovered():
    incidents, decisions, outcomes, commands, _ = _run(12, "imbalance", None)              # clears_below_rpm=None: slowing down does not fix it
    assert incidents, "the injected fault was not detected"
    assert not any(o["outcome"] == "RECOVERED" for o in outcomes), outcomes
    for o in outcomes:                                                                          # any verdict names its evidence
        assert o["_provenance"] == "SIMULATED"
        if o.get("command_executed") is False:
            assert o["outcome"] != "RECOVERED"


# ------------------------------------------------------------------------------------------------ C1: missing data is never a healthy score
def test_c1_never_scores_an_invalid_or_non_finite_window_as_ok(stack):
    import dataclasses
    from torqva.sim import MotorSim
    det = stack[0]
    s = MotorSim(1); s.set_setpoint(1500); w = s.run(60)[-1]
    assert det.score(w).status == "OK" and det.score(w).value is not None                        # control: a healthy, valid window is scored
    for bad in (dataclasses.replace(w, valid=False), dataclasses.replace(w, vib_rms=float("nan")), dataclasses.replace(w, current=float("inf"))):
        sc = det.score(bad)
        assert sc.value is None and sc.status == "INVALID_INPUT" and not sc.anomalous, sc
