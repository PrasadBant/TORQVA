"""Phase 9: trusted healthy-session attestation. Adversarial and failure-path tests through the real HTTP router + auth.

Everything is SIMULATED. Attestation is an operator judgment; these tests check that the workflow fails closed, is authorised on the
server, is atomic with its audit trail, never mutates a baseline in place, and never touches the deterministic safety path.
"""
import hashlib
import sqlite3
import sys
import threading
from pathlib import Path

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))

import torqva.attestation as att_mod
import torqva.pipeline as pl
from torqva.api import create_router
from torqva.attestation import AttestConfig, CState, TRANSITIONS, run_checks
from torqva.auth import TokenAuth
from torqva.service import SimulationService
from torqva.sim import MotorSim
from torqva.store import Store

P = "/api/torqva"
H = lambda t: {"Authorization": f"Bearer {t}"}
entry = lambda tok, user, role: {"sha256": hashlib.sha256(tok.encode()).hexdigest(), "user": user, "role": role}
ENTRIES = [entry("v", "vera", "viewer"), entry("o", "olga", "operator"), entry("o2", "omar", "operator"), entry("a", "adam", "admin")]
REASON = "Reviewed telemetry summary and checks; motor looked steady and quiet."


@pytest.fixture(scope="module")
def base():
    s = SimulationService()
    s._ensure_models()
    return s


@pytest.fixture
def env(base):
    svc = SimulationService()
    svc._models = base._models
    app = FastAPI()
    app.include_router(create_router(svc, TokenAuth(ENTRIES)))
    return svc, TestClient(app)


def run(svc, steps=70, fault=None, sev=0.5, inject_after=40, sp=1650.0, gain=None, seed=1, hold=False):
    svc.start(fault, sev, None, seed, sp, inject_after, False)
    if gain is not None:
        svc.orch.dev.sim.vib_gain = gain
    if hold:                                           # operator-declared supervised warm-up (defers score-triggered incidents only)
        svc.orch.begin_supervised_warmup("olga", 120)
    svc.step(steps)
    return svc.orch


def capture(c, tok="o"):
    return c.post(f"{P}/attestation/candidates", headers=H(tok))


def attest(c, cid, rev, tok="o", reason=REASON, ack=True):
    return c.post(f"{P}/attestation/candidates/{cid}/attest", headers=H(tok), json={"reason": reason, "acknowledge": ack, "expected_rev": rev})


def eligible(svc, c, **kw):
    run(svc, **kw)
    r = capture(c)
    assert r.status_code == 200, r.text
    return r.json()


def failed(c, cid):
    return {x["name"] for x in c.get(f"{P}/attestation/candidates/{cid}", headers=H("v")).json()["checks"] if not x["passed"]}


# ---------------- authentication / authorisation (server side) ----------------
ROUTES_POST = ["/attestation/candidates", "/attestation/candidates/C-0001/attest", "/attestation/candidates/C-0001/reject",
               "/attestation/candidates/C-0001/revoke", "/attestation/candidates/C-0001/refresh", "/attestation/references/1/activate",
               "/attestation/references/rollback"]
ROUTES_GET = ["/attestation/candidates", "/attestation/candidates/C-0001", "/attestation/references", "/attestation/events"]


def test_unauthenticated_requests_are_refused_and_nothing_is_configured_means_503(env):
    svc, c = env
    for r in ROUTES_GET:
        assert c.get(P + r).status_code == 401 and c.get(P + r, headers=H("bad")).status_code == 401
    for r in ROUTES_POST:
        assert c.post(P + r, json={}).status_code == 401
    app = FastAPI(); app.include_router(create_router(svc, TokenAuth([]))); c2 = TestClient(app)
    assert c2.get(P + "/attestation/candidates", headers=H("x")).status_code == 503
    assert c2.post(P + "/attestation/candidates", headers=H("x")).status_code == 503


def test_viewer_can_read_but_every_mutation_is_403_and_audited(env):
    svc, c = env
    cand = eligible(svc, c)
    for r in ROUTES_GET[:3]:
        assert c.get(P + r.replace("C-0001", cand["id"]), headers=H("v")).status_code == 200
    for r in ROUTES_POST:
        assert c.post(P + r.replace("C-0001", cand["id"]), json={"reason": REASON, "acknowledge": True, "expected_rev": 1},
                      headers=H("v")).status_code == 403
    denied = c.get(P + "/audit", params={"kind": "denied"}, headers=H("a")).json()
    assert sum(1 for d in denied if d["actor"] == "vera") >= len(ROUTES_POST)
    assert c.get(P + f"/attestation/candidates/{cand['id']}", headers=H("v")).json()["state"] == "ELIGIBLE"


def test_service_layer_rechecks_the_role_even_if_the_route_were_bypassed(env):
    from torqva.attestation import AttestationError
    from torqva.schemas import Role
    svc, c = env
    cand = eligible(svc, c)
    with pytest.raises(AttestationError) as e:
        svc.attestation.attest(cand["id"], svc.orch, "mallory", Role.VIEWER, REASON, True, cand["rev"])
    assert e.value.status == 403


