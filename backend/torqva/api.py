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

    # ---------------- audit (admin) ----------------
    @r.get("/audit")
    def audit_log(kind: Optional[str] = None, p: Principal = Depends(need(Role.ADMIN))):
        return service.store.audit_log(kind)

    return r
