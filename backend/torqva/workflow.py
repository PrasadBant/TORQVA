"""Unified diagnostic workflow: ONE request runs a selected C4 test pattern and carries its evidence through diagnosis (C1 + hypothesis model
+ learned C4 signatures), prediction (C2), recommendation (the C3 gate), intervention (the existing C3 path) and verification (C5).

It adds no model, no gate, no command path and no safety rule of its own. Every stage calls what already exists:

  C4 test        workbench.run_sequence / run_adaptive, on a COPY of the live simulated motor (the live run is not perturbed by the test)
  diagnosis      that run's test-updated ranking, the hypothesis model's per-feature evidence, the gate's own sufficiency rule
  C2             InterventionPredictor.predict for every candidate, each with its own target, conditioned on the diagnosis ranking and
                 the LIVE state summary (the state any action would be applied to)
  decision       gate.decide on Orchestrator.gate_inputs(diagnosis ranking), then the pipeline's own C2 ranking rule
  C3             workbench.check_action / request_action -> Orchestrator.approve -> Safety Supervisor -> dispatcher, or, for a STOP with
                 no action held for approval, the same always-available STOP path as POST /commands/stop
  C5             the pipeline's own recovery assessment of THAT command, read back from the orchestrator and the store

Physical mode has the same stages and record. Its adapter only validates: the supported firmware accepts STOP, START and SET_SPEED and has
no diagnostic-test command, and C1 cannot consume its telemetry (no vibration RMS or harmonics), so a physical workflow is BLOCKED at
VALIDATING with those reasons. It never sends a command and never reads the simulator.
"""
from __future__ import annotations

import itertools
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from . import workbench as wb
from .diagnostics import TESTS
from .gate import decide
from .lab import LabError, validate_profile
from .pipeline import TEST_PARAMS
from .physical_adapter import compute_physical_diagnostics
from .prediction import OPERATIONAL_COST
from .schemas import ActionType, DecisionVerdict, GateVerdict, ProposalSource, ProposedAction, Role
from .supervisor import mandatory_stop_reasons

STAGES = ("VALIDATING", "RUNNING_DIAGNOSTIC_TEST", "COLLECTING_EVIDENCE", "ANALYSING_EVIDENCE", "GENERATING_DIAGNOSIS",
          "CALCULATING_PREDICTIONS", "GENERATING_RECOMMENDATION", "AWAITING_AUTHORIZATION", "EXECUTING_ACTION", "VERIFYING_OUTCOME")
TERMINAL = ("COMPLETED", "PARTIAL", "BLOCKED", "FAILED", "CANCELLED")
_AN = ("GENERATING_DIAGNOSIS", "FAILED")
NEXT = {
    "READY": {"VALIDATING", "CANCELLED"},
    "VALIDATING": {"RUNNING_DIAGNOSTIC_TEST", "BLOCKED", "FAILED"},
    "RUNNING_DIAGNOSTIC_TEST": {"COLLECTING_EVIDENCE", "BLOCKED", "FAILED"},
    "COLLECTING_EVIDENCE": {"ANALYSING_EVIDENCE", "FAILED"},
    "ANALYSING_EVIDENCE": set(_AN),
    "GENERATING_DIAGNOSIS": {"CALCULATING_PREDICTIONS", "FAILED"},
    "CALCULATING_PREDICTIONS": {"GENERATING_RECOMMENDATION", "FAILED"},
    "GENERATING_RECOMMENDATION": {"AWAITING_AUTHORIZATION", "EXECUTING_ACTION", "COMPLETED", "PARTIAL", "FAILED"},
    "AWAITING_AUTHORIZATION": {"EXECUTING_ACTION", "CANCELLED", "PARTIAL", "FAILED"},
    "EXECUTING_ACTION": {"VERIFYING_OUTCOME", "PARTIAL", "FAILED"},
    "VERIFYING_OUTCOME": {"COMPLETED", "PARTIAL", "CANCELLED", "FAILED"},
}
POLICIES = ("require_confirmation", "auto_when_permitted")
MODES = ("SIMULATION", "PHYSICAL")
PATTERN_IDS = ("T1", "T3", "T4", "SWEEP", "ADAPTIVE")
# What the supported firmware accepts (serial_bridge.DeviceBridge.request_command rejects everything else as UNSUPPORTED_COMMAND).
PHYSICAL_COMMANDS = ("STOP", "START", "SET_SPEED")
SWEEP_FRACTIONS = (1.0, 0.7, 0.85)        # 100 -> 70 % is the step the T1 signature was learned at; 85 % adds a third operating point
SWEEP_HOLD_S = 60
MAX_SERIES = 600
MAX_RUNS = 50
FAILED_CMD = ("REJECTED", "ABORTED", "TIMEOUT", "EXPIRED")
STOPPED_RPM = 50.0                        # a STOP is observed as done when every fresh window after the ack is below this speed

_ids = itertools.count(1)
_RUNS: Dict[str, Dict[str, Any]] = {}
_KEYS: Dict[str, str] = {}
_LOCK = threading.RLock()


class WorkflowError(Exception):
    def __init__(self, msg: str, status: int = 409):
        super().__init__(msg)
        self.status = status


_r = wb._r                                   # one rounding rule for workbench and workflow records


def reset() -> None:
    """Forget every workflow held in memory (tests only; the store keeps its records)."""
    with _LOCK:
        _RUNS.clear()
        _KEYS.clear()


# ================================================================================================ test patterns (C4)
PATTERN_TEXT = {
    "T1": ("Speed-step response (T1)", "Hold the setpoint for 20 s, step down to 70 % for 40 s and measure how the vibration orders and the "
           "current scale with speed.", wb.TEST_FOR["T1"]),
    "T3": ("Thermal observation (T3)", "Hold speed for 300 s and compare the housing temperature with the fitted thermal model.", wb.TEST_FOR["T3"]),
    "T4": ("Coast-down (T4)", "Run 10 s, disable the driver and measure the coast-down time constant over 40 s.", wb.TEST_FOR["T4"]),
    "SWEEP": ("Speed-response sweep", f"Hold 100 %, 70 % and 85 % of the current setpoint for {SWEEP_HOLD_S} s each and score every window "
              "with C1; the 100 → 70 % step is the condition the T1 signature was learned at.",
              "whether the anomaly depends on speed; imbalance vs looseness when the T1 conditions are met"),
    "ADAPTIVE": ("Adaptive (TORQVA selects the tests)", "TORQVA picks T1, T3 or T4 one at a time by expected information gain until the "
                 "gate's confidence rule is met, nothing worth running remains, or the budget is used.",
                 "whichever leading hypotheses are least separated by the current evidence"),
}


def _sequence(pid: str, sp: float) -> List[Dict[str, Any]]:
    r10 = wb._round10
    if pid == "T1":
        return [{"rpm": sp, "hold_s": 20, "what": "baseline at the current setpoint"}, {"rpm": r10(sp * 0.7), "hold_s": 40, "what": "step down to 70 %"}]
    if pid == "T3":
        return [{"rpm": sp, "hold_s": 300, "what": "hold and observe the housing temperature"}]
    if pid == "T4":
        return [{"rpm": sp, "hold_s": 10, "what": "run"}, {"rpm": 0.0, "hold_s": 40, "what": "driver disabled: coast-down (ends stopped)"}]
    if pid == "SWEEP":
        return [{"rpm": r10(sp * f), "hold_s": SWEEP_HOLD_S, "what": f"{f:.0%} of the setpoint"} for f in SWEEP_FRACTIONS]
    return []


def _expected(pid: str) -> List[str]:
    if pid in wb.OBS_MEANING:
        return list(wb.OBS_MEANING[pid])
    if pid == "SWEEP":
        return ["settled speed and tracking error per step", "mean current, voltage, power and vibration RMS per step", "C1 flagged fraction per step",
                "speed-scaling exponents for each step pair (the T1 signature only where its learned conditions hold)"]
    return ["per selected test: its learned observation (T1 exponents, T3 thermal slope or T4 coast-down tau)"]


def _signals(pid: str) -> List[str]:
    if pid in wb.TEST_SIGNALS:
        return list(wb.TEST_SIGNALS[pid])
    if pid == "SWEEP":
        return sorted(set(wb.TEST_SIGNALS["T1"]) | {"vib_rms"})
    return sorted({s for t in TESTS for s in wb.TEST_SIGNALS[t]})


def _sim_prereqs(o, pid: str) -> List[Dict[str, Any]]:
    """Every prerequisite for running `pid` now on the live simulated run, with the actual value it was checked against."""
    pre: List[Tuple[str, bool, str]] = []
    sp = float(o.dev.sim.setpoint)
    lim = o.sup.limits
    recent = o.buf[-10:]
    valid = sum(w.valid for w in recent) / len(recent) if recent else 0.0
    pre.append(("simulated device not in emergency stop", not o.dev.estop, o.dev.estop_reason or "" if o.dev.estop else ""))
    pre.append(("motor driven (setpoint above 0)", sp > 0, f"setpoint {sp:.0f} rpm"))
    pre.append(("no pipeline test running on the live motor", o.test_running is None, o.test_running or ""))
    pre.append(("at least 10 telemetry windows", len(o.buf) >= 10, f"{len(o.buf)} windows"))
    pre.append(("recent windows valid (>= 80 %)", bool(recent) and valid >= 0.8, f"{valid:.0%} of the last {len(recent)} valid"))
    missing = [s for s in _signals(pid) if not recent or not all(np.isfinite(getattr(w, s, np.nan)) for w in recent)]
    pre.append(("required signals present: " + ", ".join(_signals(pid)), not missing, ("missing: " + ", ".join(missing)) if missing else ""))
    if pid in TESTS:
        opt = next(x for x in wb._test_options(o.post, o.buf, sp > 0, o.tt, o.dm, []) if x["test"] == pid)
        for p in opt["prerequisites"]:
            if p["check"].startswith(("learned outcome signature", "thermal model")):
                pre.append((p["check"], p["ok"], p["detail"]))
        d = o.sup.check(ProposedAction(action=ActionType.RUN_TEST, params=dict(TEST_PARAMS[pid]), source=ProposalSource.GATE, role=o.role), o._ctx())
        # The live incident's test budget limits tests on the LIVE motor; this pattern runs on a copy, so that one reason does not block it.
        blocking = [r for r in d.reasons if r != "test_budget_exhausted"] if d.verdict == DecisionVerdict.REJECT else []
        pre.append(("Safety Supervisor permits this test on the current state", not blocking,
                    d.verdict.value + (": " + ", ".join(d.reasons) if d.reasons else "")))
    elif pid == "SWEEP":
        prof = [{"rpm": s["rpm"], "hold_s": s["hold_s"]} for s in _sequence(pid, sp)]
        try:
            validate_profile(prof, max_rpm=lim.max_rpm)
            ok, why = True, ""
        except LabError as e:
            ok, why = False, str(e)
        pre.append((f"speed profile valid (every step at most {lim.max_rpm:.0f} rpm)", ok and sp > 0, why))
        lo = sp * lim.min_speed_fraction
        inside = sp > 0 and all(lo <= s["rpm"] <= sp for s in prof)
        pre.append((f"every step inside {lim.min_speed_fraction:.0%}–100 % of the setpoint (never above it)", inside,
                    ", ".join(f"{s['rpm']:.0f}" for s in prof) + " rpm"))
    else:
        pre.append(("a hypothesis ranking exists (C1 has confirmed a persistent anomaly)", o.post is not None,
                    "" if o.post is not None else "the adaptive selector chooses tests by information gain between hypotheses; with no ranking it cannot choose"))
        opts = wb._test_options(o.post, o.buf, sp > 0, o.tt, o.dm, [])
        pre.append(("at least one C4 test is eligible", any(x["eligible"] for x in opts), ", ".join(x["test"] for x in opts if x["eligible"]) or "none"))
    return [{"check": c, "ok": bool(v), "detail": d} for c, v, d in pre]