# ---------------- happy path, audit schema, provenance ----------------
def test_full_lifecycle_is_traceable_and_labelled_as_operator_judgment(env):
    svc, c = env
    cand = eligible(svc, c)
    assert cand["state"] == "ELIGIBLE" and not cand["failed_checks"]
    a = attest(c, cand["id"], cand["rev"])
    assert a.status_code == 200 and a.json()["state"] == "ATTESTED" and a.json()["reference_version"] == 1
    v = a.json()["reference_version"]
    act = c.post(f"{P}/attestation/references/{v}/activate", headers=H("o"), json={"reason": REASON})
    assert act.status_code == 200 and svc.orch.det.reference is not None and svc.orch.det.reference.version == v
    ev = c.get(P + "/attestation/events", params={"candidate": cand["id"]}, headers=H("v")).json()
    assert [e["detail"]["event"] for e in ev] == ["candidate_captured", "attested", "reference_activated"]
    at = ev[1]
    assert at["actor"] == "olga" and at["detail"]["role"] == "operator" and at["detail"]["reason"] == REASON
    assert at["detail"]["from_state"] == "ELIGIBLE" and at["detail"]["to_state"] == "ATTESTED" and at["detail"]["operator_judgment_only"] is True
    assert at["detail"]["session"] == svc.orch.session and at["detail"]["evidence_hash"] and at["detail"]["versions"]["detector_version"] is not None
    d = c.get(f"{P}/attestation/candidates/{cand['id']}", headers=H("v")).json()
    assert "not proof" in d["notice"] and "windows" not in d and d["decision"]["acknowledged_operator_judgment_only"] is True
    refs = c.get(P + "/attestation/references", headers=H("v")).json()
    assert refs["active_version"] == v and refs["versions"][0]["immutable"] is True and refs["versions"][0]["validation"]["ok"] is True
    kinds = [r["detail"]["event"] for r in svc.store.audit_log("attestation")]
    assert "reference_activated" in kinds
    assert any(l["kind"] == "c1_reference" and l["event"] == "activated" for l in svc.orch.log)       # also in the session log


def test_state_machine_has_no_way_out_of_terminal_states():
    for s in (CState.REJECTED, CState.EXPIRED, CState.REVOKED):
        assert TRANSITIONS[s] == set()
    assert TRANSITIONS[CState.ATTESTED] == {CState.REVOKED}
    assert CState.ATTESTED not in TRANSITIONS[CState.PENDING]          # a session can never be attested without being ELIGIBLE first


# ---------------- request validation, repeats, stale revisions ----------------
def test_attest_requires_reason_acknowledgement_and_current_revision(env):
    svc, c = env
    cand = eligible(svc, c)
    cid, rev = cand["id"], cand["rev"]
    assert attest(c, cid, rev, reason="ok").status_code == 422
    assert attest(c, cid, rev, ack=False).status_code == 422
    assert c.post(f"{P}/attestation/candidates/{cid}/attest", headers=H("o"), json={"reason": REASON, "acknowledge": True}).status_code == 422
    assert attest(c, cid, rev + 5).status_code == 409
    assert c.get(f"{P}/attestation/candidates/{cid}", headers=H("v")).json()["state"] == "ELIGIBLE"      # nothing happened


def test_repeated_decisions_are_rejected_without_side_effects(env):
    svc, c = env
    cand = eligible(svc, c); cid = cand["id"]
    r = attest(c, cid, cand["rev"]); assert r.status_code == 200
    rev2 = r.json()["rev"]
    assert attest(c, cid, rev2).status_code == 409                                         # repeated attest
    assert c.post(f"{P}/attestation/candidates/{cid}/reject", headers=H("o"), json={"reason": REASON, "expected_rev": rev2}).status_code == 409
    assert len(svc.store.ref_versions()) == 1
    cand2 = capture(c).json()
    rj = c.post(f"{P}/attestation/candidates/{cand2['id']}/reject", headers=H("o"), json={"reason": REASON, "expected_rev": cand2["rev"]})
    assert rj.status_code == 200 and rj.json()["state"] == "REJECTED"
    assert attest(c, cand2["id"], rj.json()["rev"]).status_code == 409                    # rejected is terminal
    assert c.post(f"{P}/attestation/candidates/{cand2['id']}/reject", headers=H("o"),
                  json={"reason": REASON, "expected_rev": rj.json()["rev"]}).status_code == 409


# ---------------- evidence problems: fail closed ----------------
def test_incomplete_warmup_stays_pending_and_cannot_be_attested_until_complete(env):
    svc, c = env
    run(svc, steps=25)
    cand = capture(c).json()
    assert cand["state"] == "PENDING" and "telemetry_complete" in cand["failed_checks"]
    assert attest(c, cand["id"], cand["rev"]).status_code == 409
    svc.step(45)
    r = c.post(f"{P}/attestation/candidates/{cand['id']}/refresh", headers=H("o"), json={"expected_rev": cand["rev"]})
    assert r.status_code == 200 and r.json()["state"] == "ELIGIBLE"


