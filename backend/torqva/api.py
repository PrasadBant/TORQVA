"""TORQVA HTTP API. Mounted under /api/torqva. Every route requires a bearer token (fail closed).

Roles: viewer = read; operator = approve/reject/stop/run simulation; admin = audit log, reset, learning.
Every privileged action is written to the append-only audit log with the authenticated user.
HTTP 200 on a command route means "accepted for dispatch", never "the motor did it": clients must read the
command's device acknowledgement (GET /commands) and post-action measurements.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator

from .attestation import AttestationError
from .auth import Principal, TokenAuth
from .schemas import ActionType, ProposalSource, ProposedAction, Role
from .service import SimulationService


SEED = Field(default=1, ge=0, le=2**32 - 1, description="numpy-compatible seed")


class StartSimulation(BaseModel):
    fault: Optional[str] = Field(default=None, max_length=40, description="imbalance|looseness|overload|cooling_failure|supply_voltage|sensor_fault")
    severity: float = Field(default=0.5, ge=0.0, le=1.0, allow_inf_nan=False)
    clears_below_rpm: Optional[float] = Field(default=None, ge=0, le=100000, allow_inf_nan=False)
    seed: int = SEED
    setpoint_rpm: float = Field(default=1800.0, gt=0, le=3000, allow_inf_nan=False)
    inject_after_s: int = Field(default=40, ge=0, le=3600)
    require_human_approval: bool = False


class ProfileStep(BaseModel):
    rpm: float = Field(gt=0, le=3000, allow_inf_nan=False)
    hold_s: float = Field(ge=5, le=900, allow_inf_nan=False)


class LabSessionIn(BaseModel):
    purpose: str = Field(default="fault_run", max_length=40)
    notes: str = Field(default="", max_length=4000)
    blind: bool = False
    regime: str = Field(default="baseline", max_length=60)
    seed: int = SEED
    profile: List[ProfileStep] = Field(default_factory=lambda: [ProfileStep(rpm=1500, hold_s=90)], max_length=50)
    fault: Optional[str] = Field(default=None, max_length=40)
    severity: float = Field(default=0.5, ge=0.0, le=1.0, allow_inf_nan=False)
    inject_at_s: int = Field(default=30, ge=0, le=1800)
    clears_below_rpm: Optional[float] = Field(default=None, ge=0, le=100000, allow_inf_nan=False)
    settings: Dict[str, Any] = Field(default_factory=dict, description="Physical injection record: mass g, radius mm, shim, ...")

    @field_validator("settings")
    @classmethod
    def _settings_small(cls, v):
        import json as _json
        if len(v) > 40 or len(_json.dumps(v, default=str)) > 8192:
            raise ValueError("settings is limited to 40 keys and 8 KB")
        return v


class ChecklistIn(BaseModel):
    items: Dict[str, bool] = Field(max_length=100)


class ExperimentIn(BaseModel):
    fault: str = Field(max_length=40)
    severity: float = Field(default=0.6, gt=0, le=1, allow_inf_nan=False)
    speed_rpm: float = Field(default=1800, gt=0, le=3000, allow_inf_nan=False)
    regime: str = Field(default="baseline", max_length=60)
    repeats: int = Field(default=3, ge=1, le=10)
    seed0: int = Field(default=100, ge=0, le=2**32 - 1000)


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


# ---- analyst workbench (simulation only; see workbench.py) ----
class SequenceStep(BaseModel):
    type: str = Field(max_length=10, description="profile | T1 | T3 | T4")
    profile: Optional[List[ProfileStep]] = Field(default=None, max_length=50)


class SequenceIn(BaseModel):
    steps: List[SequenceStep] = Field(min_length=1, max_length=6)
    stop_when_confident: bool = True


class Basis(BaseModel):
    t: float
    setpoint_rpm: float
    incident: Optional[str] = None
    posterior_top: Optional[str] = None
    posterior_label: Optional[str] = None
    posterior_windows: int = 0


class ActionIn(BaseModel):
    action: str = Field(max_length=20, description="REDUCE_SPEED | STOP")
    target_rpm: Optional[float] = Field(default=None, gt=0, le=3000, allow_inf_nan=False)
    basis: Optional[Basis] = None
    candidate_id: Optional[str] = Field(default=None, max_length=40)


def install_error_handlers(app) -> None:
    """Validation errors must never become a 500: pydantic echoes the offending input, and a non-finite float (NaN / Infinity, which Python's JSON parser accepts)
    cannot be serialised back, so FastAPI's default 422 body raised. The handler returns location, message and type only."""
    from fastapi.exceptions import RequestValidationError
    from fastapi.responses import JSONResponse

    @app.exception_handler(RequestValidationError)
    async def _validation(request, exc):
        return JSONResponse(status_code=422, content={"detail": [{"loc": list(e.get("loc", ())), "msg": e.get("msg"), "type": e.get("type")} for e in exc.errors()]})


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
        """Newest EvaluationRun JSON from docs/eval (read-only artifact). Only files whose schema is EvaluationRun/* qualify: other study
        artifacts in the same folder (c1_phase8_*.json, c2c4_phase10_*.json) are NOT evaluation runs. SIMULATED unless it says otherwise.
        'Newest' = the highest run number in eval_sim_run<N>.json (file modification times are NOT used: a fresh clone gives every file the same time, which made the
        choice arbitrary). `available_runs` lists every qualifying committed run; there is no other evaluation history."""
        import json
        import re
        from pathlib import Path
        d = Path(__file__).resolve().parents[2] / "docs" / "eval"
        runs = []
        for f in (sorted(d.glob("*.json")) if d.exists() else []):
            try:
                run = json.loads(f.read_text())
            except Exception:
                continue
            if isinstance(run, dict) and str(run.get("schema", "")).startswith("EvaluationRun"):
                m = re.search(r"(\d+)", f.stem)
                runs.append((int(m.group(1)) if m else -1, f.name, run))
        if not runs:
            raise HTTPException(404, "no evaluation run found")
        runs.sort(key=lambda t: (t[0], t[1]))
        n, name, run = runs[-1]
        return {"file": name, "run": run, "selection": "highest run number in the file name", "available_runs": [
            {"file": nm, "git_sha": r.get("git_sha"), "config_hash": r.get("config_hash"), "runtime_s": r.get("runtime_s"), "has_regimes": "regimes" in r} for _, nm, r in runs]}

    @r.get("/evaluation/c2c4")
    def evaluation_c2c4(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        """Phase 10 C2/C4 study summary (condensed), prediction targets and test specifications. Simulation only."""
        import json
        from pathlib import Path
        d = Path(__file__).resolve().parents[2] / "docs" / "eval"
        f = d / "c2c4_phase10_final.json"
        if not f.exists():
            raise HTTPException(404, "no C2/C4 study result found (run python -m torqva.c2c4_study final)")
        full = json.loads(f.read_text())
        keep = ("n", "coverage", "coverage_ci95", "mean_width_norm", "interval_score_norm", "trusted_frac", "mae_model")
        c2 = {}
        for variant, v in full["c2"].items():
            c2[variant] = {rg: {**{k: e["overall"].get(k) for k in keep}, "worst_cell_coverage": e["worst_cell_coverage"]}
                           for rg, e in v["by_regime"].items()}
        v2 = d / "c2c4_phase10_c4_v2_final.json"
        phase11: Dict[str, Any] = {"adopted": False, "status": "opt-in candidates only; shipped defaults unchanged"}
        cf, c4f = d / "c2cov_phase11_v2_final.json", d / "c4cal_phase11_final.json"
        if cf.exists():
            cv = json.loads(cf.read_text())
            phase11["c2_conditional"] = {"n_test_cases": cv["n_test_cases"], "variants": {
                vn: {rg: {"n_cases": e["overall"]["n_cases"], "coverage": e["overall"]["coverage_case_level"], "coverage_ci95": e["overall"]["coverage_ci95_case_bootstrap"],
                          "trusted_frac": e["overall"].get("trusted_frac"), "coverage_when_trusted": e["overall"].get("coverage_when_trusted"),
                          "worst_fault": e.get("worst_fault_cell"), "overload": e["by_fault"].get("overload", {}).get("coverage_case_level")}
                     for rg, e in vv.items()} for vn, vv in cv["variants"].items()}}
        if c4f.exists():
            c4 = json.loads(c4f.read_text())
            phase11["c4_calibration"] = {"adopted": bool(c4["adopted_on_validation"]), "closest_to_feasible": c4["closest_to_feasible"], "n_test_sessions": c4["n_test_sessions"]}
        g12 = d / "generalization_phase12_final.json"
        phase12 = None
        if g12.exists():
            g = json.loads(g12.read_text())
            phase12 = {"n_c2_cases": g["c2"]["n_test_cases"], "n_c4_sessions": g["c4"]["n_test_sessions"], "claims_replicated": g["c2"]["phase11_claims_replicated"],
                       "c2": {vn: {"worst_subgroup": v["worst_sufficiently_sampled_subgroup"], "by_regime": {rg: {"coverage": e["overall"]["coverage_case_level"], "n_cases": e["overall"]["n_cases"],
                              "width_median": e["overall"]["width_median"], "mae_norm": e["overall"]["mae_norm"], "abstention": v["abstention_by_regime"][rg],
                              "supported_frac": e["overall"].get("supported_frac")} for rg, e in v["by_regime"].items()}} for vn, v in g["c2"]["variants"].items()},
                       "c4": {vn: {k: v["pooled"].get(k) for k in ("n", "accuracy_after", "confident_wrong", "confident_wrong_ci95", "inconclusive", "conflict", "decision_worse_than_prior", "ece_top_prob")}
                              | {"meets_acceptance_bar": g["c4"]["acceptance_bar_on_fresh_seeds"][vn]["meets_bar"], "worst_regime": g["c4"]["acceptance_bar_on_fresh_seeds"][vn]["worst_regime"],
                                 "worst_regime_confident_wrong": g["c4"]["acceptance_bar_on_fresh_seeds"][vn]["worst_regime_confident_wrong"]} for vn, v in g["c4"]["variants"].items()},
                       "c4_adopt": g["c4"]["candidate_vs_phase10_guard"]["adopt"], "WARNING": g["WARNING"]}
        return {"schema": full["schema"], "data_provenance": full["data_provenance"], "WARNING": full["WARNING"], "c2": c2, "phase11": phase11, "phase12": phase12,
                "c4_realistic_v1": full["c4"]["realistic_T1"],
                "c4_realistic_v2": json.loads(v2.read_text())["realistic_T1"] if v2.exists() else None,
                "prediction_targets": full["prediction_targets"], "test_specs": full["test_specs"],
                "limitations": ["Simulation only: the simulator is uncalibrated and its fault models are structurally consistent with the predictors.",
                                "Predictions are expected outcomes under matched simulated conditions, not counterfactuals of one physical run and not measurements.",
                                "No C2 variant is validated by Intervention Outcome Experiments on hardware.",
                                "The noise-aware C2 variant and the style-aware C4 library are opt-in; the shipped models remain the default."]}

    from .device_routes import add_device_routes
    add_device_routes(r, service, need, audit, auth)

    @r.get("/devices")
    def devices(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        """Device transport status. Today no physical transport is configured: the answer is UNAVAILABLE, never a fabricated healthy device."""
        gw = service.gateway
        if gw is None:
            return {"physical_transport": "UNAVAILABLE", "reason": "no device transport configured (no secured firmware transport exists yet)", "physical_control_approved": False,
                    "devices": [], "simulation_device": {"kind": "simulation", "physical": False}}
        return {"physical_transport": "CONFIGURED", "physical_control_approved": gw.policy.commissioning_approved,
                "devices": [gw.device_state(d) for d in sorted(gw.registry._d)], "simulation_device": {"kind": "simulation", "physical": False}}

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

    @r.get("/prediction-checks")
    def prediction_checks(p: Principal = Depends(need(Role.VIEWER))):
        """Predicted-vs-observed records of the CURRENT simulation session (observations are simulated telemetry, never a recovery verdict)."""
        return _list("prediction_check")

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

    # ---------------- analyst workbench (simulation only) ----------------
    from . import workbench as _wb

    def _wb_call(fn):
        with service.lock:                      # serialise with step() / start()
            o = service.orch
            if o is None:
                raise HTTPException(409, "no simulation running")
            try:
                return fn(o)
            except _wb.WorkbenchError as e:
                raise HTTPException(e.status, str(e))

    @r.get("/simulation/workbench/plan")
    def wb_plan(p: Principal = Depends(need(Role.VIEWER))):
        return _wb_call(lambda o: _wb.plan(o, o.dm, o.hm))

    @r.post("/simulation/workbench/sequence")
    def wb_sequence(body: SequenceIn, p: Principal = Depends(need(Role.OPERATOR))):
        steps = [{"type": s.type, "profile": [x.model_dump() for x in (s.profile or [])]} for s in body.steps]
        audit(p, "diagnostic_sequence", steps=[s["type"] for s in steps])
        return _wb_call(lambda o: _wb.run_sequence(o, o.dm, o.hm, steps, body.stop_when_confident, p.user, service.scenario))

    @r.get("/simulation/workbench/predict")
    def wb_predict(targets: List[float] = Query(..., min_length=1, max_length=3), p: Principal = Depends(need(Role.VIEWER))):
        import math
        if any(not math.isfinite(x) or x <= 0 or x > 3000 for x in targets):
            raise HTTPException(422, "every target must be a finite rpm in (0, 3000]")
        return _wb_call(lambda o: _wb.predict_targets(o, targets))

    @r.post("/simulation/workbench/check")
    def wb_check(body: ActionIn, p: Principal = Depends(need(Role.VIEWER))):
        return _wb_call(lambda o: _wb.check_action(o, body.action, body.target_rpm, body.basis.model_dump() if body.basis else None, p.role, p.user))

    @r.post("/simulation/workbench/request")
    def wb_request(body: ActionIn, p: Principal = Depends(need(Role.OPERATOR))):
        audit(p, "analyst_action_requested", action=body.action, target_rpm=body.target_rpm, candidate=body.candidate_id)
        return _wb_call(lambda o: _wb.request_action(o, body.action, body.target_rpm, body.basis.model_dump() if body.basis else None,
                                                     body.candidate_id, p.role, p.user))

    # ---------------- approvals / stop (operator) ----------------
    @r.post("/approvals/approve")
    def approve(p: Principal = Depends(need(Role.OPERATOR))):
        with service.lock:                      # serialise with step() / start() (the lock is taken per simulated second there)
            o = service.orch
            if o is None or o.pending is None:
                raise HTTPException(409, "nothing is awaiting approval")
            pend = {"action": o.pending.action.value, "params": o.pending.params}
            audit(p, "approve", **pend)
            o.approve(p.role)
            return {"approved": pend, "note": "dispatch accepted; read /commands for the device acknowledgement"}

    @r.post("/approvals/reject")
    def reject(p: Principal = Depends(need(Role.OPERATOR))):
        with service.lock:                      # serialise with step() / start() (the lock is taken per simulated second there)
            o = service.orch
            if o is None or o.pending is None:
                raise HTTPException(409, "nothing is awaiting approval")
            audit(p, "reject", action=o.pending.action.value)
            o.reject()
            return {"rejected": True}

    @r.post("/commands/stop")
    def stop(p: Principal = Depends(need(Role.VIEWER))):
        """STOP is available to any authenticated user: it can only make the system safer."""
        with service.lock:                      # serialise with step() / start() (the lock is taken per simulated second there)
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
        with service.lock:                      # serialise with step() / start() (the lock is taken per simulated second there)
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