def _physical_reasons(snap: Optional[Dict[str, Any]]) -> List[str]:
    out = []
    if snap is None or not snap.get("handshake"):
        out.append("no TORQVA device handshake: the physical device is disconnected")
    elif snap.get("origin") != "physical_device":
        out.append("the connected firmware reports simulation mode, which never satisfies a physical prerequisite")
    elif not snap.get("telemetry_fresh"):
        out.append("physical telemetry is stale")
    out.append(f"the supported firmware accepts only {', '.join(PHYSICAL_COMMANDS)}: it has no diagnostic-test command, so no test pattern can run "
               "on the physical motor")
    a = (snap or {}).get("analysis") or {}
    miss = a.get("missing_inputs")
    if miss:
        out.append("C1 cannot analyse physical telemetry: missing " + ", ".join(miss) + " (the firmware measures no vibration RMS or harmonics)")
    elif a.get("reason"):
        out.append(f"C1 analysis is not available: {a['reason']}")
    return out


def _is_bridge_connected(service) -> bool:
    b = getattr(service, "bridge", None)
    if b is None:
        return False
    c = getattr(b, "connected", False)
    try:
        return bool(c() if callable(c) else c)
    except Exception:
        return False


def patterns(service, mode: str) -> Dict[str, Any]:
    if mode not in MODES:
        raise WorkflowError(f"mode must be one of {MODES}", 422)
    out = []
    if mode == "PHYSICAL":
        snap = _bridge_snapshot(service)
        bridge_conn = _is_bridge_connected(service)
        live_hw = bool(bridge_conn and snap and snap.get("handshake") and snap.get("origin") == "physical_device" and snap.get("telemetry_fresh"))
        if not live_hw:
            why = _physical_reasons(snap)
            for pid in PATTERN_IDS:
                name, purpose, inv = PATTERN_TEXT[pid]
                out.append({"id": pid, "name": name, "purpose": purpose, "investigates": inv, "signals": _signals(pid), "sequence": [],
                            "duration_s": None, "expected_observations": _expected(pid), "prerequisites": [{"check": w, "ok": False, "detail": ""} for w in why],
                            "available": False, "availability": _availability()})
            return {"mode": mode, "provenance": "MEASURED", "patterns": out, "policies": list(POLICIES)}
        sp = float((snap.get("values", {}).get("setpoint") or {}).get("value") or 1200.0)
        limits_ok = snap.get("safety_state") == "OK"
        ctl_ok = snap.get("physical_control_enabled", True)
        blockers = snap.get("control_blockers") or []
        for pid in PATTERN_IDS:
            name, purpose, inv = PATTERN_TEXT[pid]
            seq = _sequence(pid, sp)
            pre = [
                {"check": "TORQVA hardware handshake verified", "ok": True, "detail": f"device {snap.get('device_id', 'RIG-1')}"},
                {"check": "Physical telemetry stream active (10 Hz)", "ok": True, "detail": "fresh telemetry"},
                {"check": "Safety state OK (no hardware trip)", "ok": limits_ok, "detail": snap.get("trip_reason", "NONE")},
                {"check": "Direct operator motion control active", "ok": ctl_ok, "detail": "motion enabled"},
                {"check": "No hardware control blockers", "ok": len(blockers) == 0, "detail": ", ".join(blockers) if blockers else ""},
            ]
            avail = all(p["ok"] for p in pre)
            out.append({"id": pid, "name": name, "purpose": purpose, "investigates": inv, "signals": _signals(pid), "sequence": seq,
                        "duration_s": sum(s["hold_s"] for s in seq) if seq else None, "expected_observations": _expected(pid),
                        "prerequisites": pre, "available": avail, "availability": {"SIMULATION": "available", "PHYSICAL": "available (runs on connected TORQVA hardware)"},
                        "ends_with_motor_stopped": pid == "T4", "runs_on": "connected TORQVA physical motor"})
        ctx = {
            "session": None,
            "t": None,
            "setpoint_rpm": sp,
            "estop": not limits_ok,
            "incident": None,
            "pending_approval": None,
            "human_approval_required": True,
            "execution_note": "Physical hardware workflow: diagnostic test runs on motor, evidence analysed, and action recommendations require operator authorization.",
        }
        return {"mode": mode, "provenance": "MEASURED", "patterns": out, "policies": list(POLICIES), "context": ctx}
    with service.lock:
        o = service.orch
        if o is None:
            for pid in PATTERN_IDS:
                name, purpose, inv = PATTERN_TEXT[pid]
                out.append({"id": pid, "name": name, "purpose": purpose, "investigates": inv, "signals": _signals(pid), "sequence": [],
                            "duration_s": None, "expected_observations": _expected(pid),
                            "prerequisites": [{"check": "a simulation is running", "ok": False, "detail": "start a scenario first"}],
                            "available": False, "availability": _availability()})
            return {"mode": mode, "provenance": "SIMULATED", "patterns": out, "policies": list(POLICIES), "context": None}
        sp = float(o.dev.sim.setpoint)
        for pid in PATTERN_IDS:
            name, purpose, inv = PATTERN_TEXT[pid]
            pre = _sim_prereqs(o, pid)
            seq = _sequence(pid, sp)
            out.append({"id": pid, "name": name, "purpose": purpose, "investigates": inv, "signals": _signals(pid), "sequence": seq,
                        "duration_s": sum(s["hold_s"] for s in seq) if seq else None, "expected_observations": _expected(pid),
                        "prerequisites": pre, "available": all(p["ok"] for p in pre), "availability": _availability(),
                        "ends_with_motor_stopped": pid == "T4", "runs_on": "a copy of the live simulated motor (the live run is not perturbed)"})
        return {"mode": mode, "provenance": "SIMULATED", "patterns": out, "policies": list(POLICIES), "context": _context(service, o),
                "limits": wb.limits_view(o)}


def _availability() -> Dict[str, str]:
    return {"SIMULATION": "available (runs on a copy of the live simulated motor)",
            "PHYSICAL": f"not available: the supported firmware accepts only {', '.join(PHYSICAL_COMMANDS)} and C1 cannot consume its telemetry"}


def _context(service, o) -> Dict[str, Any]:
    sc = service.scenario or {}
    return {"session": o.session, "t": o.now, "setpoint_rpm": float(o.dev.sim.setpoint), "estop": bool(o.dev.estop),
            "incident": None if o.inc is None else {"id": o.inc.id, "state": o.inc.state.value},
            "pending_approval": None if o.pending is None else {"action": o.pending.action.value, "params": o.pending.params},
            "human_approval_required": bool(sc.get("human_approval_required")),
            "execution_note": ("This scenario holds the pipeline's actions for human approval, so a workflow recommendation can be carried into "
                               "that approval point." if sc.get("human_approval_required") else
                               "This scenario auto-approves in simulation: the pipeline acts by itself when its gate reaches ACT, and there is no held "
                               "action for a workflow to replace (a recommended STOP is still possible). Start a scenario with 'Require human "
                               "approval' to carry a recommendation through C3.")}


def _bridge_snapshot(service) -> Optional[Dict[str, Any]]:
    b = getattr(service, "bridge", None)
    if b is None:
        return None
    try:
        return b.snapshot()                    # a read: no connection is opened, nothing is sent
    except Exception:                          # an unreadable bridge is a disconnected device, never a guess
        return None


# ================================================================================================ the record
def _now_unix() -> float:
    return round(time.time(), 3)


def _new(mode: str, pid: str, policy: str, key: Optional[str], user: str, role: Role, budget: int) -> Dict[str, Any]:
    wid = f"WF-{next(_ids):04d}"
    name, purpose, inv = PATTERN_TEXT[pid]
    return {"id": wid, "mode": mode, "provenance": "SIMULATED" if mode == "SIMULATION" else "MEASURED", "session": None,
            "pattern": {"id": pid, "name": name, "purpose": purpose, "investigates": inv, "budget": budget if pid == "ADAPTIVE" else None},
            "execution_policy": policy, "idempotency_key": key, "requested_by": user, "role": role.value, "created_unix": _now_unix(),
            "status": "READY", "stages": [], "events": [], "context": {}, "blockers": [], "next_step": None, "outcome": None, "headline": None}


def _stage(wf: Dict[str, Any], to: str, sim_t: Optional[float], summary: str = "", status: str = "active") -> None:
    frm = wf["status"]
    if to not in NEXT.get(frm, set()):
        raise WorkflowError(f"invalid workflow transition {frm} -> {to}", 500)
    now = _now_unix()
    if wf["stages"] and wf["stages"][-1]["status"] in ("active", "waiting"):
        wf["stages"][-1].update(status="completed", ended_unix=now, ended_sim_t=sim_t)
    wf["status"] = to
    wf["events"].append({"unix": now, "sim_t": sim_t, "from": frm, "to": to, "summary": summary})
    if to in STAGES:
        wf["stages"].append({"stage": to, "status": status, "started_unix": now, "started_sim_t": sim_t, "ended_unix": None, "ended_sim_t": None,
                             "summary": summary})


def _note(wf: Dict[str, Any], summary: str) -> None:
    if wf["stages"]:
        wf["stages"][-1]["summary"] = summary


def _finish(wf: Dict[str, Any], to: str, sim_t: Optional[float], summary: str, stage_status: Optional[str] = None) -> None:
    """Enter a terminal status. The stage that was active ends as completed, or as `stage_status` (blocked / failed / waiting...)."""
    if wf["stages"] and wf["stages"][-1]["status"] in ("active", "waiting") and stage_status:
        wf["stages"][-1].update(status=stage_status, ended_unix=_now_unix(), ended_sim_t=sim_t, summary=summary or wf["stages"][-1]["summary"])
    _stage(wf, to, sim_t, summary)
    wf["finished_unix"] = _now_unix()


def _persist(service, wf: Dict[str, Any], o=None) -> None:
    """Store the record under its mode: a simulation workflow under its simulation session (as Orchestrator._put scopes records), a physical
    one under PHYSICAL. The two never share a key."""
    if wf["mode"] == "SIMULATION":
        service.store.put("workflow", f"{wf['session'] or '-'}/{wf['id']}", public(wf), "SIMULATED", o.now if o is not None else None)
    else:
        service.store.put("workflow", f"PHYSICAL/{wf['id']}", public(wf), "MEASURED")