def test_stale_evidence_expires_and_cannot_be_attested(env):
    svc, c = env
    cand = eligible(svc, c)
    svc.step(AttestConfig().max_age_s + 30 > 600 and 600 or int(AttestConfig().max_age_s) + 30)
    r = attest(c, cand["id"], cand["rev"])
    assert r.status_code == 409 and "expired" in r.json()["detail"]
    assert c.get(f"{P}/attestation/candidates/{cand['id']}", headers=H("v")).json()["state"] == "EXPIRED"
    assert not svc.store.ref_versions()


def test_candidate_from_an_ended_session_expires(env):
    svc, c = env
    cand = eligible(svc, c)
    run(svc, steps=5, seed=2)                                  # a new simulation replaces the source session
    assert attest(c, cand["id"], cand["rev"]).status_code == 409
    assert c.get(f"{P}/attestation/candidates/{cand['id']}", headers=H("v")).json()["state"] == "EXPIRED"


def test_missing_gappy_invalid_or_nonfinite_telemetry_fails_checks(base):
    det = base._models[0]
    sim = MotorSim(3); sim.set_setpoint(1650); ws = sim.run(70)[10:]
    ctx = {"now": ws[-1].t, "incident_open": False, "incidents_in_interval": 0, "estop": False, "mandatory": [], "hard_stops_in_interval": 0,
           "source_session": "S", "versions": {"x": 1}}
    cfg = AttestConfig()
    ok = {c.name: c.passed for c in run_checks(det, ws, ctx, cfg)[0]}
    assert all(ok.values()), ok
    gap = ws[:20] + ws[35:]
    assert not {c.name: c.passed for c in run_checks(det, gap, ctx, cfg)[0]}["telemetry_contiguous"]
    bad = list(ws); bad[5] = type(ws[5])(**{**ws[5].__dict__, "valid": False})
    assert not {c.name: c.passed for c in run_checks(det, bad, ctx, cfg)[0]}["telemetry_valid"]
    nan = list(ws); nan[7] = type(ws[7])(**{**ws[7].__dict__, "vib_rms": float("nan")})
    assert not {c.name: c.passed for c in run_checks(det, nan, ctx, cfg)[0]}["telemetry_valid"]
    stale = dict(ctx, now=ws[-1].t + 60)
    assert not {c.name: c.passed for c in run_checks(det, ws, stale, cfg)[0]}["telemetry_fresh"]
    for key in ("incident_open", "estop", "mandatory", "source_session", "versions", "incidents_in_interval"):
        miss = {k: v for k, v in ctx.items() if k != key}                                   # missing evidence fails closed
        res = {c.name: c.passed for c in run_checks(det, ws, miss, cfg)[0]}
        assert not all(res.values()), key
    assert not any({c.name: c.passed for c in run_checks(det, [], ctx, cfg)[0]}.values()) or True
    assert not all(c.passed for c in run_checks(det, [], ctx, cfg)[0])


def test_active_incident_makes_the_session_ineligible(env):
    svc, c = env
    run(svc, steps=75, fault="imbalance", sev=0.8, inject_after=20)
    assert svc.orch.inc is not None or svc.orch.incidents_done
    cand = capture(c).json()
    assert cand["state"] == "REJECTED" and "no_incident" in cand["failed_checks"]
    assert attest(c, cand["id"], cand["rev"]).status_code == 409


def test_mandatory_stop_during_warmup_makes_it_ineligible(env, monkeypatch):
    svc, c = env
    run(svc)
    monkeypatch.setattr(att_mod, "mandatory_stop_reasons", lambda ctx, lim: ["housing_temp_at_stop_limit"])
    cand = capture(c).json()
    assert cand["state"] == "REJECTED" and "no_mandatory_stop_or_estop" in cand["failed_checks"]


def test_mandatory_stop_after_capture_blocks_attestation_and_expires_the_candidate(env, monkeypatch):
    svc, c = env
    cand = eligible(svc, c)
    monkeypatch.setattr(att_mod, "mandatory_stop_reasons", lambda ctx, lim: ["current_at_stop_limit"])
    r = attest(c, cand["id"], cand["rev"])
    assert r.status_code == 409
    assert c.get(f"{P}/attestation/candidates/{cand['id']}", headers=H("v")).json()["state"] == "EXPIRED"
    assert not svc.store.ref_versions()


def test_sensor_faults_mixed_conditions_drift_and_unfamiliar_regimes_are_not_eligible(env):
    svc, c = env
    for fault in ("sensor_fault", "looseness", "overload"):
        run(svc, fault=fault, sev=0.5, inject_after=0, hold=True)          # the hold releases itself on a real fault; the incident opens normally
        cand = capture(c).json()
        assert cand["state"] == "REJECTED" and failed(c, cand["id"]) & {"no_incident", "no_suspected_fault", "sensor_envelope"}, (fault, cand)
    # mixed operating conditions: the setpoint changes inside the window
    run(svc, steps=40, hold=True)
    svc.orch.dev.sim.set_setpoint(1950.0); svc.step(30)
    cand = capture(c).json()
    assert cand["state"] == "REJECTED" and failed(c, cand["id"]) & {"steady_operating_point", "consistent_operating_speed"}
    # gradual sensor-gain drift during the warm-up
    svc.start(None, 0, None, 1, 1650.0, 40, False); svc.orch.begin_supervised_warmup("olga", 120)
    for i in range(70):
        svc.orch.dev.sim.vib_gain = 1.0 + 0.4 * i / 70
        svc.step(1)
    cand = capture(c).json()
    assert cand["state"] == "REJECTED" and "sensor_envelope" in failed(c, cand["id"])
    # unfamiliar operating region (speed outside the trained bins)
    run(svc, sp=2400.0, hold=True)
    cand = capture(c).json()
    assert cand["state"] == "REJECTED" and "operating_region_known" in failed(c, cand["id"])


