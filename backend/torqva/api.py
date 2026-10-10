"""TORQVA HTTP API. Mounted under /api/torqva. Every route requires a bearer token (fail closed).

Roles: viewer = read; operator = approve/reject/stop/run simulation; admin = audit log, reset, learning.
Every privileged action is written to the append-only audit log with the authenticated user.
HTTP 200 on a command route means "accepted for dispatch", never "the motor did it": clients must read the
command's device acknowledgement (GET /commands) and post-action measurements.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field

from .attestation import AttestationError
from .auth import Principal, TokenAuth
from .schemas import ActionType, ProposalSource, ProposedAction, Role
from .service import SimulationService


class StartSimulation(BaseModel):
    fault: Optional[str] = Field(default=None, description="imbalance|looseness|overload|cooling_failure|supply_voltage|sensor_fault")
    severity: float = Field(default=0.5, ge=0.0, le=1.0)
    clears_below_rpm: Optional[float] = Field(default=None, ge=0)
    seed: int = 1
    setpoint_rpm: float = Field(default=1800.0, gt=0, le=3000)
    inject_after_s: int = Field(default=40, ge=0, le=3600)
    require_human_approval: bool = False


class ProfileStep(BaseModel):
    rpm: float = Field(gt=0, le=3000)
    hold_s: float = Field(ge=5, le=900)


class LabSessionIn(BaseModel):
    purpose: str = "fault_run"
    notes: str = ""
    blind: bool = False
    regime: str = "baseline"
    seed: int = 1
    profile: List[ProfileStep] = Field(default_factory=lambda: [ProfileStep(rpm=1500, hold_s=90)])
    fault: Optional[str] = None
    severity: float = Field(default=0.5, ge=0.0, le=1.0)
    inject_at_s: int = Field(default=30, ge=0, le=1800)
    clears_below_rpm: Optional[float] = Field(default=None, ge=0)
    settings: Dict[str, Any] = Field(default_factory=dict, description="Physical injection record: mass g, radius mm, shim, ...")


class ChecklistIn(BaseModel):
    items: Dict[str, bool]


class ExperimentIn(BaseModel):
    fault: str
    severity: float = Field(default=0.6, gt=0, le=1)
    speed_rpm: float = Field(default=1800, gt=0, le=3000)
    regime: str = "baseline"
    repeats: int = Field(default=3, ge=1, le=10)
    seed0: int = 100


class DecideIn(BaseModel):
    reason: str = Field(default="", max_length=2000)
    expected_rev: Optional[int] = None
    acknowledge: bool = False


class HoldIn(BaseModel):
    seconds: float = Field(default=90.0, gt=0, le=300)
    reason: str = Field(default="", max_length=2000)


class ReasonIn(BaseModel):
    reason: str = Field(default="", max_length=2000)


class StepRequest(BaseModel):
    seconds: int = Field(default=1, ge=1, le=600)


def create_router(service: SimulationService, auth: TokenAuth) -> APIRouter:
    r = APIRouter(prefix="/api/torqva", tags=["torqva"])

    def principal(authorization: Optional[str] = Header(default=None)) -> Principal:
        if not auth.configured:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "authentication is not configured; TORQVA API is disabled")
        token = authorization[7:].strip() if authorization and authorization.lower().startswith("bearer ") else None
        p = auth.authenticate(token)
        if p is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or missing bearer token",
                                headers={"WWW-Authenticate": "Bearer"})
        return p

    def need(role: Role):
        def dep(p: Principal = Depends(principal)) -> Principal:
            if not p.at_least(role):
                service.store.audit("denied", p.user, {"needed": role.value, "had": p.role.value})
                raise HTTPException(status.HTTP_403_FORBIDDEN, f"requires role {role.value}")
            return p
        return dep

    def audit(p: Principal, kind: str, **detail):
        service.store.audit(kind, p.user, {"role": p.role.value, **detail})

    # ---------------- reads (viewer) ----------------
    @r.get("/me")
    def me(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        return {"user": p.user, "role": p.role.value}

    @r.get("/evaluation/latest")
    def evaluation_latest(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        """Newest EvaluationRun JSON from docs/eval (read-only artifact). SIMULATED unless it says otherwise."""
        import json
        from pathlib import Path
        d = Path(__file__).resolve().parents[2] / "docs" / "eval"
        files = sorted(d.glob("*.json"), key=lambda f: f.stat().st_mtime) if d.exists() else []
        if not files:
            raise HTTPException(404, "no evaluation run found")
        return {"file": files[-1].name, "run": json.loads(files[-1].read_text())}

    @r.get("/status")
    def get_status(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        return service.state()

    @r.get("/telemetry")
    def get_telemetry(last: int = 300, p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        return {"provenance": "SIMULATED", "samples": service.telemetry(max(1, min(last, 2000)))}

    def _list(kind: str) -> List[Dict[str, Any]]:
        """Records of the CURRENT simulation session only (ids restart per run)."""
        return service.orch.records(kind) if service.orch else []

    @r.get("/incidents")
    def incidents(p: Principal = Depends(need(Role.VIEWER))):
        return _list("incident")

    @r.get("/decisions")
    def decisions(p: Principal = Depends(need(Role.VIEWER))):
        return _list("decision")

    @r.get("/predictions")
    def predictions(p: Principal = Depends(need(Role.VIEWER))):
        return _list("prediction")

    @r.get("/commands")
    def commands(p: Principal = Depends(need(Role.VIEWER))):
        return [c for c in _list("command")]

    @r.get("/outcomes")
    def outcomes(p: Principal = Depends(need(Role.VIEWER))):
        return _list("outcome")

    @r.get("/cases")
    def cases(p: Principal = Depends(need(Role.VIEWER))):
        return _list("case")

    @r.get("/log")
    def log(p: Principal = Depends(need(Role.VIEWER))):
        return service.orch.log[-200:] if service.orch else []

    # ---------------- simulation control (operator) ----------------
    @r.post("/simulation/start")
    def sim_start(body: StartSimulation, p: Principal = Depends(need(Role.OPERATOR))):
        if body.fault is not None:
            from .schemas import Hypothesis
            try:
                Hypothesis(body.fault)
            except ValueError:
                raise HTTPException(422, f"unknown fault '{body.fault}'")
        sc = service.start(body.fault, body.severity, body.clears_below_rpm, body.seed, body.setpoint_rpm,
                           body.inject_after_s, body.require_human_approval)
        audit(p, "simulation_start", scenario=sc)
        return {"mode": "SIMULATION", "scenario": sc}

    @r.post("/simulation/step")
    def sim_step(body: StepRequest, p: Principal = Depends(need(Role.OPERATOR))):
        if service.orch is None:
            raise HTTPException(409, "no simulation running")
        n = service.step(body.seconds)
        return {"stepped": n, "state": service.state()}

    # ---------------- approvals / stop (operator) ----------------
    @r.post("/approvals/approve")
    def approve(p: Principal = Depends(need(Role.OPERATOR))):
        o = service.orch
        if o is None or o.pending is None:
            raise HTTPException(409, "nothing is awaiting approval")
        pend = {"action": o.pending.action.value, "params": o.pending.params}
        audit(p, "approve", **pend)
        o.approve(p.role)
        return {"approved": pend, "note": "dispatch accepted; read /commands for the device acknowledgement"}

    @r.post("/approvals/reject")
    def reject(p: Principal = Depends(need(Role.OPERATOR))):
        o = service.orch
        if o is None or o.pending is None:
            raise HTTPException(409, "nothing is awaiting approval")
        audit(p, "reject", action=o.pending.action.value)
        o.reject()
        return {"rejected": True}

    @r.post("/commands/stop")
    def stop(p: Principal = Depends(need(Role.VIEWER))):
        """STOP is available to any authenticated user: it can only make the system safer."""
        o = service.orch
        if o is None:
            raise HTTPException(409, "no simulation running")
        audit(p, "stop_requested")
        prop = ProposedAction(action=ActionType.STOP, source=ProposalSource.HUMAN, role=p.role, requested_by=p.user,
                              human_approved=True, incident_id=o.inc.id if o.inc else None)
        rec = o._propose(prop)
        if rec is None:
            raise HTTPException(500, "stop was not dispatched")
        o.cmd = rec
        return {"command_id": rec.id, "status": rec.status.value, "note": "dispatched, not yet acknowledged by the device"}

    @r.post("/commands/reset-estop")
    def reset_estop(p: Principal = Depends(need(Role.ADMIN))):
        o = service.orch
        if o is None:
            raise HTTPException(409, "no simulation running")
        audit(p, "reset_estop_requested")
        prop = ProposedAction(action=ActionType.RESET_ESTOP, source=ProposalSource.HUMAN, role=p.role,
                              requested_by=p.user, human_approved=True)
        rec = o._propose(prop)
        if rec is None:
            d = o._last_decision
            raise HTTPException(409, {"verdict": d.verdict.value, "reasons": d.reasons})
        return {"command_id": rec.id, "note": "device also requires its local button press"}

    # ---------------- lab (simulation) ----------------
    from . import lab as _lab
    from .sim import REGIMES as _REGIMES

    def _lab_or_404(sid: str) -> Dict[str, Any]:
        s = service.lab_get(sid)
        if s is None:
            raise HTTPException(404, "no such lab session")
        return s

    def _lab_guard(fn):
        try:
            return fn()
        except (_lab.LabError, ValueError) as e:
            raise HTTPException(422, str(e))

    @r.get("/lab/regimes")
    def lab_regimes(p: Principal = Depends(need(Role.VIEWER))):
        return [{"name": g.name, "description": g.description, "noise_mult": g.noise_mult, "session_offsets": g.session_offsets,
                 "sensor_fault_mode": g.sensor_fault_mode, "looseness_mode": g.looseness_mode} for g in _REGIMES.values()]

    @r.get("/lab/checklist")
    def lab_checklist(p: Principal = Depends(need(Role.VIEWER))):
        return {"items": [{"key": k, "text": t} for k, t in _lab.CHECKLIST],
                "note": "A procedure that is logged to the audit trail. It is not a safety mechanism."}

    @r.get("/lab/sessions")
    def lab_list(p: Principal = Depends(need(Role.VIEWER))):
        return [_lab.redact({k: v for k, v in s.items() if k != "_provenance"}) for s in service.store.list("lab_session")]

    @r.get("/lab/sessions/{sid}")
    def lab_one(sid: str, p: Principal = Depends(need(Role.VIEWER))):
        return _lab.redact(_lab_or_404(sid))

    @r.post("/lab/sessions")
    def lab_create(body: LabSessionIn, p: Principal = Depends(need(Role.OPERATOR))):
        s = _lab_guard(lambda: service.lab_create(
            p.user, purpose=body.purpose, notes=body.notes, blind=body.blind, regime=body.regime, seed=body.seed,
            profile=[x.model_dump() for x in body.profile], fault=body.fault, severity=body.severity,
            inject_at_s=body.inject_at_s, clears_below_rpm=body.clears_below_rpm, settings=body.settings))
        audit(p, "lab_session_created", id=s["id"], blind=s["blind"], regime=s["config"]["regime"], seed=s["config"]["seed"])
        return _lab.redact(s)

    @r.post("/lab/sessions/{sid}/checklist")
    def lab_checklist_confirm(sid: str, body: ChecklistIn, p: Principal = Depends(need(Role.OPERATOR))):
        s = _lab_or_404(sid)
        _lab_guard(lambda: _lab.confirm_checklist(s, body.items, p.user))
        service.lab_save(s)
        audit(p, "lab_checklist", id=sid, complete=s["checklist"]["complete"], items=s["checklist"]["items"])
        return _lab.redact(s)

    @r.post("/lab/sessions/{sid}/run")
    def lab_run(sid: str, p: Principal = Depends(need(Role.OPERATOR))):
        s = _lab_or_404(sid)
        if s["status"] == "completed":
            raise HTTPException(409, "session already ran; create a new session or use /reproduce")
        _lab_guard(lambda: service.lab_run(s))
        audit(p, "lab_session_run", id=sid, window_hash=s["result"]["window_hash"])
        return _lab.redact(s)

    @r.post("/lab/sessions/{sid}/reveal")
    def lab_reveal(sid: str, p: Principal = Depends(need(Role.OPERATOR))):
        s = _lab_or_404(sid)
        _lab_guard(lambda: _lab.reveal(s))
        service.lab_save(s)
        audit(p, "lab_session_revealed", id=sid, match=s["result"]["truth_match"])
        return s

    @r.post("/lab/sessions/{sid}/reproduce")
    def lab_repro(sid: str, p: Principal = Depends(need(Role.OPERATOR))):
        s = _lab_or_404(sid)
        if s["status"] != "completed":
            raise HTTPException(409, "run the session first")
        out = service.lab_reproduce(s)
        audit(p, "lab_session_reproduced", id=sid, identical=out["identical"])
        return out

    @r.get("/lab/experiments")
    def lab_experiments(p: Principal = Depends(need(Role.VIEWER))):
        return service.store.list("experiment")

    @r.post("/lab/experiments")
    def lab_experiment(body: ExperimentIn, p: Principal = Depends(need(Role.OPERATOR))):
        res = _lab_guard(lambda: service.lab_experiment(p.user, fault=body.fault, severity=body.severity,
                         speed_rpm=body.speed_rpm, regime=body.regime, repeats=body.repeats, seed0=body.seed0))
        audit(p, "lab_experiment", id=res["id"], fault=body.fault, repeats=body.repeats)
        return res

    # ---------------- healthy-session attestation (Phase 9; experimental adaptive C1) ----------------
    # Reads: viewer. Every mutation: operator or admin, enforced here AND again inside AttestationService. Attestation is an operator
    # judgment about a recorded simulated session; it is not proof that the motor is healthy.
    att = service.attestation

    def _att(fn):
        try:
            return fn()
        except AttestationError as e:
            raise HTTPException(e.status, e.message)
        except HTTPException:
            raise
        except Exception as e:                      # persistence / audit failure: nothing was changed (atomic), fail closed
            raise HTTPException(500, f"attestation action not recorded (no change was made): {type(e).__name__}")

    @r.get("/attestation/candidates")
    def att_list(p: Principal = Depends(need(Role.VIEWER))):
        return _att(lambda: att.list(service.orch))

    @r.get("/attestation/candidates/{cid}")
    def att_one(cid: str, p: Principal = Depends(need(Role.VIEWER))):
        return _att(lambda: att.detail(cid, service.orch))

    @r.get("/attestation/references")
    def att_refs(p: Principal = Depends(need(Role.VIEWER))):
        return _att(lambda: att.references(service.orch))

    @r.get("/attestation/events")
    def att_events(candidate: Optional[str] = None, p: Principal = Depends(need(Role.VIEWER))):
        return _att(lambda: att.events(candidate))

    @r.get("/attestation/warmup")
    def att_hold_status(p: Principal = Depends(need(Role.VIEWER))):
        o = service.orch
        return {"active": bool(o and o.hold_active()), "info": o.hold_info if o else None,
                "note": "While a hold is active only score-triggered incident opening is deferred; mandatory-stop conditions are not."}

    @r.post("/attestation/warmup/start")
    def att_hold_start(body: HoldIn, p: Principal = Depends(need(Role.OPERATOR))):
        o = service.orch
        if o is None:
            raise HTTPException(409, "no simulation running")
        reason = (body.reason or "").strip()
        if len(reason) < att.cfg.min_reason_chars:
            raise HTTPException(422, f"a reason of at least {att.cfg.min_reason_chars} characters is required")
        try:
            info = o.begin_supervised_warmup(p.user, body.seconds)
        except ValueError as e:
            raise HTTPException(409, str(e))
        audit(p, "attestation", event="warmup_hold_started", reason=reason, session=o.session, **info)
        return info

    @r.post("/attestation/warmup/end")
    def att_hold_end(p: Principal = Depends(need(Role.OPERATOR))):
        o = service.orch
        if o is None:
            raise HTTPException(409, "no simulation running")
        o.end_supervised_warmup(p.user)
        audit(p, "attestation", event="warmup_hold_ended", session=o.session)
        return {"active": False}

    @r.post("/attestation/candidates")
    def att_capture(p: Principal = Depends(need(Role.OPERATOR))):
        d = _att(lambda: att.capture(service.orch, service.scenario, p.user, p.role))
        return att.brief(d)

    @r.post("/attestation/candidates/{cid}/refresh")
    def att_refresh(cid: str, body: DecideIn, p: Principal = Depends(need(Role.OPERATOR))):
        return att.brief(_att(lambda: att.refresh(cid, service.orch, service.scenario, p.user, p.role, body.expected_rev)))

    @r.post("/attestation/candidates/{cid}/attest")
    def att_attest(cid: str, body: DecideIn, p: Principal = Depends(need(Role.OPERATOR))):
        return att.brief(_att(lambda: att.attest(cid, service.orch, p.user, p.role, body.reason, body.acknowledge, body.expected_rev)))

    @r.post("/attestation/candidates/{cid}/reject")
    def att_reject(cid: str, body: DecideIn, p: Principal = Depends(need(Role.OPERATOR))):
        return att.brief(_att(lambda: att.reject(cid, service.orch, p.user, p.role, body.reason, body.expected_rev)))

    @r.post("/attestation/candidates/{cid}/revoke")
    def att_revoke(cid: str, body: DecideIn, p: Principal = Depends(need(Role.OPERATOR))):
        return att.brief(_att(lambda: att.revoke(cid, service.orch, p.user, p.role, body.reason, body.expected_rev)))

    @r.post("/attestation/references/{version}/activate")
    def att_activate(version: int, body: ReasonIn, p: Principal = Depends(need(Role.OPERATOR))):
        return _att(lambda: att.activate(version, service.orch, p.user, p.role, body.reason))

    @r.post("/attestation/references/rollback")
    def att_rollback(body: ReasonIn, p: Principal = Depends(need(Role.OPERATOR))):
        return _att(lambda: att.rollback(service.orch, p.user, p.role, body.reason))

    # ---------------- audit (admin) ----------------
    @r.get("/audit")
    def audit_log(kind: Optional[str] = None, p: Principal = Depends(need(Role.ADMIN))):
        return service.store.audit_log(kind)

    return r