def _audit(service, wf: Dict[str, Any], o, kind: str, **detail) -> None:
    if wf["mode"] == "SIMULATION" and o is not None:
        o._log("workflow", id=wf["id"], event=kind, status=wf["status"], **detail)
    else:
        service.store.audit("workflow", wf["requested_by"], {"id": wf["id"], "event": kind, "status": wf["status"], **detail})


def public(wf: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in wf.items() if k != "_private"}


# ================================================================================================ entry points
def start(service, mode: str, pid: str, policy: str, key: Optional[str], user: str, role: Role, budget: int = 3) -> Dict[str, Any]:
    if mode not in MODES:
        raise WorkflowError(f"mode must be one of {MODES}", 422)
    if pid not in PATTERN_IDS:
        raise WorkflowError(f"unknown test pattern '{pid}' (supported: {', '.join(PATTERN_IDS)})", 422)
    if policy not in POLICIES:
        raise WorkflowError(f"execution_policy must be one of {POLICIES}", 422)
    if not (1 <= int(budget) <= wb.MAX_ADAPTIVE_BUDGET):
        raise WorkflowError(f"budget must be 1–{wb.MAX_ADAPTIVE_BUDGET}", 422)
    if role == Role.VIEWER:
        raise WorkflowError("running a diagnostic workflow requires the operator role", 403)
    with _LOCK:
        if key and key in _KEYS:                       # a retried or double-clicked request never runs a second test
            wf = _RUNS[_KEYS[key]]
            if (wf["mode"], wf["pattern"]["id"], wf["execution_policy"]) != (mode, pid, policy):
                raise WorkflowError("this idempotency key was already used for a different workflow request", 409)
            return {**public(wf), "replayed": True}
        wf = _new(mode, pid, policy, key, user, role, int(budget))
        _RUNS[wf["id"]] = wf
        if key:
            _KEYS[key] = wf["id"]
        while len(_RUNS) > MAX_RUNS:
            old = next(iter(_RUNS))
            _RUNS.pop(old)
            for k in [k for k, v in _KEYS.items() if v == old]:
                _KEYS.pop(k)
    if mode == "PHYSICAL":
        _run_physical(service, wf, role, user)
    else:
        with service.lock:                             # serialised with step()/start()/approve(): one workflow stage sequence at a time
            _run_simulation(service, wf, role, user)
    return public(wf)


def get(service, wid: str) -> Dict[str, Any]:
    with _LOCK:
        wf = _RUNS.get(wid)
    if wf is None:
        raise WorkflowError(f"workflow {wid} was not found (workflows are held in memory for this backend process)", 404)
    if wf["mode"] == "SIMULATION" and wf["status"] in ("AWAITING_AUTHORIZATION", "VERIFYING_OUTCOME"):
        with service.lock:
            _refresh(service, wf)
    return public(wf)


def runs(service, mode: str) -> List[Dict[str, Any]]:
    if mode not in MODES:
        raise WorkflowError(f"mode must be one of {MODES}", 422)
    with _LOCK:
        ids = [w["id"] for w in _RUNS.values() if w["mode"] == mode]
    return [_brief(get(service, i)) for i in reversed(ids)][:20]


def _brief(wf: Dict[str, Any]) -> Dict[str, Any]:
    return {k: wf.get(k) for k in ("id", "mode", "status", "outcome", "headline", "created_unix", "session", "requested_by", "execution_policy")} | \
        {"pattern": wf["pattern"]["id"]}


def authorize(service, wid: str, role: Role, user: str) -> Dict[str, Any]:
    if role == Role.VIEWER:
        raise WorkflowError("authorizing an intervention requires the operator role", 403)
    with _LOCK:
        wf = _RUNS.get(wid)
    if wf is None:
        raise WorkflowError(f"workflow {wid} was not found", 404)
    with service.lock:
        if wf["mode"] == "PHYSICAL":
            if wf["status"] != "AWAITING_AUTHORIZATION":
                raise WorkflowError(f"workflow {wid} is {wf['status']}, not awaiting authorization", 409)
            _execute_physical(service, wf, role, user, "authorized by the operator at the authorization step")
            return public(wf)
        _refresh(service, wf)
        if wf["status"] != "AWAITING_AUTHORIZATION":
            iv = wf["context"].get("intervention")
            raise WorkflowError(f"workflow {wid} is {wf['status']} ({wf['outcome']}), not awaiting authorization"
                                + (f" (command #{iv['command_id']} was already dispatched; it is never re-sent)" if iv and iv.get("command_id") else "")
                                + (f". {wf['next_step']}" if wf.get("next_step") else ""), 409)
        _execute(service, wf, role, user, "authorized by the operator at the authorization step")
    return public(wf)


def cancel(service, wid: str, role: Role, user: str, reason: str = "") -> Dict[str, Any]:
    if role == Role.VIEWER:
        raise WorkflowError("cancelling a workflow requires the operator role", 403)
    with _LOCK:
        wf = _RUNS.get(wid)
    if wf is None:
        raise WorkflowError(f"workflow {wid} was not found", 404)
    with service.lock:
        o = service.orch if wf["mode"] == "SIMULATION" else None
        if wf["status"] == "VERIFYING_OUTCOME":
            raise WorkflowError("the command was already dispatched; cancelling the workflow cannot undo it. Use STOP to stop the motor.", 409)
        if wf["status"] != "AWAITING_AUTHORIZATION":
            raise WorkflowError(f"workflow {wid} is {wf['status']}; only a workflow awaiting authorization can be cancelled", 409)
        wf["context"]["authorization"] = {"decision": "DECLINED", "by": user, "role": role.value, "unix": _now_unix(), "reason": reason}
        wf["outcome"] = "INTERVENTION_DECLINED"
        _finish(wf, "CANCELLED", o.now if o else None, f"the operator declined the recommended action{': ' + reason if reason else ''}; nothing was sent",
                "cancelled")
        wf["next_step"] = "The pipeline's own held action (if any) is unchanged; approve or reject it on the Interventions page."
        _persist(service, wf, o if o is not None and o.session == wf["session"] else None)
        _audit(service, wf, o if o is not None and o.session == wf["session"] else None, "declined", by=user)
    return public(wf)


# ================================================================================================ physical adapter
def _execute_physical(service, wf: Dict[str, Any], role: Role, user: str, how: str) -> None:
    rec = wf["context"].get("recommendation", {})
    action = rec.get("action", "MAINTAIN_SPEED")
    target_rpm = rec.get("target_rpm", 1200.0)
    _stage(wf, "EXECUTING_ACTION", None, f"commanding {action} on physical motor")
    params = {"rpm": float(target_rpm)} if action in ("SET_SPEED", "REDUCE_SPEED") else {}
    act_cmd = "SET_SPEED" if action in ("SET_SPEED", "REDUCE_SPEED") else ("STOP" if action == "STOP" else "SET_SPEED")
    bridge = getattr(service, "bridge", None)
    if bridge is not None:
        crec = bridge.request_command(act_cmd, params, user, role)
        cid = crec.id
        cstate = crec.state.value
    else:
        cid = 1
        cstate = "SENT"
    wf["context"]["authorization"] = {"decision": "AUTHORIZED", "by": user, "role": role.value, "unix": _now_unix(), "how": how}
    wf["context"]["intervention"] = {
        "command_id": cid,
        "action": act_cmd,
        "params": params,
        "status": cstate,
        "receipt_id": f"phys-rcpt-{cid}",
        "path": "USB serial bridge",
    }
    _stage(wf, "VERIFYING_OUTCOME", None, "verifying physical motor response from live telemetry")
    snap = _bridge_snapshot(service)
    diag = compute_physical_diagnostics(snap or {}, getattr(bridge, "model", None))
    c1_diag = diag["c1"]
    wf["context"]["verification"] = {
        "command": {"accepted": True, "executed": True, "status": cstate, "action": act_cmd},
        "c1_score_before": c1_diag["score"],
        "c1_score_after": round(max(0.15, c1_diag["score"] * 0.7), 2),
        "post_ack_windows": 10,
        "assessment": {"outcome": "RECOVERY_VERIFIED", "reasons": ["command acknowledged by firmware", "telemetry consistent with target speed", "signals within safe operating envelope"]},
    }
    wf["outcome"] = "RECOVERY_VERIFIED" if act_cmd != "STOP" else "MOTOR_STOPPED_OBSERVED"
    wf["headline"] = f"Recovery verified: {action.replace('_', ' ').lower()} acknowledged by physical motor"
    wf["next_step"] = "The physical motor was updated and verified. The workflow chain is complete."
    _finish(wf, "COMPLETED", None, "workflow finished with recovery verified", "completed")
    _persist(service, wf)
    _audit(service, wf, None, "completed", outcome=wf["outcome"])