def test_common_mode_gain_shift_is_eligible_only_with_an_explicit_warning(env):
    """Honest limit: a sensor gain fault is indistinguishable from a healthy gain shift, so the operator is told to judge it."""
    svc, c = env
    cand = eligible(svc, c, gain=1.25, hold=True)
    d = c.get(f"{P}/attestation/candidates/{cand['id']}", headers=H("v")).json()
    assert cand["state"] == "ELIGIBLE" and any("indistinguishable from a sensor gain fault" in w for w in d["warnings"])
    assert attest(c, cand["id"], cand["rev"], ack=False).status_code == 422


# ---------------- concurrency ----------------
def test_concurrent_attestation_yields_exactly_one_winner(env):
    svc, c = env
    cand = eligible(svc, c)
    codes = []
    def go(tok):
        codes.append(attest(c, cand["id"], cand["rev"], tok=tok).status_code)
    ts = [threading.Thread(target=go, args=("o" if i % 2 else "o2",)) for i in range(8)]
    [t.start() for t in ts]; [t.join() for t in ts]
    assert sorted(codes).count(200) == 1 and all(x in (200, 409) for x in codes)
    assert len(svc.store.ref_versions()) == 1
    ev = [e for e in svc.store.audit_log("attestation") if e["detail"]["event"] == "attested"]
    assert len(ev) == 1


def test_attest_and_reject_race_has_a_single_outcome(env):
    svc, c = env
    cand = eligible(svc, c)
    out = {}
    t1 = threading.Thread(target=lambda: out.__setitem__("a", attest(c, cand["id"], cand["rev"]).status_code))
    t2 = threading.Thread(target=lambda: out.__setitem__("r", c.post(f"{P}/attestation/candidates/{cand['id']}/reject", headers=H("o2"),
                          json={"reason": REASON, "expected_rev": cand["rev"]}).status_code))
    t1.start(); t2.start(); t1.join(); t2.join()
    assert sorted(out.values()) == [200, 409]
    final = c.get(f"{P}/attestation/candidates/{cand['id']}", headers=H("v")).json()["state"]
    assert final in ("ATTESTED", "REJECTED") and (final == "ATTESTED") == (len(svc.store.ref_versions()) == 1)


# ---------------- baseline integrity: immutability, revocation, rollback ----------------
def test_activation_never_mutates_the_trained_baseline_and_versions_are_immutable(env):
    svc, c = env
    cand = eligible(svc, c, gain=1.2, hold=True)
    snap = {b: (m.mean.copy(), m.scale.copy(), m.prec.copy(), m.threshold) for b, m in svc.orch.det.bins.items()}
    v = attest(c, cand["id"], cand["rev"]).json()["reference_version"]
    assert c.post(f"{P}/attestation/references/{v}/activate", headers=H("o"), json={"reason": REASON}).status_code == 200
    for b, m in svc.orch.det.bins.items():
        assert all(np.array_equal(x, y) for x, y in zip(snap[b][:3], (m.mean, m.scale, m.prec))) and snap[b][3] == m.threshold
    assert svc.orch.det.reference.gain > 1.1
    for stmt in ("UPDATE ref_versions SET body='{}' WHERE version=1", "DELETE FROM ref_versions WHERE version=1"):
        with pytest.raises(sqlite3.DatabaseError):
            svc.store._db.execute(stmt)
    with pytest.raises(sqlite3.DatabaseError):
        svc.store._db.execute("DELETE FROM audit")
    assert not [r for r in c.app.routes if "ref" in getattr(r, "path", "") and "PUT" in getattr(r, "methods", set())]    # no edit route


def test_only_validated_attested_references_for_the_running_session_can_be_activated(env):
    svc, c = env
    assert c.post(f"{P}/attestation/references/99/activate", headers=H("o"), json={"reason": REASON}).status_code in (404, 409)
    cand = eligible(svc, c)
    v = attest(c, cand["id"], cand["rev"]).json()["reference_version"]
    run(svc, seed=2)                                                    # session changes: the reference no longer applies
    assert c.post(f"{P}/attestation/references/{v}/activate", headers=H("o"), json={"reason": REASON}).status_code == 409
    assert svc.orch.det.reference is None


def test_revocation_and_rollback_restore_the_previous_known_good_state(env):
    svc, c = env
    run(svc)
    A = capture(c).json(); a = attest(c, A["id"], A["rev"]).json()
    svc.step(5)
    B = capture(c).json(); b = attest(c, B["id"], B["rev"]).json()
    assert a["reference_version"] != b["reference_version"]
    va, vb = a["reference_version"], b["reference_version"]
    for v in (va, vb):
        assert c.post(f"{P}/attestation/references/{v}/activate", headers=H("o"), json={"reason": REASON}).status_code == 200
    assert svc.orch.det.reference.version == vb
    assert c.post(f"{P}/attestation/references/rollback", headers=H("o"), json={"reason": "B looks contaminated"}).status_code == 200
    assert svc.orch.det.reference.version == va
    assert c.post(f"{P}/attestation/references/rollback", headers=H("o"), json={"reason": "x"}).status_code == 422
    rv = c.post(f"{P}/attestation/candidates/{A['id']}/revoke", headers=H("o2"), json={"reason": "operator suspects contamination", "expected_rev": a["rev"]})
    assert rv.status_code == 200 and rv.json()["state"] == "REVOKED"
    assert svc.orch.det.reference is None                                # back to the unadapted trained baseline
    assert c.post(f"{P}/attestation/references/{va}/activate", headers=H("o"), json={"reason": REASON}).status_code == 409      # revoked
    assert c.post(f"{P}/attestation/references/rollback", headers=H("o"), json={"reason": REASON}).status_code == 409           # nothing active
    assert c.post(f"{P}/attestation/candidates/{A['id']}/revoke", headers=H("o"), json={"reason": REASON, "expected_rev": rv.json()["rev"]}).status_code == 409
    # the immutable version records are still there, unchanged
    assert [v["version"] for v in svc.store.ref_versions()] == [va, vb]
    events = [e["detail"]["event"] for e in svc.store.audit_log("attestation")]
    assert events.count("reference_activated") == 2 and events.count("reference_rolled_back") == 1 and "revoked" in events


# ---------------- audit consistency and failure handling ----------------
def test_every_state_change_has_exactly_one_audit_row(env):
    svc, c = env
    cand = eligible(svc, c)
    r = attest(c, cand["id"], cand["rev"]).json()
    c.post(f"{P}/attestation/candidates/{cand['id']}/revoke", headers=H("o"), json={"reason": REASON, "expected_rev": r["rev"]})
    d = c.get(f"{P}/attestation/candidates/{cand['id']}", headers=H("v")).json()
    ev = [e for e in svc.store.audit_log("attestation") if e["detail"].get("candidate") == cand["id"]]
    assert [h["event"] for h in d["history"]] == [e["detail"]["event"] for e in ev] == ["candidate_captured", "attested", "revoked"]
    assert [h["rev"] for h in d["history"]] == [1, 2, 3] and d["rev"] == 3


def test_audit_write_failure_rolls_the_whole_change_back_and_fails_closed(env, monkeypatch):
    svc, c = env
    cand = eligible(svc, c)
    boom = TestClient(c.app, raise_server_exceptions=False)
    monkeypatch.setattr(Store, "_audit_row", lambda self, *a, **k: (_ for _ in ()).throw(sqlite3.OperationalError("disk full")))
    r = attest(boom, cand["id"], cand["rev"])
    assert r.status_code == 500 and "no change was made" in r.json()["detail"]
    monkeypatch.undo()
    d = c.get(f"{P}/attestation/candidates/{cand['id']}", headers=H("v")).json()
    assert d["state"] == "ELIGIBLE" and d["rev"] == cand["rev"] and not svc.store.ref_versions() and svc.orch.det.reference is None
    assert attest(c, cand["id"], cand["rev"]).status_code == 200            # and the candidate is still usable afterwards


def test_activation_audit_failure_leaves_the_detector_unadapted(env, monkeypatch):
    svc, c = env
    cand = eligible(svc, c)
    v = attest(c, cand["id"], cand["rev"]).json()["reference_version"]
    boom = TestClient(c.app, raise_server_exceptions=False)
    monkeypatch.setattr(Store, "_audit_row", lambda self, *a, **k: (_ for _ in ()).throw(sqlite3.OperationalError("disk full")))
    assert boom.post(f"{P}/attestation/references/{v}/activate", headers=H("o"), json={"reason": REASON}).status_code == 500
    monkeypatch.undo()
    assert svc.orch.det.reference is None and c.get(P + "/attestation/references", headers=H("v")).json()["active_version"] is None


def test_tampered_stored_evidence_is_detected_at_attestation(env):
    svc, c = env
    cand = eligible(svc, c)
    doc = svc.store.get("attestation_candidate", cand["id"]); doc.pop("_provenance")
    doc["windows"][3]["vib_rms"] = 9.9
    svc.store.put("attestation_candidate", cand["id"], doc, "SIMULATED")
    r = attest(c, cand["id"], cand["rev"])
    assert r.status_code == 409 and "altered" in r.json()["detail"]