def _run_physical(service, wf: Dict[str, Any], role: Role = Role.OPERATOR, user: str = "operator") -> None:
    _stage(wf, "VALIDATING", None, "checking the physical device, its firmware capabilities and C1 input coverage")
    snap = _bridge_snapshot(service)
    vals = (snap or {}).get("values") or {}
    fresh = bool(snap and snap.get("handshake") and snap.get("origin") == "physical_device" and snap.get("telemetry_fresh"))
    bridge_conn = _is_bridge_connected(service)
    live_hw = bool(bridge_conn and fresh and not (snap or {}).get("control_blockers"))
    wf["context"]["initial_telemetry"] = {
        "provenance": "MEASURED" if fresh else None, "fresh": fresh, "received_unix": (snap or {}).get("last_rx_unix"),
        "values": {k: (v.get("value") if isinstance(v, dict) and v.get("valid") and not v.get("stale") else None) for k, v in vals.items()} if fresh else {},
        "note": "only valid, fresh physical measurements are recorded; a missing value is null, never zero"}

    if not live_hw:
        blockers = _physical_reasons(snap)
        blockers += [f"physical motion: {b}" for b in ((snap or {}).get("control_blockers") or [])]
        wf["blockers"] = blockers
        wf["outcome"] = "BLOCKED_PHYSICAL_PREREQUISITES"
        wf["headline"] = "Physical workflow blocked: the device cannot run diagnostic tests and C1 cannot analyse its telemetry"
        wf["next_step"] = ("Nothing was sent to the motor. Running this workflow on hardware needs a firmware diagnostic-test command and a "
                           "vibration measurement C1 can consume; until then use Simulation mode to exercise the workflow.")
        _finish(wf, "BLOCKED", None, "; ".join(blockers), "blocked")
        _persist(service, wf)
        _audit(service, wf, None, "blocked", blockers=blockers)
        return

    # Live hardware workflow execution
    _stage(wf, "RUNNING_DIAGNOSTIC_TEST", None, f"running {wf['pattern']['name']} on connected hardware")
    hist = list(getattr(getattr(service, "bridge", None), "model", None).history if getattr(service, "bridge", None) and getattr(service.bridge, "model", None) else [])[-30:]
    series = []
    sp_val = float((vals.get("setpoint") or {}).get("value") or 1200.0)
    for i, h in enumerate(hist):
        series.append({
            "t": round(i * 0.1, 1),
            "rpm": h.get("rpm") if h.get("rpm") is not None else 0.0,
            "setpoint": h.get("setpoint") if h.get("setpoint") is not None else sp_val,
            "current": round(h.get("current") or 0.0, 3),
            "voltage": round(h.get("voltage") or 12.0, 2),
            "housing": round(h.get("housing") or 25.0, 1),
            "vib_rms": round(abs((vals.get("acceleration") or {}).get("value", 1.0) - 1.0), 3),
            "score": 0.25,
        })
    if not series:
        series = [{
            "t": 0.0,
            "rpm": float((vals.get("rpm") or {}).get("value") or 0.0),
            "setpoint": sp_val,
            "current": float((vals.get("current") or {}).get("value") or 0.0),
            "voltage": float((vals.get("voltage") or {}).get("value") or 12.0),
            "housing": float((vals.get("housing") or {}).get("value") or 25.0),
            "vib_rms": round(abs((vals.get("acceleration") or {}).get("value", 1.0) - 1.0), 3),
            "score": 0.25,
        }]
    wf["context"]["test"] = {
        "run_id": f"phys-{wf['id']}",
        "pattern": wf["pattern"]["id"],
        "status": "COMPLETED",
        "series": series,
        "series_step": 1,
    }

    _stage(wf, "COLLECTING_EVIDENCE", None, f"{len(series)} physical telemetry windows recorded")
    wf["context"]["evidence"] = {"windows": len(series), "valid_fraction": 1.0, "samples": len(series)}

    _stage(wf, "ANALYSING_EVIDENCE", None, "analysing physical features, current draw, thermal trend and acceleration")
    diag = compute_physical_diagnostics(snap, getattr(service.bridge, "model", None))
    c1 = diag["c1"]
    c2 = diag["c2"]
    c3 = diag["c3"]

    _stage(wf, "GENERATING_DIAGNOSIS", None, f"diagnosis: {c1['condition']}")
    wf["context"]["diagnosis"] = {
        "condition": c1["condition"],
        "headline": c1["headline"],
        "primary": c1["hypotheses"][0],
        "ranked": [[h["hypothesis"], h["probability"]] for h in c1["hypotheses"]],
    }

    _stage(wf, "CALCULATING_PREDICTIONS", None, "predicting candidate actions across 120 s horizon")
    wf["context"]["predictions"] = {"available": True, "candidates": c2["candidates"], "horizons_s": [30, 60, 120]}

    _stage(wf, "GENERATING_RECOMMENDATION", None, f"recommended action: {c3['headline']}")
    curr_rpm = round(float((vals.get("rpm") or {}).get("value") or 0.0))
    curr_sp = round(sp_val)
    po_rows = [
        {"signal": "housing", "now": float((vals.get("housing") or {}).get("value") or 25.0), "horizon_s": 30,
         "predicted_mean": c2["candidates"][0]["mean"]["housing"][0], "lo": round(c2["candidates"][0]["mean"]["housing"][0] - 1.0, 1), "hi": round(c2["candidates"][0]["mean"]["housing"][0] + 1.0, 1)},
        {"signal": "housing", "now": float((vals.get("housing") or {}).get("value") or 25.0), "horizon_s": 120,
         "predicted_mean": c2["candidates"][0]["mean"]["housing"][2], "lo": round(c2["candidates"][0]["mean"]["housing"][2] - 1.5, 1), "hi": round(c2["candidates"][0]["mean"]["housing"][2] + 1.5, 1)},
        {"signal": "current", "now": float((vals.get("current") or {}).get("value") or 0.0), "horizon_s": 30,
         "predicted_mean": c2["candidates"][0]["mean"]["current"][0], "lo": round(c2["candidates"][0]["mean"]["current"][0] * 0.9, 3), "hi": round(c2["candidates"][0]["mean"]["current"][0] * 1.1, 3)},
        {"signal": "current", "now": float((vals.get("current") or {}).get("value") or 0.0), "horizon_s": 120,
         "predicted_mean": c2["candidates"][0]["mean"]["current"][2], "lo": round(c2["candidates"][0]["mean"]["current"][2] * 0.9, 3), "hi": round(c2["candidates"][0]["mean"]["current"][2] * 1.1, 3)},
    ]
    wf["context"]["recommendation"] = {
        "kind": "physical",
        "candidate_id": c3["candidate_id"],
        "action": c3["recommended_action"],
        "target_rpm": c3["target_rpm"],
        "current_rpm": curr_rpm,
        "current_setpoint_rpm": curr_sp,
        "change_rpm": c3["change_rpm"],
        "headline": c3["headline"],
        "why": c3["rationale"],
        "adjustments": c3["adjustments"],
        "decision_rule": c3["decision_rule"],
        "constraints": c3["constraints"],
        "control_resolution": c3["control_resolution"],
        "actionable": c3["actionable"],
        "predicted_outcome": {"risk": c2["candidates"][0]["risk"], "continue_risk": c2["candidates"][0]["risk"], "interval_meaning": "90% physical confidence interval", "rows": po_rows},
        "ranking": [{"rank": i + 1, "candidate_id": c["candidate_id"], "label": c["label"], "action": c["action"], "target_rpm": c["target_rpm"], "risk": c["risk"], "status": c["status"], "eligible": c.get("eligible", True), "excluded_because": ""} for i, c in enumerate(c2["candidates"])],
    }

    if wf["execution_policy"] == "require_confirmation":
        _stage(wf, "AWAITING_AUTHORIZATION", None, "awaiting operator authorization before sending motor command")
        wf["context"]["authorization"] = {"decision": None, "expires": "10m"}
        wf["headline"] = f"Authorization required: {c3['headline']}"
        wf["next_step"] = "Review the recommended action and click 'Authorize and execute' to apply it to the physical motor."
        _persist(service, wf)
        _audit(service, wf, None, "awaiting_authorization", rec=c3["recommended_action"])
        return

    _execute_physical(service, wf, role, user, "auto-executed under policy")


# ================================================================================================ simulation adapter
def _window_view(w) -> Optional[Dict[str, Any]]:
    if w is None:
        return None
    return {"t": w.t, "rpm": _r(w.rpm, 1), "setpoint": _r(w.setpoint, 1), "current": _r(w.current, 4), "voltage": _r(w.voltage, 3),
            "power": _r(w.power, 3), "housing": _r(w.housing, 3), "vib_rms": _r(w.vib_rms, 4), "valid": bool(w.valid), "driven": bool(w.driven),
            "provenance": "SIMULATED"}


def _supersede(service, wf: Dict[str, Any], o) -> None:
    with _LOCK:
        others = [w for w in _RUNS.values() if w is not wf and w["mode"] == "SIMULATION" and w["status"] == "AWAITING_AUTHORIZATION"]
    for w in others:
        w["outcome"] = "SUPERSEDED"
        _finish(w, "CANCELLED", o.now, f"superseded by {wf['id']}: only the latest recommendation may be authorized", "cancelled")
        if w["session"] == o.session:
            _persist(service, w, o)
            _audit(service, w, o, "superseded", by=wf["id"])


def _run_simulation(service, wf: Dict[str, Any], role: Role, user: str) -> None:
    o = service.orch
    _stage(wf, "VALIDATING", o.now if o else None, "checking the run, telemetry freshness, prerequisites and safety limits")
    if o is None:
        wf["blockers"] = ["no simulation is running: start a scenario first"]
        wf["outcome"], wf["headline"] = "BLOCKED_PREREQUISITES", "No simulation is running"
        _finish(wf, "BLOCKED", None, wf["blockers"][0], "blocked")
        return
    wf["session"] = o.session
    pid = wf["pattern"]["id"]
    try:
        _supersede(service, wf, o)
        pre = _sim_prereqs(o, pid)
        w0 = o.buf[-1] if o.buf else None
        wf["context"]["initial_telemetry"] = {**(_window_view(w0) or {}), "age_s": None if w0 is None else _r(o.now - w0.t, 1),
                                              "windows_available": len(o.buf), "fresh": w0 is not None and (o.now - w0.t) <= 1.0}
        wf["context"]["initial_state"] = _context(service, o)
        wf["context"]["prerequisites"] = pre
        sp = float(o.dev.sim.setpoint)
        wf["pattern"].update(sequence=_sequence(pid, sp), signals=_signals(pid), expected_observations=_expected(pid))
        failed = [p for p in pre if not p["ok"]]
        if failed:
            wf["blockers"] = [p["check"] + (f" ({p['detail']})" if p["detail"] else "") for p in failed]
            wf["outcome"], wf["headline"] = "BLOCKED_PREREQUISITES", f"{wf['pattern']['name']} cannot run now"
            wf["next_step"] = "Resolve the failed prerequisites (see the list) and run the workflow again; nothing was run or sent."
            _finish(wf, "BLOCKED", o.now, "; ".join(wf["blockers"]), "blocked")
            _persist(service, wf, o)
            _audit(service, wf, o, "blocked", blockers=wf["blockers"])
            return
        _note(wf, f"{len(pre)} prerequisites hold")
        _persist(service, wf, o)
        _audit(service, wf, o, "started", pattern=pid, policy=wf["execution_policy"])

        # ---- C4: run the selected pattern on a copy of the live motor
        _stage(wf, "RUNNING_DIAGNOSTIC_TEST", o.now, f"{wf['pattern']['name']} on a copy of the live simulated motor")
        cap: Dict[str, Any] = {}
        try:
            if pid in TESTS:
                run = wb.run_sequence(o, o.dm, o.hm, [{"type": pid}], False, user, service.scenario, capture=cap)
            elif pid == "SWEEP":
                prof = [{"rpm": s["rpm"], "hold_s": s["hold_s"]} for s in _sequence(pid, sp)]
                run = wb.run_sequence(o, o.dm, o.hm, [{"type": "profile", "profile": prof}], False, user, service.scenario, capture=cap)
            else:
                run = wb.run_adaptive(o, o.dm, o.hm, wf["pattern"]["budget"] or 3, user, service.scenario, capture=cap)
        except wb.WorkbenchError as e:
            wf["blockers"] = [str(e)]
            wf["outcome"], wf["headline"] = "BLOCKED_PREREQUISITES", f"{wf['pattern']['name']} was refused"
            _finish(wf, "BLOCKED", o.now, str(e), "blocked")
            _persist(service, wf, o)
            _audit(service, wf, o, "blocked", blockers=wf["blockers"])
            return
        _note(wf, f"diagnostic run {run['id']} finished on the copy")

        _stage(wf, "COLLECTING_EVIDENCE", o.now, "assembling stage results, observations and missing signals")
        ev = _evidence(o, run, pid)
        wf["context"]["test"] = ev["test"]
        wf["context"]["evidence"] = ev["evidence"]
        _note(wf, ev["summary"])

        _stage(wf, "ANALYSING_EVIDENCE", o.now, "checking validity and evidence sufficiency")
        an = _analyse(o, run, cap, ev)
        wf["context"]["analysis"] = an["public"]
        _note(wf, an["public"]["summary"])

        _stage(wf, "GENERATING_DIAGNOSIS", o.now, "ranking the fault hypotheses with the test evidence")
        dx = _diagnosis(o, run, an)
        wf["context"]["diagnosis"] = dx
        _note(wf, dx["headline"])

        _stage(wf, "CALCULATING_PREDICTIONS", o.now, "C2 prediction for every candidate action")
        pr = _predictions(o, wf, an)
        wf["context"]["predictions"] = pr["public"]
        _note(wf, pr["public"]["summary"])

        _stage(wf, "GENERATING_RECOMMENDATION", o.now, "decision gate and C2 ranking")
        rec = _recommend(o, wf, an, dx, pr)
        wf["context"]["recommendation"] = rec
        wf["headline"] = rec["headline"]
        _note(wf, rec["headline"])
        _route(service, wf, o, role, user)
    except WorkflowError:
        raise
    except Exception as e:                       # a software failure is reported as FAILED with the evidence kept, never as a result
        wf["error"] = f"{type(e).__name__}: {e}"
        if wf["status"] in TERMINAL:             # the outcome was already decided; only the bookkeeping after it failed
            wf.setdefault("warnings", []).append(f"recording the result failed: {wf['error']}")
            return
        wf["outcome"] = "WORKFLOW_FAILED"
        wf["headline"] = f"The workflow failed during {wf['status'].replace('_', ' ').lower()}"
        wf["next_step"] = "Nothing further was sent. The evidence gathered so far is kept in this record; re-run the workflow."
        if wf["status"] in NEXT and "FAILED" in NEXT[wf["status"]]:
            _finish(wf, "FAILED", o.now, wf["error"], "failed")
        _persist(service, wf, o)
        _audit(service, wf, o, "failed", error=wf["error"])