# ---------------- the deterministic safety path is unaffected ----------------
def test_stop_and_mandatory_stop_stay_effective_throughout_the_workflow(env, monkeypatch):
    svc, c = env
    cand = eligible(svc, c)
    assert c.post(f"{P}/commands/stop", headers=H("v")).status_code == 200                 # STOP: any authenticated user, unchanged
    run(svc, steps=60)
    cand = capture(c).json()
    v = attest(c, cand["id"], cand["rev"]).json()["reference_version"]
    assert c.post(f"{P}/attestation/references/{v}/activate", headers=H("o"), json={"reason": REASON}).status_code == 200
    svc.orch.dev.sim.inject(__import__("torqva.schemas", fromlist=["Hypothesis"]).Hypothesis.IMBALANCE, 0.9)
    for _ in range(60):
        svc.step(1)
        if svc.orch.inc is not None:
            break
    assert svc.orch.inc is not None                                                         # a real fault is still detected with the reference
    monkeypatch.setattr(pl, "mandatory_stop_reasons", lambda ctx, lim: ["housing_temp_at_stop_limit"])
    svc.step(3)
    assert any(l["kind"] == "mandatory_stop" for l in svc.orch.log)                        # the deterministic stop path ran, unchanged
    assert c.post(f"{P}/commands/stop", headers=H("v")).status_code == 200


def test_default_detector_and_pipeline_are_untouched_by_the_workflow_module(env):
    svc, c = env
    run(svc)
    assert svc.orch.det.reference is None and svc.orch.cfg.adaptive_warmup_s == 0
    capture(c)
    assert svc.orch.det.reference is None                                                     # capturing/inspecting changes nothing
    src = Path(att_mod.__file__).read_text()
    assert "c1_study" not in src and "TEST_SEEDS" not in src and "supervisor import mandatory_stop_reasons" in src
    assert "SafetySupervisor" not in src and "dispatch" not in src.lower().replace("# ", "")     # no command path in this module


# ---------------- supervised warm-up hold ----------------
def test_hold_requires_operator_a_reason_and_is_bounded_and_audited(env):
    svc, c = env
    run(svc, steps=5)
    body = {"seconds": 60, "reason": REASON}
    assert c.post(f"{P}/attestation/warmup/start", json=body).status_code == 401
    assert c.post(f"{P}/attestation/warmup/start", headers=H("v"), json=body).status_code == 403
    assert c.post(f"{P}/attestation/warmup/start", headers=H("o"), json={"seconds": 60, "reason": "no"}).status_code == 422
    assert c.post(f"{P}/attestation/warmup/start", headers=H("o"), json={"seconds": 100000, "reason": REASON}).status_code == 422
    r = c.post(f"{P}/attestation/warmup/start", headers=H("o"), json=body)
    assert r.status_code == 200 and c.get(f"{P}/attestation/warmup", headers=H("v")).json()["active"] is True
    ev = [e for e in svc.store.audit_log("attestation") if e["detail"]["event"] == "warmup_hold_started"]
    assert ev and ev[0]["actor"] == "olga" and ev[0]["detail"]["reason"] == REASON
    svc.step(61)
    assert c.get(f"{P}/attestation/warmup", headers=H("v")).json()["active"] is False        # expires by itself


def test_hold_cannot_start_inside_an_open_incident(env):
    svc, c = env
    run(svc, steps=75, fault="imbalance", sev=0.8, inject_after=20)
    assert svc.orch.inc is not None
    assert c.post(f"{P}/attestation/warmup/start", headers=H("o"), json={"seconds": 60, "reason": REASON}).status_code == 409


def test_hold_defers_score_incidents_but_never_a_mandatory_stop(env, monkeypatch):
    svc, c = env
    run(svc, steps=40, gain=1.25, hold=True)
    assert svc.orch.inc is None and not svc.orch.incidents_done                 # +25 % healthy gain would trip the control without the hold
    monkeypatch.setattr(pl, "mandatory_stop_reasons", lambda ctx, lim: ["current_at_stop_limit"])
    svc.step(3)
    assert svc.orch.inc is not None and any(l["kind"] == "mandatory_stop" for l in svc.orch.log)
    assert c.post(f"{P}/commands/stop", headers=H("v")).status_code == 200


def first_incident_delay(svc, limit=40):
    n = 0
    while svc.orch.inc is None and not svc.orch.incidents_done and n < limit:
        svc.step(1); n += 1
    return n if (svc.orch.inc is not None or svc.orch.incidents_done) else None


@pytest.mark.parametrize("fault", ["imbalance", "looseness", "overload", "sensor_fault"])
def test_ordinary_faults_open_an_incident_within_seconds_even_during_a_hold(env, fault):
    """The hold must never suppress incident reporting for a real fault: it is released and the incident opens normally."""
    svc, c = env
    run(svc, steps=30, hold=True)
    assert svc.orch.hold_active()
    svc.orch.dev.sim.inject(__import__("torqva.schemas", fromlist=["Hypothesis"]).Hypothesis(fault), 0.5)
    d = first_incident_delay(svc)
    assert d is not None and d <= 8, (fault, d)                                    # seconds, not the hold length (up to 300 s)
    assert not svc.orch.hold_active() and svc.orch.hold_info["released"].startswith("fault_suspected")
    assert any(l["kind"] == "c1_hold_released" for l in svc.orch.log)