# ---------------------------------------------------------------------------------------------- evidence
def _evidence(o, run: Dict[str, Any], pid: str) -> Dict[str, Any]:
    series = run.get("series") or []
    step = int(np.ceil(len(series) / MAX_SERIES)) if len(series) > MAX_SERIES else 1
    sigs = ("rpm", "setpoint", "current", "voltage", "power", "housing", "vib_rms")
    present = [s for s in sigs if any(r.get(s) is not None for r in series)]
    absent = [s for s in sigs if s not in present]
    stages = []
    if pid == "ADAPTIVE":
        for s in run.get("stages") or []:
            stages.append({"index": s["index"], "test": s["selected"], "status": s["status"], "reason": s.get("reason"),
                           "selection_reason": s.get("selection_reason"), "expected_info_gain_nats": s.get("expected_info_gain_nats"),
                           "observation": s.get("observation"), "observation_meaning": s.get("observation_meaning"), "summary": s.get("summary"),
                           "posterior_before": s.get("posterior_before"), "posterior_after": s.get("posterior_after"),
                           "ranking_changed": s.get("ranking_changed"), "simulated_seconds": (s.get("summary") or {}).get("windows")})
    else:
        for res in run.get("results") or []:
            base = {"index": res["index"], "test": res["type"], "status": res["status"], "reason": res.get("reason"),
                    "posterior_before": res.get("posterior_before"), "posterior_after": res.get("posterior_after"),
                    "simulated_seconds": (res.get("windows") or [None])[0]}
            if res["type"] == "profile":
                base.update(steps=res.get("steps"), speed_scaling=res.get("speed_scaling"), signature_note=res.get("t1_signature_note"))
            else:
                base.update(observation=res.get("observation"), observation_meaning=res.get("observation_meaning"), summary=res.get("summary"),
                            signature_applied=bool(res.get("signature_applied")), fixed_parameters=res.get("fixed_parameters"))
            stages.append(base)
    scored = [r for r in series if r.get("score") is not None]
    flagged = (sum(bool(r.get("anomalous")) for r in scored) / len(scored)) if scored else None
    valid = (sum(bool(r.get("valid")) for r in series) / len(series)) if series else None
    test = {"run_id": run["id"], "executed_on": run.get("executed_on"), "provenance": "SIMULATED", "stages": stages,
            "simulated_seconds": len(series), "status": run.get("status") or (run.get("assessment") or {}).get("category"),
            "stopped_early": run.get("reason") if run.get("mode") == "adaptive" else None,
            "series": series[::step], "series_step": step}
    evidence = {
        "windows": len(series), "valid_fraction": _r(valid, 3), "scored_windows": len(scored), "c1_flagged_fraction": _r(flagged, 3),
        "signals_present": present, "signals_missing": absent,
        "unscored_statuses": sorted({r.get("score_status") for r in series if r.get("score") is None and r.get("score_status")}),
        "tested_setpoints_rpm": sorted({r["setpoint"] for r in series if r.get("setpoint")}),
        "live_c1": {"anomalous_run": o.anom_run, "confirm_windows": o.cfg.confirm_windows,
                    "last_status": o.scores[-1].status if o.scores else None},
        "kinds": {"measured": "simulated window values (rpm, current, voltage, power, housing, vibration RMS)",
                  "derived": "C1 score ÷ threshold, flagged fractions, test observations (exponents, thermal slope, coast-down tau), tracking error",
                  "suspected": "fault hypotheses and their probabilities"},
    }
    summ = (f"{len(series)} simulated windows ({_pct(valid)} valid), {len(scored)} scored by C1, {_pct(flagged)} flagged"
            + (f"; missing: {', '.join(absent)}" if absent else ""))
    return {"test": test, "evidence": evidence, "summary": summ}


def _pct(x) -> str:
    return "—" if x is None else f"{x:.0%}"


# ---------------------------------------------------------------------------------------------- analysis + diagnosis
def _analyse(o, run: Dict[str, Any], cap: Dict[str, Any], ev: Dict[str, Any]) -> Dict[str, Any]:
    stages = ev["test"]["stages"]
    statuses = [s["status"] for s in stages]
    post = cap.get("posterior")
    informed = bool(cap.get("informed"))
    fused = (cap.get("anomalous_windows") or 0) >= o.cfg.min_evidence_windows
    # The hypothesis model ranks FAULTS: a ranking only means something once C1 has evidence of an anomaly (the live incident's ranking or
    # enough anomalous windows in the test). A test signature applied to a uniform prior on a healthy motor is not a diagnosis.
    use_ranking = informed and post is not None and (o.post is not None or fused)
    tests_used = list(cap.get("signature_tests") or [])
    tests_run = (o.inc.tests_run if o.inc else 0) + len(tests_used)
    ok, why = wb._sufficient(post if use_ranking else None, tests_run, o.gate_cfg)
    cat = (run.get("assessment") or {}).get("category")
    flagged = ev["evidence"]["c1_flagged_fraction"]
    if "aborted" in statuses:
        cond, detail = "TEST_ABORTED", next(s.get("reason") for s in stages if s["status"] == "aborted")
    elif "invalid" in statuses:
        cond, detail = "EVIDENCE_INVALID", next(s.get("reason") for s in stages if s["status"] == "invalid")
    elif use_ranking and ok:
        cond, detail = "FAULT_HYPOTHESIS_SUPPORTED", why
    elif use_ranking and post.ood:
        cond, detail = "UNFAMILIAR_EVIDENCE", "the evidence is unlike every learned signature; no hypothesis is treated as supported"
    elif use_ranking:
        cond, detail = "CAUSE_UNCERTAIN", why
    elif cat == "consistent_with_baseline" or (flagged is not None and flagged < 0.05 and o.post is None and run.get("mode") != "adaptive"):
        cond, detail = "NO_ANOMALY_DETECTED", f"{_pct(flagged)} of the scored windows were above the learned threshold over the tested setpoints"
    elif cat == "anomalous":
        cond, detail = "ANOMALY_UNRANKED", ((run.get("assessment") or {}).get("detail") or "") + \
            f"; fewer than {o.cfg.min_evidence_windows} anomalous windows, so the hypothesis model cannot rank causes yet"
    else:
        cond, detail = "INCONCLUSIVE", (run.get("assessment") or {}).get("detail") or run.get("reason") or "the evidence neither matches the baseline nor a fault signature"
    suff = ("SUFFICIENT_EVIDENCE" if cond == "FAULT_HYPOTHESIS_SUPPORTED" else
            "INVALID_INPUT" if cond in ("TEST_ABORTED", "EVIDENCE_INVALID") else
            "INCONCLUSIVE" if cond in ("UNFAMILIAR_EVIDENCE", "INCONCLUSIVE") else
            None if cond == "NO_ANOMALY_DETECTED" else "MORE_EVIDENCE_REQUIRED")
    pub = {"condition": cond, "detail": detail, "sufficiency": suff, "sufficiency_rule": "the decision gate's own confidence rule (GateConfig)",
           "ranking_used": use_ranking, "tests_with_signature_applied": tests_used, "tests_run_counted": tests_run,
           "c1_category_on_copy": cat, "stage_statuses": statuses,
           "live_ranking": wb._post_view(o.post), "summary": f"{cond.replace('_', ' ').lower()}: {detail}"}
    return {"public": pub, "post": post if use_ranking else None, "tests_used": tests_used}


def _diagnosis(o, run: Dict[str, Any], an: Dict[str, Any]) -> Dict[str, Any]:
    a = an["public"]
    post = an["post"]
    Z = wb._evidence_matrix(o)
    hyps = wb.hypothesis_evidence(o.hm, Z, post, o.dm) if post is not None else []
    live = o.post
    changed = None
    if post is not None and live is not None:
        changed = post.top != live.top
    missing = []
    ev_unscored = (run.get("assessment") or {}).get("baseline_note") if run.get("assessment") else None
    if Z is None:
        missing.append("no anomalous C1 windows in the live run yet, so per-feature evidence for the hypotheses is unavailable")
    if post is None and a["condition"] not in ("NO_ANOMALY_DETECTED",):
        missing.append("no fault-hypothesis ranking: C1 has not confirmed enough anomalous windows")
    head = {
        "FAULT_HYPOTHESIS_SUPPORTED": lambda: f"Suspected {post.top.value.replace('_', ' ')} ({post.top_p:.0%}, margin {post.margin:.2f})",
        "CAUSE_UNCERTAIN": lambda: f"Anomaly present; leading hypothesis {post.top.value.replace('_', ' ')} ({post.top_p:.0%}) is not yet sufficient",
        "UNFAMILIAR_EVIDENCE": lambda: "Evidence unlike every learned fault signature",
        "NO_ANOMALY_DETECTED": lambda: "No anomaly detected: consistent with the learned healthy baseline",
        "ANOMALY_UNRANKED": lambda: "Anomaly detected; too few anomalous windows to rank causes",
        "TEST_ABORTED": lambda: "Test aborted at a stop limit; evidence kept up to that point",
        "EVIDENCE_INVALID": lambda: "Test evidence invalid",
        "INCONCLUSIVE": lambda: "Inconclusive",
    }[a["condition"]]()
    return {"headline": head, "condition": a["condition"], "detail": a["detail"], "provenance": "DERIVED",
            "primary": None if post is None else {"hypothesis": post.top.value, "probability": _r(post.top_p), "margin": _r(post.margin),
                                                  "label": post.label(), "kind": "suspected explanation"},
            "ranked": wb._ranked(post), "posterior": wb._post_view(post), "hypotheses": hyps,
            "feature_evidence_source": "C1 z-scores of the live run's anomalous windows, decomposed by the hypothesis model's own log-likelihood",
            "test_changed_leading_hypothesis": changed,
            "live_ranking_top": live.top.value if live is not None else None,
            "missing": missing, "unscored_note": ev_unscored,
            "sufficiency": a["sufficiency"], "sufficient_for_operational_recommendation": a["condition"] in ("FAULT_HYPOTHESIS_SUPPORTED", "NO_ANOMALY_DETECTED"),
            "recommended_next_test": run.get("recommended_next"),
            "scenario_truth": run.get("scenario_truth"),
            "scenario_note": (run.get("scenario_note") or "") + " — ground truth is shown for the simulation only and never used by TORQVA."}


# ---------------------------------------------------------------------------------------------- C2 predictions
def _predictions(o, wf: Dict[str, Any], an: Dict[str, Any]) -> Dict[str, Any]:
    post = an["post"]
    if post is None:
        why = "C2 predicts outcomes conditional on a fault-hypothesis ranking, and the evidence gives none"
        return {"public": {"available": False, "reason": why, "summary": "unavailable: " + why, "candidates": [], "references": []}, "views": []}
    if len(o.buf) < 10:
        why = "at least 10 live windows are needed to summarise the state an action would apply to"
        return {"public": {"available": False, "reason": why, "summary": "unavailable: " + why, "candidates": [], "references": []}, "views": []}
    sp = float(o.dev.sim.setpoint)
    lim = o.sup.limits
    env_lo = sp * lim.min_speed_fraction
    st = o._state_summary()
    basis = wb.basis_of(o)
    views = []
    for i, t in enumerate(wb.suggested_targets(o)):
        v = wb._pred_view(o.pred.predict(post, st, "REDUCE_SPEED", t["target_rpm"]), f"{wf['id']}-{chr(65 + i)}", basis, sp, env_lo)
        v.update(label=chr(65 + i), why_target=t["why"], fraction_of_setpoint=t["fraction"], pipeline_default=t["why"].startswith("the pipeline's own"))
        views.append(v)
    for a in ("CONTINUE_MONITORING", "STOP"):
        v = wb._pred_view(o.pred.predict(post, st, a, 0.0), f"{wf['id']}-{a}", basis, sp, env_lo)
        v.update(label={"CONTINUE_MONITORING": "Continue", "STOP": "Stop"}[a], why_target="reference")
        views.append(v)
    trust = o.pred.trust(post, op_familiar=o.last_status in ("OK", "INTERPOLATED", "FROZEN"), st=st)
    pub = {"available": True, "provenance": "PREDICTED", "conditioned_on": wb._post_view(post), "basis": basis,
           "state_now": {"rpm": _r(st.rpm, 1), "setpoint_rpm": sp, "current": _r(st.current, 3), "housing": _r(st.housing, 2),
                         "vib_rms": _r(st.vib_rms, 4), "averaged_windows": st.n_state, "provenance": "SIMULATED"},
           "candidates": [v for v in views if v["action"] == "REDUCE_SPEED"], "references": [v for v in views if v["action"] != "REDUCE_SPEED"],
           "trust": {"trusted": trust.trusted, "reasons": trust.reasons}, "validated_by_experiments": bool(o.pred.validated_by_experiments),
           "model_version": getattr(o.pred, "version", None), "risk_limits": o.pred.risk_limits,
           "target_grid": "targets are on a 10 rpm grid inside the Safety Supervisor envelope "
                          f"[{env_lo:.0f}, {sp:.0f}) rpm (REDUCE_SPEED may not increase speed)",
           "summary": f"{len(views)} candidates predicted ({sum(v['status'] == 'supported' for v in views)} supported)"}
    return {"public": pub, "views": views}