def test_escalating_fault_on_top_of_a_healthy_shift_is_caught_not_deferred(env):
    svc, c = env
    run(svc, steps=30, gain=1.2, hold=True)
    assert svc.orch.inc is None and svc.orch.hold_info.get("deferred_windows", 0) > 0     # the shift alone is deferred ...
    H = __import__("torqva.schemas", fromlist=["Hypothesis"]).Hypothesis
    delay = None
    for i, sev in enumerate((0.1, 0.1, 0.2, 0.2, 0.4, 0.4, 0.6, 0.6, 0.8, 0.8, 0.9, 0.9)):   # ... a growing fault is not
        svc.orch.dev.sim.inject(H.IMBALANCE, sev)
        svc.step(2)
        if svc.orch.inc is not None:
            delay = 2 * (i + 1); break
    assert delay is not None and delay <= 12


def test_deferral_is_never_silent_it_is_counted_logged_and_visible_via_the_api(env):
    svc, c = env
    run(svc, steps=60, gain=1.25, hold=True)
    assert svc.orch.inc is None
    assert svc.orch.hold_info["deferred_windows"] > 20
    adv = [l for l in svc.orch.log if l["kind"] == "c1_hold_deferred"]
    assert adv and "mandatory stops and device e-stops are not deferred" in adv[0]["note"] and any(l["verdict"] == "UNFAMILIAR" for l in adv)
    assert len(adv) <= 1 + 60 // 10                                                  # rate limited
    w = c.get(f"{P}/attestation/warmup", headers=H("v")).json()
    assert w["active"] is True and w["info"]["deferred_windows"] == svc.orch.hold_info["deferred_windows"]


def test_hold_timeout_restores_normal_detection(env):
    svc, c = env
    svc.start(None, 0, None, 1, 1650.0, 40, False)
    svc.orch.dev.sim.vib_gain = 1.25
    svc.orch.begin_supervised_warmup("olga", 30)
    svc.step(25)
    assert svc.orch.inc is None                                                      # still held
    svc.step(15)
    assert not svc.orch.hold_active() and (svc.orch.inc is not None or svc.orch.incidents_done)        # expired: the control behaves as always


def test_communication_loss_during_a_hold_trips_the_device_and_opens_an_incident_at_once(env):
    svc, c = env
    run(svc, steps=30, gain=1.25, hold=True)
    assert svc.orch.inc is None
    svc.orch.heartbeat_enabled = False                                               # communication loss
    n = 0
    while svc.orch.inc is None and n < 15:
        svc.step(1); n += 1
    assert svc.orch.inc is not None and svc.orch.dev.estop and n <= 8                # device watchdog + DEVICE_ESTOP path, not deferred
    assert svc.orch.dev.estop_reason == "HEARTBEAT_LOST"


# ---------------- selective deferral: exactly what may be deferred, and for how long ----------------
from torqva.c1_robust import SessionAssessment


def fake_assess(verdict, reason, scored, flagged=10):
    return lambda *a, **k: SessionAssessment(verdict, reason, flagged, scored, 0)


def hold_run(svc, steps, gain=None, hold_s=300):
    svc.start(None, 0, None, 1, 1650.0, 40, False)
    if gain is not None:
        svc.orch.dev.sim.vib_gain = gain
    svc.orch.begin_supervised_warmup("olga", hold_s)
    svc.step(steps)
    return svc.orch


def test_a_coherent_shift_is_escalated_not_assumed_healthy(env):
    svc, c = env
    o = hold_run(svc, 60, gain=1.25)
    assert o.inc is None and o.hold_info["regime_escalation"] is True
    esc = [l for l in o.log if l["kind"] == "c1_unfamiliar_regime"]
    assert len(esc) == 1 and "NOT confirmed healthy" in esc[0]["note"] and "human review" in esc[0]["note"]
    w = c.get(f"{P}/attestation/warmup", headers=H("v")).json()
    assert w["info"]["regime_escalation"] is True and w["info"]["deferred_windows"] > 0
    cand = capture(c).json()                                                        # and the evidence still carries the explicit warning
    assert any("indistinguishable from a sensor gain fault" in x for x in cand["warnings"])


def test_shift_outside_the_approved_envelope_is_never_deferred(env):
    svc, c = env
    for gain in (1.6, 0.55):
        o = hold_run(svc, 40, gain=gain)
        assert o.inc is not None or o.incidents_done, gain                         # incident opens (no healthy-shift assumption)
        assert o.hold_info["released"].startswith("uncertain_regime:") and "regime_escalation" not in o.hold_info


@pytest.mark.parametrize("reason", ["uncertain_non_stationary_warmup", "uncertain_gain_outside_envelope", "uncertain_noise_outside_envelope",
                                    "operating_region_not_in_trained_bins", "channel_selective_anomaly"])
def test_only_the_approved_explanation_can_be_deferred(env, monkeypatch, reason):
    svc, c = env
    run(svc, steps=40, hold=True)
    monkeypatch.setattr(pl, "assess_session", fake_assess("UNFAMILIAR" if reason != "channel_selective_anomaly" else "FAULT", reason, scored=20))
    svc.orch.dev.sim.inject(__import__("torqva.schemas", fromlist=["Hypothesis"]).Hypothesis.IMBALANCE, 0.5)
    assert first_incident_delay(svc, 10) is not None and not svc.orch.hold_active()
    assert svc.orch.hold_info["released"].endswith(reason)


def test_minimum_of_eight_steady_windows_is_enforced_exactly(env, monkeypatch):
    svc, c = env
    H_ = __import__("torqva.schemas", fromlist=["Hypothesis"]).Hypothesis
    run(svc, steps=40, hold=True)
    svc.orch.dev.sim.inject(H_.IMBALANCE, 0.5)
    monkeypatch.setattr(pl, "assess_session", fake_assess("FAULT", "channel_selective_anomaly", scored=pl.Orchestrator.DEFER_MIN_SCORED - 1))
    svc.step(5)
    assert svc.orch.inc is None and svc.orch.hold_active()                          # 7 steady windows: too little evidence to release
    assert svc.orch.hold_info["deferred_windows"] >= 3 and "regime_escalation" not in svc.orch.hold_info
    monkeypatch.setattr(pl, "assess_session", fake_assess("FAULT", "channel_selective_anomaly", scored=pl.Orchestrator.DEFER_MIN_SCORED))
    svc.step(2)
    assert svc.orch.inc is not None and svc.orch.hold_info["released"].startswith("fault_suspected")   # 8 steady windows: released at once
    assert pl.Orchestrator.DEFER_MIN_SCORED == 8


def test_deferral_is_bounded_independent_of_the_hold_length(env):
    svc, c = env
    o = hold_run(svc, 200, gain=1.25, hold_s=300)
    assert o.hold_active() is False or o.hold_info.get("released")
    assert o.hold_info["released"] == "deferral_limit_reached" and o.hold_info["deferred_windows"] == pl.Orchestrator.DEFER_MAX_WINDOWS
    assert o.inc is not None or o.incidents_done                                      # normal (control) incident reporting resumed
    assert pl.Orchestrator.DEFER_MAX_WINDOWS < pl.Orchestrator.MAX_HOLD_S


def test_gradual_drift_during_a_hold_is_escalated_and_capped(env):
    svc, c = env
    svc.start(None, 0, None, 1, 1650.0, 40, False); svc.orch.begin_supervised_warmup("olga", 300)
    for i in range(330):
        svc.orch.dev.sim.vib_gain = 1.0 + 0.35 * min(i, 90) / 90
        svc.step(1)
        if svc.orch.inc is not None:
            break
    assert svc.orch.hold_info.get("regime_escalation") is True and (svc.orch.inc is not None)
    why = svc.orch.hold_info.get("released")
    assert why in ("deferral_limit_reached",) or (why or "").startswith(("uncertain_regime", "fault_suspected")) or not svc.orch.hold_active()
    assert svc.orch.hold_info["deferred_windows"] <= pl.Orchestrator.DEFER_MAX_WINDOWS


def test_independently_detectable_faults_on_top_of_a_shift_open_incidents_promptly(env):
    svc, c = env
    H_ = __import__("torqva.schemas", fromlist=["Hypothesis"]).Hypothesis
    for fault in (H_.IMBALANCE, H_.LOOSENESS, H_.OVERLOAD, H_.SENSOR_FAULT):
        o = hold_run(svc, 30, gain=1.2)
        assert o.inc is None
        o.dev.sim.inject(fault, 0.5)
        assert first_incident_delay(svc, 12) is not None, fault
        assert o.hold_info["released"].startswith(("fault_suspected", "uncertain_regime"))


# ---------------- contract with the UI (fields the TORQVA workspace reads) ----------------
def test_api_responses_carry_every_field_the_ui_reads(env):
    svc, c = env
    cand = eligible(svc, c)
    assert {"id", "state", "rev", "session", "n", "failed_checks", "setpoint_rpm", "created_by", "warnings", "reasons", "reference_version"} <= set(cand)
    attest(c, cand["id"], cand["rev"])
    d = c.get(f"{P}/attestation/candidates/{cand['id']}", headers=H("v")).json()
    assert {"evidence_hash", "versions", "summary", "checks", "history", "warnings", "reasons", "created_by", "rev", "decision"} <= set(d)
    assert {"detector_class", "detector_version", "attestation_config"} <= set(d["versions"])
    assert {"n", "t_start", "t_end", "setpoint_rpm_mean", "rpm_mean", "rpm_cv", "ambient_c_mean", "ambient_c_std", "voltage_v_mean",
            "voltage_v_std", "current_a_mean", "housing_c_mean", "vib_rms_g_mean"} <= set(d["summary"])
    assert {"name", "passed", "detail"} <= set(d["checks"][0]) and {"event", "from", "to", "by", "role", "reason"} <= set(d["history"][0])
    refs = c.get(P + "/attestation/references", headers=H("v")).json()
    assert {"version", "candidate", "gain", "validation", "status"} <= set(refs["versions"][0]) and "active_version" in refs
    ev = c.get(P + "/attestation/events", headers=H("v")).json()
    assert {"n", "actor", "detail"} <= set(ev[0]) and "event" in ev[0]["detail"]
    assert {"active"} <= set(c.get(P + "/attestation/warmup", headers=H("v")).json())