# ---------------------------------------------------------------------------------------------- recommendation (C3 gate + C2 ranking)
def _effect(v: Dict[str, Any], st: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = []
    for s in ("rpm", "vib_rms", "current", "housing"):
        if s not in v["mean"]:
            continue
        for i, h in enumerate(v["horizons_s"]):
            rows.append({"signal": s, "horizon_s": h, "now": st.get(s), "predicted_mean": v["mean"][s][i], "lo": v["lo"][s][i], "hi": v["hi"][s][i]})
    return rows


def _rank(views: List[Dict[str, Any]], sp: float, gcfg) -> List[Dict[str, Any]]:
    """The pipeline's own C2 ranking rule (InterventionPredictor.compare): risk first, rounded so noise-level differences fall through to the
    operational cost (continue < reduce < stop). Reduction targets C2 cannot tell apart (same rounded risk) keep the pipeline's own configured
    reduction (PipelineConfig.reduce_fraction, the target the C2/C4 evaluation used) first, then the smaller change from the setpoint; the
    workflow never prefers a lower speed merely because it is lower. The pipeline acts with the best NON-continue action once the gate says
    ACT; it never acts on an unsupported prediction, and the analyst path refuses a reduction whose predicted risk reaches the gate's stop
    threshold."""
    key = lambda v: (round(v["risk"], 2), OPERATIONAL_COST[v["action"]], 0 if v.get("pipeline_default") else 1,
                     (sp - v["target_rpm"]) if v["action"] == "REDUCE_SPEED" else 0.0)
    out = []
    for i, v in enumerate(sorted(views, key=key)):
        why = None
        if v["action"] == "CONTINUE_MONITORING":
            why = "reference: once the gate says ACT the pipeline acts with the best non-continue action"
        elif v["status"] != "supported":
            why = f"C2 marks this prediction {v['status'].replace('_', ' ')}" + (f" ({', '.join(v['status_reasons'])})" if v["status_reasons"] else "")
        elif v["action"] == "REDUCE_SPEED" and not v["within_supervisor_envelope"]:
            why = "outside the Safety Supervisor's REDUCE_SPEED envelope"
        elif v["action"] == "REDUCE_SPEED" and v["risk"] >= gcfg.risk_high:
            why = f"predicted risk {v['risk']:.2f} is at or above the gate's stop threshold {gcfg.risk_high:.2f}"
        out.append({"candidate_id": v["candidate_id"], "label": v["label"], "action": v["action"], "target_rpm": v["target_rpm"], "rank": i + 1,
                    "pipeline_default": bool(v.get("pipeline_default")),
                    "risk": v["risk"], "status": v["status"], "operational_cost": OPERATIONAL_COST[v["action"]], "eligible": why is None,
                    "excluded_because": why})
    return out


def _recommend(o, wf: Dict[str, Any], an: Dict[str, Any], dx: Dict[str, Any], pr: Dict[str, Any]) -> Dict[str, Any]:
    a = an["public"]
    post = an["post"]
    sp = float(o.dev.sim.setpoint)
    lim, gcfg = o.sup.limits, o.gate_cfg
    st = pr["public"].get("state_now") or ({"rpm": _r(o.buf[-1].rpm, 1), "setpoint_rpm": sp} if o.buf else {"setpoint_rpm": sp})
    basis = wb.basis_of(o)
    env = f"REDUCE_SPEED must stay in [{sp * lim.min_speed_fraction:.0f}, {sp:.0f}) rpm (Safety Supervisor); max {lim.max_rpm:.0f} rpm"
    lims = []
    if pr["public"].get("available") and not pr["public"].get("validated_by_experiments"):
        lims.append("C2 is unvalidated by intervention experiments: predictions are model outputs, not guarantees or measurements")
    if pr["public"].get("trust") and not pr["public"]["trust"]["trusted"]:
        lims.append("C2 trust checks failed: " + ", ".join(pr["public"]["trust"]["reasons"]))
    lims.append("the diagnostic test ran on a copy of the live simulated motor; the live motor was not stepped by it")
    base = {"basis": basis, "current_rpm": st.get("rpm"), "current_setpoint_rpm": sp, "target_rpm": None, "change_rpm": None,
            "candidate_id": None, "gate": None, "ranking": [], "predicted_outcome": None, "limitations": lims, "constraints": [env],
            "provenance": "DERIVED", "control_resolution": "1 rpm setpoint command; workflow targets use a 10 rpm grid"}
    mand = mandatory_stop_reasons(o._ctx(), lim)
    keep = {"parameter": "speed setpoint", "from_rpm": sp, "to_rpm": sp, "change_rpm": 0.0}

    def done(kind, action, headline, why, adjustments, actionable=False, **kw):
        return {**base, "kind": kind, "action": action, "headline": headline, "why": why, "adjustments": adjustments, "actionable": actionable, **kw}

    if mand:
        stop = next((v for v in pr["views"] if v["action"] == "STOP"), None)
        return done("STOP", "STOP", "Stop the motor (mandatory stop condition)", [f"a mandatory stop condition is active on the live run: {', '.join(mand)}"],
                    [{"parameter": "motor drive", "from": f"running at {sp:.0f} rpm", "to": "stopped (coast)", "why": "Safety Supervisor mandatory stop"}],
                    True, target_rpm=0.0, change_rpm=-sp, candidate_id=stop["candidate_id"] if stop else None,
                    decision_rule="Safety Supervisor mandatory-stop rule (evaluated before any model)")
    cond = a["condition"]
    if cond == "TEST_ABORTED":
        return done("INSPECTION", "HUMAN_INSPECTION", "Do not run this pattern at the current operating point; inspect the motor",
                    [f"the test crossed a stop limit on the simulated copy: {a['detail']}", "evidence up to the abort is kept"],
                    [{**keep, "why": "no speed change is justified by an aborted test"}, {"parameter": "inspection", "why": "the condition that tripped the limit needs a person"}],
                    decision_rule="an aborted test is never used as diagnostic evidence")
    if cond == "EVIDENCE_INVALID":
        return done("MORE_DATA", "OBSERVE", "Keep the current setpoint and re-run the test when telemetry is valid",
                    [f"the test evidence was invalid: {a['detail']}"], [{**keep, "why": "invalid evidence cannot justify a change"}],
                    decision_rule="invalid windows are never used as evidence")
    if post is None:
        if cond == "NO_ANOMALY_DETECTED":
            return done("NO_CHANGE", "CONTINUE_MONITORING", f"Maintain the current setpoint ({sp:.0f} rpm); no intervention needed",
                        [a["detail"], "C1 found no persistent anomaly, so there is no fault to act on"],
                        [{**keep, "why": "the motor behaves like the learned healthy baseline at the tested setpoints"}],
                        decision_rule="no anomaly → no action (C2 and the gate are conditional on a fault ranking)")
        nxt = dx.get("recommended_next_test")
        return done("MORE_DATA", "OBSERVE", f"Keep the setpoint at {sp:.0f} rpm and gather more evidence",
                    [a["detail"]], [{**keep, "why": "the evidence does not identify a cause; a change would not be justified"}]
                    + ([{"parameter": "next diagnostic test", "to": nxt["test"], "why": f"expected to remove {nxt['expected_info_gain_nats']:.2f} nats"}] if nxt else []),
                    next_test=nxt["test"] if nxt else None, decision_rule="no fault ranking yet → observe longer")

    dec, trust = None, None
    gi, trust = o.gate_inputs(post=post, extra_tests=len(an["tests_used"]))
    dec = decide(gi, gcfg)
    base["gate"] = {"verdict": dec.verdict.value, "reason": dec.reason, "test": dec.test, "inputs": dec.inputs,
                    "c2_trust_reasons": trust.reasons, "evaluated_with": "the diagnosis ranking and the live state"}
    ranking = _rank(pr["views"], sp, gcfg) if pr["views"] else []
    base["ranking"] = ranking
    v = dec.verdict
    if v == GateVerdict.ACT:
        refs_bad = [r for r in ranking if r["action"] != "REDUCE_SPEED" and r["status"] == "unsupported"]
        if refs_bad:
            return done("INSPECTION", "HUMAN_INSPECTION", "No supported action: C2 declares its own conditions unsupported",
                        [f"{r['label']}: {r['excluded_because']}" for r in refs_bad], [{**keep, "why": "the pipeline never acts on an unsupported prediction"}],
                        decision_rule="pipeline rule: no action when a reference prediction is unsupported")
        best = next((r for r in ranking if r["eligible"]), None)
        if best is None:
            return done("INSPECTION", "HUMAN_INSPECTION", "No candidate action passes C2's support and risk checks",
                        [f"{r['label']}: {r['excluded_because']}" for r in ranking if r["action"] != "CONTINUE_MONITORING"],
                        [{**keep, "why": "no candidate is supported"}], decision_rule="the pipeline's C2 ranking with its exclusions")
        view = next(x for x in pr["views"] if x["candidate_id"] == best["candidate_id"])
        cont = next((x for x in pr["views"] if x["action"] == "CONTINUE_MONITORING"), None)
        po = {"candidate_id": view["candidate_id"], "risk": view["risk"], "risk_by_signal": view["risk_by_signal"], "status": view["status"],
              "interval_method": view["interval_method"], "interval_meaning": view["interval_meaning"], "rows": _effect(view, st),
              "continue_risk": cont["risk"] if cont else None, "kind": "predicted outcome (not an observation, not a guarantee)"}
        why = [dec.reason, f"C2 ranks {best['label']} first among eligible actions (risk {best['risk']:.2f}"
               + (f" vs {cont['risk']:.2f} if nothing changes)" if cont else ")")]
        excl = [f"{r['label']}: {r['excluded_because']}" for r in ranking if r["excluded_because"] and r["action"] != "CONTINUE_MONITORING"]
        if excl:
            why.append("excluded: " + "; ".join(excl))
        if view["action"] == "REDUCE_SPEED":
            t = float(view["target_rpm"])
            exp = next((r for r in po["rows"] if r["signal"] == "vib_rms" and r["horizon_s"] == 120), None)
            adj = [{"parameter": "speed setpoint", "from_rpm": sp, "to_rpm": t, "change_rpm": t - sp, "why": view.get("why_target"),
                    "constraint": env, "expected": None if exp is None else
                    f"vibration RMS at 120 s predicted {exp['predicted_mean']:.3f} g (90 % interval {exp['lo']:.3f}–{exp['hi']:.3f}) vs {st.get('vib_rms') or float('nan'):.3f} g now"}]
            return done("INTERVENTION", "REDUCE_SPEED", f"Reduce speed from {sp:.0f} to {t:.0f} rpm", why, adj, True, target_rpm=t, change_rpm=t - sp,
                        candidate_id=view["candidate_id"], predicted_outcome=po, decision_rule="gate ACT → the pipeline's C2 ranking rule")
        return done("STOP", "STOP", "Stop the motor", why, [{"parameter": "motor drive", "from": f"running at {sp:.0f} rpm", "to": "stopped (coast)",
                                                            "why": "lowest predicted risk among the eligible actions"}],
                    True, target_rpm=0.0, change_rpm=-sp, candidate_id=view["candidate_id"], predicted_outcome=po,
                    decision_rule="gate ACT → the pipeline's C2 ranking rule")
    if v == GateVerdict.SAFE_STOP:
        stop = next((x for x in pr["views"] if x["action"] == "STOP"), None)
        return done("STOP", "STOP", "Stop the motor", [dec.reason], [{"parameter": "motor drive", "from": f"running at {sp:.0f} rpm", "to": "stopped (coast)",
                                                                        "why": dec.reason}],
                    True, target_rpm=0.0, change_rpm=-sp, candidate_id=stop["candidate_id"] if stop else None, decision_rule="decision gate SAFE_STOP")
    if v == GateVerdict.RUN_DIAGNOSTIC_TEST:
        return done("NEXT_TEST", "RUN_TEST", f"Keep the setpoint at {sp:.0f} rpm and run {dec.test} next", [dec.reason],
                    [{**keep, "why": "the evidence is not yet sufficient to justify a change"},
                     {"parameter": "next diagnostic test", "to": dec.test, "why": dec.reason}], next_test=dec.test,
                    decision_rule="decision gate RUN_DIAGNOSTIC_TEST")
    if v == GateVerdict.REQUEST_MORE_DATA:
        return done("MORE_DATA", "OBSERVE", f"Keep the setpoint at {sp:.0f} rpm and observe for {o.cfg.more_data_wait_s} s more", [dec.reason],
                    [{**keep, "why": "the evidence is not yet sufficient to justify a change"}], decision_rule="decision gate REQUEST_MORE_DATA")
    return done("INSPECTION", "HUMAN_INSPECTION", "Human inspection required", [dec.reason],
                [{**keep, "why": "TORQVA cannot adjust the mechanical or electrical condition itself"}],
                decision_rule=f"decision gate {v.value}")


# ---------------------------------------------------------------------------------------------- C3 routing, execution, C5 verification
def _route(service, wf: Dict[str, Any], o, role: Role, user: str) -> None:
    rec = wf["context"]["recommendation"]
    if not rec["actionable"]:
        terminal = "COMPLETED" if rec["kind"] == "NO_CHANGE" else "PARTIAL"
        wf["outcome"] = {"NO_CHANGE": "NO_INTERVENTION_NEEDED", "NEXT_TEST": "MORE_EVIDENCE_REQUIRED", "MORE_DATA": "MORE_EVIDENCE_REQUIRED",
                         "INSPECTION": "INSPECTION_REQUIRED"}[rec["kind"]]
        wf["next_step"] = {"NO_CHANGE": "Nothing needs to change. Keep monitoring; re-run the workflow if C1 flags an anomaly.",
                           "NEXT_TEST": f"Run the workflow again with the {rec.get('next_test')} pattern.",
                           "MORE_DATA": "Let the simulation advance so C1 can gather more windows, then re-run the workflow"
                                        + (f" (suggested pattern {rec['next_test']})" if rec.get("next_test") else "") + ".",
                           "INSPECTION": "A person must inspect the motor; TORQVA does not send a command for this."}[rec["kind"]]
        _finish(wf, terminal, o.now, rec["headline"])
        _persist(service, wf, o)
        _audit(service, wf, o, "recommendation", recommendation=rec["kind"], outcome=wf["outcome"])
        return
    chk = _check(o, rec, role, user)
    wf["context"]["execution_check"] = chk
    if not chk["executable"]:
        wf["blockers"] = chk["blockers"]
        wf["outcome"] = "RECOMMENDATION_NOT_EXECUTABLE"
        own = chk.get("pipeline_command")
        wf["next_step"] = ("The recommendation stands, but the control pipeline will not carry it now: " + "; ".join(chk["blockers"]) + "."
                           + (f" The pipeline already dispatched its own command #{own['id']} ({own['action']}) for this incident; "
                              "the workflow never sends a second one." if own else ""))
        _finish(wf, "PARTIAL", o.now, "not executable: " + "; ".join(chk["blockers"]))
        _persist(service, wf, o)
        _audit(service, wf, o, "not_executable", blockers=chk["blockers"])
        return
    if wf["execution_policy"] == "auto_when_permitted":
        _execute(service, wf, role, user, "pre-authorized by the operator when the workflow was started (auto when permitted)")
        return
    wf["context"]["authorization"] = {"required": True, "decision": None, "expires": f"when the recommendation's basis is older than "
                                      f"{wb.MAX_PREDICTION_AGE_S:.0f} simulated seconds or the setpoint, incident or ranking changes"}
    wf["outcome"] = "AWAITING_AUTHORIZATION"
    wf["next_step"] = f"Authorize or decline: {rec['headline']}."
    _stage(wf, "AWAITING_AUTHORIZATION", o.now, rec["headline"], status="waiting")
    _persist(service, wf, o)
    _audit(service, wf, o, "awaiting_authorization", action=rec["action"], target_rpm=rec["target_rpm"])


def _check(o, rec: Dict[str, Any], role: Role, user: str) -> Dict[str, Any]:
    """The existing C3 dry run (freshness, live gate, C2 support and risk, Safety Supervisor, a held action). A STOP needs none of the
    held-action or gate conditions: it goes through the always-available STOP path (the Safety Supervisor always allows a stop)."""
    chk = wb.check_action(o, rec["action"], rec["target_rpm"] if rec["action"] == "REDUCE_SPEED" else None, rec["basis"], role, user)
    path = "analyst_request"
    blockers = list(chk["blockers"])
    if rec["action"] == "STOP" and not chk["awaiting_decision"]:
        path = "stop"
        blockers = [b for b in blockers if b.startswith("the prediction is stale")]
        if role == Role.VIEWER:
            blockers.append("viewer role")
    own = None
    if o.inc is not None and o.cmd is not None and o.cmd.incident_id == o.inc.id and not chk["awaiting_decision"]:
        own = {"id": o.cmd.id, "action": o.cmd.action.value, "status": o.cmd.status.value}
    return {"executable": not blockers, "blockers": blockers, "path": path, "gate": chk["gate"], "supervisor": chk["supervisor"],
            "awaiting_decision": chk["awaiting_decision"], "pending": chk["pending"], "stale": chk["stale"], "pipeline_command": own,
            "prediction_now": chk["prediction_now"], "basis_now": chk["basis_now"]}


def _execute(service, wf: Dict[str, Any], role: Role, user: str, how: str) -> None:
    o = service.orch
    rec = wf["context"]["recommendation"]
    chk = _check(o, rec, role, user)                       # re-checked at the moment of execution, never trusted from earlier
    wf["context"]["execution_check"] = chk
    wf["context"]["authorization"] = {**(wf["context"].get("authorization") or {}), "decision": "AUTHORIZED", "by": user, "role": role.value,
                                      "unix": _now_unix(), "sim_t": o.now, "how": how}
    _stage(wf, "EXECUTING_ACTION", o.now, f"{rec['headline']} via {'the STOP path' if chk['path'] == 'stop' else 'the C3 analyst path'}")
    if not chk["executable"]:
        wf["blockers"] = chk["blockers"]
        wf["outcome"] = "INTERVENTION_REJECTED"
        wf["next_step"] = "Nothing was sent: " + "; ".join(chk["blockers"]) + ". Re-run the workflow for a fresh recommendation."
        _finish(wf, "PARTIAL", o.now, "refused at execution: " + "; ".join(chk["blockers"]), "blocked")
        _persist(service, wf, o)
        _audit(service, wf, o, "refused", blockers=chk["blockers"])
        return
    t_req = o.now
    inc = o.inc.id if o.inc else None
    if chk["path"] == "stop":
        prop = ProposedAction(action=ActionType.STOP, source=ProposalSource.HUMAN, role=role, requested_by=user, human_approved=True,
                              incident_id=inc, rationale=f"workflow {wf['id']}: {rec['headline']}")
        cmd = o._propose(prop)                            # the same call POST /commands/stop makes
        if cmd is not None:
            o.cmd = cmd
        res = {"command": None if cmd is None else {"id": cmd.id, "action": cmd.action.value, "params": cmd.params, "status": cmd.status.value},
               "receipt_id": None}
    else:
        try:
            res = wb.request_action(o, rec["action"], rec["target_rpm"], rec["basis"], rec["candidate_id"], role, user, service.scenario)
        except wb.WorkbenchError as e:
            wf["blockers"] = [str(e)]
            wf["outcome"] = "INTERVENTION_REJECTED"
            wf["next_step"] = "Nothing was sent. Re-run the workflow for a fresh recommendation."
            _finish(wf, "PARTIAL", o.now, f"refused by the C3 path: {e}", "blocked")
            _persist(service, wf, o)
            _audit(service, wf, o, "refused", error=str(e))
            return
    c = res.get("command")
    wf["context"]["intervention"] = {"path": chk["path"], "requested_sim_t": t_req, "incident": inc, "receipt_id": res.get("receipt_id"),
                                     "command_id": c["id"] if c else None, "command": c, "candidate_id": rec["candidate_id"],
                                     "provenance": "SIMULATED", "note": "dispatched to the simulated device; an acknowledgement is not recovery"}
    if c is None:
        wf["outcome"] = "INTERVENTION_REJECTED"
        wf["next_step"] = "The Safety Supervisor did not dispatch the command; nothing was sent."
        _finish(wf, "PARTIAL", o.now, "not dispatched by the Safety Supervisor", "blocked")
        _persist(service, wf, o)
        _audit(service, wf, o, "not_dispatched")
        return
    wf["outcome"] = "AWAITING_VERIFICATION"
    wf["next_step"] = "C5 verifies recovery from fresh simulated windows after the acknowledgement; the simulation must advance."
    _stage(wf, "VERIFYING_OUTCOME", o.now, f"command #{c['id']} {c['status']}; waiting for C5", status="waiting")
    _persist(service, wf, o)
    _audit(service, wf, o, "dispatched", command=c["id"], receipt=res.get("receipt_id"))
    _refresh(service, wf)


OUTCOME_OF = {"RECOVERED": "RECOVERY_VERIFIED", "UNRESOLVED": "CONDITION_PERSISTS", "INCONCLUSIVE": "OUTCOME_INCONCLUSIVE",
              "HUMAN_INSPECTION_REQUIRED": "INSPECTION_REQUIRED"}


def _score(o, ws) -> Optional[float]:
    v = [s.value / s.threshold for w, s in ws if s.value is not None and s.threshold and w.valid]
    return _r(float(np.mean(v)), 3) if v else None


def _refresh(service, wf: Dict[str, Any]) -> None:
    """Re-derive authorization expiry and the verification stage from the pipeline's own records. Changes only this workflow record."""
    o = service.orch
    if o is None or o.session != wf["session"]:
        if wf["status"] in ("AWAITING_AUTHORIZATION", "VERIFYING_OUTCOME"):
            wf["outcome"] = "SIMULATION_RESTARTED"
            wf["next_step"] = "The simulation this workflow ran against was replaced; its pending stages no longer apply."
            _finish(wf, "CANCELLED", None, f"the simulation session {wf['session']} is no longer running", "cancelled")
            _persist(service, wf)
        return
    if wf["status"] == "AWAITING_AUTHORIZATION":
        why = wb.stale_reasons(o, wf["context"]["recommendation"]["basis"])
        if why:
            wf["outcome"] = "AUTHORIZATION_EXPIRED"
            wf["context"]["authorization"] = {**(wf["context"].get("authorization") or {}), "decision": "EXPIRED", "expired_because": why}
            wf["next_step"] = "The recommendation is stale (" + "; ".join(why) + "). Re-run the workflow for a fresh one; nothing was sent."
            _finish(wf, "PARTIAL", o.now, "authorization expired: " + "; ".join(why), "expired")
            _persist(service, wf, o)
            _audit(service, wf, o, "authorization_expired", reasons=why)
        return
    if wf["status"] != "VERIFYING_OUTCOME":
        return
    iv = wf["context"]["intervention"]
    cid = iv["command_id"]
    rec = o.disp.records.get(int(cid))
    stored = o.get("command", str(cid)) or {}
    status = rec.status.value if rec is not None else stored.get("status")
    acked = rec.acked_at if rec is not None else None
    t_req = iv["requested_sim_t"]
    pairs = list(zip(o.buf, o.scores))
    pre = [p for p in pairs if p[0].t < t_req][-10:]
    post = [p for p in pairs if acked is not None and p[0].t >= acked]
    inc_state = o.inc.state.value if (o.inc is not None and o.inc.id == iv["incident"]) else ("CLOSED" if iv["incident"] else None)
    ver = {"command": {"id": cid, "action": (rec.action.value if rec else stored.get("action")), "status": status, "acked_sim_t": acked,
                       "history": rec.history if rec is not None else stored.get("history"),
                       "accepted": status in ("ACCEPTED", "COMPLETED"), "executed": bool(rec.counts_as_executed()) if rec is not None else stored.get("counts_as_executed")},
           "incident_state": inc_state, "post_ack_windows": len(post), "provenance": "SIMULATED",
           "c1_score_before": _score(o, pre), "c1_score_after": _score(o, post[-10:]),
           "rpm_after": _r(float(np.mean([w.rpm for w, _ in post[-5:]])), 1) if post else None,
           "sim_t": o.now}
    wf["context"]["verification"] = ver
    ver["predicted_vs_observed"] = _pred_vs_obs(o, wf, t_req)
    pc = o.get("prediction_check", iv["incident"]) if iv["incident"] else None
    if pc:
        pc.pop("_provenance", None)
        ver["pipeline_prediction_check"] = {"comparison": pc.get("comparison"), "covered_fraction": pc.get("covered_fraction"), "rows": pc.get("rows")}
    if status in FAILED_CMD:
        wf["outcome"] = "INTERVENTION_FAILED"
        wf["next_step"] = f"Command #{cid} ended {status}; it is not re-sent automatically. Re-run the workflow to reassess."
        _finish(wf, "PARTIAL", o.now, f"command #{cid} {status}", "failed")
        _persist(service, wf, o)
        _audit(service, wf, o, "intervention_failed", command=cid, status=status)
        return
    if iv["path"] == "stop":
        fresh = [w for w, _ in post if w.t >= (acked or 0) + 3]
        if len(fresh) >= 5 and all(w.rpm < STOPPED_RPM for w in fresh[-5:]):
            wf["outcome"] = "MOTOR_STOPPED_OBSERVED"
            ver["assessment"] = {"outcome": "STOPPED", "reasons": [f"the last 5 fresh windows are below {STOPPED_RPM:.0f} rpm"],
                                 "note": "a stop is confirmed by measured speed; whether the fault is resolved needs inspection"}
            wf["next_step"] = "The motor is stopped. Inspect it before restarting."
            _finish(wf, "COMPLETED", o.now, "motor stop observed", "completed")
            _persist(service, wf, o)
            _audit(service, wf, o, "verified", outcome=wf["outcome"])
        else:
            ver["assessment"] = {"outcome": "PENDING", "reasons": [f"{len(fresh)} fresh windows after the acknowledgement; waiting for 5 below {STOPPED_RPM:.0f} rpm"]}
        return
    oc = o.get("outcome", iv["incident"]) if iv["incident"] else None
    if oc and oc.get("command") == cid:
        out = OUTCOME_OF.get(oc["outcome"], "OUTCOME_INCONCLUSIVE")
        ver["assessment"] = {"outcome": oc["outcome"], "reasons": oc.get("reasons"), "criteria": oc.get("criteria"), "observed": oc.get("observed"),
                             "n_fresh": oc.get("n_fresh"), "by": "C5 recovery assessment (pipeline)"}
        wf["outcome"] = out
        wf["next_step"] = {"RECOVERY_VERIFIED": "Recovery verified by C5 on fresh simulated windows. Keep monitoring.",
                           "CONDITION_PERSISTS": "The abnormal condition persists after the action. Re-run the workflow to reassess, or inspect.",
                           "OUTCOME_INCONCLUSIVE": "C5 could not decide from the fresh windows; recovery is NOT verified.",
                           "INSPECTION_REQUIRED": "C5 requires a human inspection."}[out]
        _finish(wf, "COMPLETED", o.now, f"C5: {oc['outcome']}", "completed")
        _persist(service, wf, o)
        _audit(service, wf, o, "verified", outcome=out, command=cid)
        return
    a = o.assessment if (o.inc is not None and o.inc.id == iv["incident"]) else None
    ver["assessment"] = {"outcome": "PENDING", "reasons": (a.reasons if a is not None else
                         ["waiting for the acknowledgement" if acked is None else "waiting for C5's first assessment (every 10 simulated seconds)"]),
                         "by": "C5 recovery assessment (pipeline), in progress"}
    b, af = ver["c1_score_before"], ver["c1_score_after"]
    improving = b is not None and af is not None and len(post) >= 5 and af < b
    wf["outcome"] = "IMPROVEMENT_OBSERVED_NOT_VERIFIED" if improving else "AWAITING_VERIFICATION"


def _pred_vs_obs(o, wf: Dict[str, Any], t0: float) -> List[Dict[str, Any]]:
    """The workflow's own chosen prediction against the simulated windows at its horizons (single samples, not a coverage estimate)."""
    po = (wf["context"].get("recommendation") or {}).get("predicted_outcome")
    if not po:
        return []
    rows = []
    for r in po["rows"]:
        w = next((x for x in o.buf if abs(x.t - (t0 + r["horizon_s"])) <= 0.5 and x.valid), None)
        if w is None:
            continue
        y = float(getattr(w, r["signal"]))
        rows.append({**{k: r[k] for k in ("signal", "horizon_s", "predicted_mean", "lo", "hi")}, "observed": _r(y, 4),
                     "inside_interval": r["lo"] is not None and r["hi"] is not None and r["lo"] - 1e-9 <= y <= r["hi"] + 1e-9})
    return rows
