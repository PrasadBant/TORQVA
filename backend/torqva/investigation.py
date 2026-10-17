"""Evidence-to-action trace and Decision Receipts for the SOFTWARE SIMULATOR (simulation mode only).

Nothing here is a second pipeline. The trace is assembled from records the orchestrator already writes (its log, which tags every entry
with its incident, and the session's stored decision / prediction / command / outcome / diagnostic_run / counterfactual records). Every
event carries a reference to the record it came from. A stage with no record says so; nothing is filled in.

Decision Receipts:
* An analyst request (workbench.request_action) gets a receipt whether it is accepted or refused. Its snapshot of the evidence is copied
  before anything is dispatched (values, not pointers to live state); the receipt is written once, right after the dispatch decision, with
  the command id, and carries a SHA-256 digest of the snapshot. The digest lets a reader detect that the stored snapshot was changed; it is not a signature, and the store does not prevent a
  rewrite by someone with database access. Receipts are written once: an existing id is never overwritten.
* An action the pipeline proposed itself has no snapshot taken at the time, so its receipt is DERIVED: it is built when read from the
  records the pipeline wrote then (gate decision with its inputs, Safety Supervisor decision, prediction records, command record).
* The lifecycle of a receipt is derived from records written after it (supervisor decisions, the command record and its status history,
  incident transitions, the recovery assessment). States are only set from those records; nothing is inferred from a later state.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Optional

from .incident import S

STAGES = ("observation", "hypothesis", "test", "prediction", "decision", "outcome")
STAGE_KINDS = {
    "observation": ("incident_opened", "mandatory_stop", "c1_unfamiliar_regime"),
    "hypothesis": ("hypotheses",),
    "test": ("test_result", "test_aborted", "diagnostic_run"),
    "prediction": ("c2_ranking", "c2_unsupported", "counterfactual"),
    "decision": ("gate", "supervisor", "analyst_action"),
    "outcome": ("command_failed", "recovery_assessment", "incident_closed"),
}
DECISION_EVENTS = ("APPROVED", "REJECTED_OR_EXPIRED", "ACTION_PROPOSED", "GATE_ACT", "GATE_TEST", "GATE_STOP", "GATE_ESCALATE", "GATE_MORE_DATA")
OUTCOME_EVENTS = ("DISPATCHED", "ACK_OK", "ACK_FAIL", "REC_RECOVERED", "REC_UNRESOLVED", "REC_INCONCLUSIVE", "REC_HUMAN", "CLOSE")
LIFECYCLE = ("PROPOSED", "AWAITING_APPROVAL", "REJECTED", "REFUSED_BY_SAFETY", "ACCEPTED", "ACKNOWLEDGED", "EXECUTED",
             "VERIFICATION_PENDING", "RECOVERED", "RECOVERY_FAILED", "OUTCOME_UNKNOWN")


def _digest(snapshot: Dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(snapshot, sort_keys=True, default=str, separators=(",", ":")).encode()).hexdigest()


def _clean(rec: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if rec is None:
        return None
    return {k: v for k, v in rec.items() if k not in ("_provenance", "session")}


def _incident_ids(orch) -> List[str]:
    seen = []
    for l in orch.log:
        if l.get("kind") == "incident_opened" and l.get("incident") and l["incident"] not in seen:
            seen.append(l["incident"])
    return seen


def _window_at(orch, t: float) -> Optional[Dict[str, Any]]:
    for w, s in zip(reversed(orch.buf), reversed(orch.scores)):
        if w.t <= t + 0.5:
            return {"t": w.t, "rpm": w.rpm, "setpoint": w.setpoint, "current": w.current, "voltage": w.voltage, "housing": w.housing,
                    "vib_rms": w.vib_rms, "valid": w.valid, "c1_status": s.status,
                    "c1_score_over_threshold": (s.value / s.threshold) if (s.value is not None and s.threshold) else None,
                    "c1_anomalous": bool(s.anomalous), "provenance": "SIMULATED"}
    return None


def _label(l: Dict[str, Any]) -> str:
    k = l.get("kind")
    if k == "transition":
        return f"incident {l.get('frm', '').replace('_', ' ')} → {l.get('to', '').replace('_', ' ')} ({l.get('event')})"
    if k == "hypotheses":
        top = (l.get("ranked") or [[None, None]])[0]
        return f"hypotheses ranked: {top[0]} {top[1]:.2f} ({l.get('label')})" if top[0] else "hypotheses ranked"
    if k == "gate":
        return f"decision gate: {l.get('verdict')}" + (f" → test {l['test']}" if l.get("test") else "")
    if k == "supervisor":
        return f"Safety Supervisor {l.get('verdict')}: {l.get('action')}"
    if k == "diagnostic_run":
        return f"diagnostic run {l.get('id')} ({l.get('mode', 'sequence')}: {', '.join(l.get('tests') or [])})"
    if k == "counterfactual":
        return f"counterfactual experiment {l.get('id')} ({', '.join(l.get('candidates') or [])})"
    if k == "analyst_action":
        return f"analyst requested {l.get('action')}" + (f" to {l['target_rpm']:.0f} rpm" if l.get("target_rpm") else "") + f" (receipt {l.get('receipt')})"
    if k == "c2_ranking":
        return f"C2 ranked {len(l.get('ranking') or [])} action(s); lowest risk {l.get('chosen')}"
    return k.replace("_", " ")


def trace(orch, incident: Optional[str] = None) -> Dict[str, Any]:
    ids = _incident_ids(orch)
    inc = incident or (orch.inc.id if orch.inc else (ids[-1] if ids else None))
    if inc is None:
        return {"incident": None, "incidents": ids, "stages": [{"stage": s, "events": [], "reached": False} for s in STAGES],
                "note": "No incident has been opened in this run, so there is nothing to trace yet."}
    if inc not in ids and not (orch.inc and orch.inc.id == inc):
        from .workbench import WorkbenchError
        raise WorkbenchError(f"incident {inc} is not in this run's log", 404)
    events = {s: [] for s in STAGES}
    log_inc = [(i, l) for i, l in enumerate(orch.log) if l.get("incident") == inc]
    t_open = next((l["t"] for _, l in log_inc if l["kind"] == "incident_opened"), None)
    t_close = next((l["t"] for _, l in log_inc if l["kind"] == "incident_closed"), None)
    for i, l in log_inc:
        k = l["kind"]
        stage = next((s for s, ks in STAGE_KINDS.items() if k in ks), None)
        if k == "transition":
            stage = "decision" if l.get("event") in DECISION_EVENTS else "outcome" if l.get("event") in OUTCOME_EVENTS else "observation"
        if k == "supervisor" and l.get("action") == "RUN_TEST":
            stage = "test"
        if stage is None:
            continue
        data = {kk: v for kk, v in l.items() if kk not in ("kind",)}
        if k == "incident_opened":
            data["window"] = _window_at(orch, l["t"])
        events[stage].append({"t": l["t"], "kind": k, "label": _label(l), "source": {"record": "log", "index": i}, "data": data})
    # stored records of the same session, matched by their own keys or time
    for p in orch.records("prediction"):
        t = p.get("predicted_at")
        if t is not None and t_open is not None and t >= t_open and (t_close is None or t <= t_close):
            events["prediction"].append({"t": t, "kind": "prediction", "label": f"C2 prediction for {p.get('action')}"
                                         + (f" to {p['target_rpm']:.0f} rpm" if p.get("action") == "REDUCE_SPEED" else ""),
                                         "source": {"record": "prediction", "key": f"{t:.0f}-{p.get('action')}"}, "data": _clean(p)})
    for c in orch.records("command"):
        if c.get("incident") == inc and c.get("action") not in ("HEARTBEAT",):
            events["outcome"].append({"t": None,                   # command records keep their status history, not times
                                      "kind": "command", "label": f"command #{c['id']} {c['action']}: {c['status']}"
                                      + (" (counts as executed)" if c.get("counts_as_executed") else ""),
                                      "source": {"record": "command", "key": str(c["id"])}, "data": _clean(c)})
    out = orch.get("outcome", inc)
    if out:
        events["outcome"].append({"t": t_close, "kind": "outcome", "label": f"C5 verdict: {out['outcome']}", "source": {"record": "outcome", "key": inc}, "data": _clean(out)})
    for s in STAGES:
        events[s].sort(key=lambda e: (e["t"] is None, e["t"] or 0))
    return {"incident": inc, "incidents": ids, "open": bool(orch.inc and orch.inc.id == inc), "opened_at": t_open, "closed_at": t_close,
            "stages": [{"stage": s, "events": events[s], "reached": bool(events[s])} for s in STAGES],
            "note": "Every event is an existing record of this simulation run; a stage with no record has not happened (or was not recorded)."}


# ------------------------------------------------------------------------------------------------ decision receipts
def _snapshot(orch, chk: Dict[str, Any], plan_features: List[Dict[str, Any]], scenario: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    from dataclasses import asdict
    w = orch.buf[-1] if orch.buf else None
    sc = orch.scores[-1] if orch.scores else None
    post = orch.post
    inc = orch.inc.id if orch.inc else None
    tests = [{"t": l["t"], "test": l.get("test"), "observation": l.get("obs"), "posterior_after": l.get("posterior")}
             for l in orch.log if l.get("kind") == "test_result" and l.get("incident") == inc]
    runs = [l.get("id") for l in orch.log if l.get("kind") == "diagnostic_run" and l.get("incident") == inc]
    cfs = [l.get("id") for l in orch.log if l.get("kind") == "counterfactual" and l.get("incident") == inc]
    return {
        "sim_t": orch.now, "session": orch.session, "investigation": inc, "scenario": scenario,
        "telemetry": None if w is None else {"t": w.t, "rpm": w.rpm, "setpoint": w.setpoint, "current": w.current, "voltage": w.voltage,
                                             "housing": w.housing, "vib_rms": w.vib_rms, "valid": w.valid, "provenance": "SIMULATED",
                                             "age_s": orch.now - w.t},
        "c1": None if sc is None else {"status": sc.status, "anomalous": bool(sc.anomalous),
                                       "score_over_threshold": (sc.value / sc.threshold) if (sc.value is not None and sc.threshold) else None},
        "hypotheses": None if post is None else {"ranked": [(h.value, round(p, 4)) for h, p in post.ranked()], "label": post.label(),
                                                  "n_windows": post.n_windows, "ood": bool(post.ood)},
        "evidence_features": plan_features,
        "c4_tests_in_incident": tests, "diagnostic_runs": runs, "counterfactual_experiments": cfs,
        "prediction": chk.get("prediction_now"), "prediction_basis_supplied": chk.get("basis_supplied"),
        "gate": chk.get("gate"), "supervisor": chk.get("supervisor"),
        "pending_proposal": chk.get("pending"), "awaiting_human_decision": chk.get("awaiting_decision"),
        "stale": chk.get("stale"), "blockers": chk.get("blockers"),
        "versions": {"hypothesis_model": orch.hm.version, "c4_signatures": orch.dm.version, "c2_predictor": orch.pred.version,
                     "c1_detector": getattr(orch.det, "version", None), "gate_config": asdict(orch.gate_cfg), "supervisor_limits": asdict(orch.sup.limits)},
    }


def write_receipt(orch, rid: str, request: Dict[str, Any], decision: str, chk: Dict[str, Any], features, scenario, command_id=None) -> Dict[str, Any]:
    if orch.get("decision_receipt", rid) is not None:
        raise ValueError(f"receipt {rid} already exists; receipts are written once")
    snap = _snapshot(orch, chk, features, scenario)
    body = {"id": rid, "kind": "analyst", "request": request, "decision": decision, "command_id": command_id,
            "snapshot": snap, "snapshot_sha256": _digest(snap), "provenance": "SIMULATED",
            "digest_note": "SHA-256 of the canonical JSON snapshot: detects a changed snapshot, not a signature and not tamper-proof"}
    orch._put("decision_receipt", rid, body, "SIMULATED", orch.now)
    return body


def _lifecycle(orch, inc: Optional[str], cmd: Optional[Dict[str, Any]], t0: float, decision: str, sup_refused: bool) -> List[Dict[str, Any]]:
    """Only states backed by a record, in the order they happened."""
    st: List[Dict[str, Any]] = []
    add = lambda state, t, src, detail="": st.append({"state": state, "t": t, "source": src, "detail": detail})
    log = [(i, l) for i, l in enumerate(orch.log) if l.get("incident") == inc and l.get("t", 0) >= t0 - 0.5] if inc else []
    if decision == "REFUSED":
        if sup_refused:
            add("REFUSED_BY_SAFETY", t0, {"record": "decision_receipt"}, "the Safety Supervisor refused the request")
        else:
            add("REJECTED", t0, {"record": "decision_receipt"}, "refused before dispatch: freshness, gate or approval preconditions not met")
        return st
    if cmd is None:
        return st
    add("ACCEPTED", t0, {"record": "command", "key": str(cmd["id"])}, "allowed by the Safety Supervisor and dispatched to the simulated device")
    hist = [str(h) for h in (cmd.get("history") or [])]            # status names in the order the dispatcher recorded them
    if any(h in ("ACCEPTED", "COMPLETED") for h in hist) or cmd["status"] in ("ACCEPTED", "COMPLETED"):
        add("ACKNOWLEDGED", None, {"record": "command", "key": str(cmd["id"])},
            "the simulated device acknowledged the command" + ("" if cmd["action"] == "STOP" else
            "; it does not report completion for speed commands, so the effect is judged by C5 from the telemetry that follows"))
    if "COMPLETED" in hist or cmd["status"] == "COMPLETED":                 # only a device-reported completion, never an acceptance
        add("EXECUTED", None, {"record": "command", "key": str(cmd["id"])}, "the simulated device reported the command complete")
    if cmd["status"] in ("REJECTED", "ABORTED", "TIMEOUT", "EXPIRED"):
        add("REFUSED_BY_SAFETY" if cmd["status"] == "REJECTED" else "OUTCOME_UNKNOWN", None, {"record": "command", "key": str(cmd["id"])},
            f"the device reported {cmd['status']}{(': ' + cmd['reason']) if cmd.get('reason') else ''}")
        return st
    ver = next(((i, l) for i, l in log if l["kind"] == "transition" and l.get("to") == S.VERIFYING_RECOVERY.value), None)
    if ver:
        add("VERIFICATION_PENDING", ver[1]["t"], {"record": "log", "index": ver[0]}, "collecting fresh windows after the acknowledgement")
    ra = next(((i, l) for i, l in log if l["kind"] == "recovery_assessment"), None)
    if ra:
        o = ra[1].get("outcome")
        state = "RECOVERED" if o == "RECOVERED" else "RECOVERY_FAILED" if o in ("UNRESOLVED", "HUMAN_INSPECTION_REQUIRED") else "OUTCOME_UNKNOWN"
        add(state, ra[1]["t"], {"record": "log", "index": ra[0]}, f"C5 verdict {o}: {', '.join(ra[1].get('reasons') or [])}")
    return st


def _unresolved(lc: List[Dict[str, Any]], decision: str) -> List[str]:
    states = [x["state"] for x in lc]
    if decision == "REFUSED":
        return ["the request was refused; no action was dispatched"]
    out = []
    if "ACKNOWLEDGED" not in states:
        out.append("no device acknowledgement yet")
    if not any(s in states for s in ("RECOVERED", "RECOVERY_FAILED", "OUTCOME_UNKNOWN")):
        out.append("no C5 recovery verdict yet")
    if "RECOVERY_FAILED" in states:
        out.append("recovery failed: human follow-up is required")
    if "OUTCOME_UNKNOWN" in states:
        out.append("the outcome is unknown")
    return out


def _cmd(orch, cid) -> Optional[Dict[str, Any]]:
    return _clean(orch.get("command", str(cid))) if cid is not None else None


def receipt(orch, rid: str) -> Dict[str, Any]:
    from .workbench import WorkbenchError
    if rid.startswith("RP-"):
        return _derived(orch, rid)
    r = orch.get("decision_receipt", rid)
    if r is None:
        raise WorkbenchError(f"receipt {rid} was not found in this run", 404)
    r = _clean(r)
    snap = r["snapshot"]
    cmd = _cmd(orch, r.get("command_id"))
    sup_refused = bool(snap.get("supervisor") and snap["supervisor"].get("verdict") == "REJECT")
    lc = [{"state": "PROPOSED", "t": snap["sim_t"], "source": {"record": "decision_receipt", "key": rid}, "detail": "analyst selection submitted"}]
    if snap.get("awaiting_human_decision"):
        lc.append({"state": "AWAITING_APPROVAL", "t": snap["sim_t"], "source": {"record": "decision_receipt", "key": rid},
                   "detail": "the pipeline was holding an action for a human decision; the analyst's request is that decision"})
    lc += _lifecycle(orch, snap.get("investigation"), cmd, snap["sim_t"], r["decision"], sup_refused)
    return {**r, "digest_valid": _digest(snap) == r["snapshot_sha256"], "command": cmd, "lifecycle": lc, "unresolved": _unresolved(lc, r["decision"])}


def _derived(orch, rid: str) -> Dict[str, Any]:
    """A receipt for an action the pipeline itself proposed, rebuilt from the records written at the time."""
    from .workbench import WorkbenchError
    try:
        cid = int(rid[3:])
    except ValueError:
        raise WorkbenchError(f"receipt {rid} was not found in this run", 404)
    cmd = _cmd(orch, cid)
    if cmd is None or cmd.get("action") not in ("REDUCE_SPEED", "STOP"):
        raise WorkbenchError(f"receipt {rid} was not found in this run", 404)
    inc = cmd.get("incident")
    decisions = [d for d in orch.records("decision")]
    gate = None
    for i, l in enumerate(orch.log):
        if l.get("incident") == inc and l.get("kind") == "gate":
            gate = (i, l)
    gate_rec = _clean(orch.get("decision", f"gate-{gate[1]['t']:.0f}")) if gate else None
    sups = [d for d in decisions if (d.get("proposal") or {}).get("action") == cmd["action"] and (d.get("proposal") or {}).get("incident_id") == inc]
    preds = [_clean(p) for p in orch.records("prediction") if gate and p.get("predicted_at") is not None and p["predicted_at"] >= gate[1]["t"] - 0.5]
    t0 = gate[1]["t"] if gate else 0.0
    deferred = any(d.get("verdict") == "DEFER" for d in sups)
    lc = [{"state": "PROPOSED", "t": t0, "source": {"record": "decision", "key": f"gate-{t0:.0f}"} if gate else {"record": "log"},
           "detail": "proposed by the pipeline after the gate reached ACT and C2 ranked the candidates"}]
    if deferred:
        lc.append({"state": "AWAITING_APPROVAL", "t": t0, "source": {"record": "decision"}, "detail": "the Safety Supervisor deferred it for a human decision"})
    lc += _lifecycle(orch, inc, cmd, t0, "ACCEPTED", False)
    snap = {"investigation": inc, "gate": gate_rec, "supervisor_decisions": sups, "predictions": preds, "command": cmd}
    prop = (sups[-1].get("proposal") or {}) if sups else {}
    who = prop.get("requested_by") or ("a person (STOP request)" if prop.get("source") == "human" else "pipeline")
    return {"id": rid, "kind": "pipeline", "derived": True, "request": {"action": cmd["action"], "target_rpm": (cmd.get("params") or {}).get("rpm"),
            "requested_by": who}, "decision": "ACCEPTED", "snapshot": snap, "snapshot_sha256": _digest(snap), "digest_valid": True,
            "command": cmd, "lifecycle": lc, "unresolved": _unresolved(lc, "ACCEPTED"), "provenance": "SIMULATED",
            "digest_note": "derived when read from the pipeline's own stored records; no snapshot was taken at decision time"}


def pending_receipt(orch) -> Optional[Dict[str, Any]]:
    """The action the pipeline is holding for approval, with a re-evaluation now: is what it was proposed on still current?"""
    from .gate import decide
    if orch.pending is None or orch.inc is None or orch.inc.state != S.AWAITING_APPROVAL:
        return None
    gate_log = next((l for l in reversed(orch.log) if l.get("incident") == orch.inc.id and l.get("kind") == "gate"), None)
    gi, _ = orch.gate_inputs()
    now = decide(gi, orch.gate_cfg)
    age = orch.now - (gate_log["t"] if gate_log else orch.now)
    from .workbench import MAX_PREDICTION_AGE_S
    issues = []
    if gate_log and now.verdict.value != gate_log.get("verdict"):
        issues.append(f"the gate now says {now.verdict.value} (it said {gate_log.get('verdict')} when the action was proposed)")
    if age > MAX_PREDICTION_AGE_S:
        issues.append(f"proposed {age:.0f} s of simulation time ago (limit {MAX_PREDICTION_AGE_S:.0f} s for a prediction)")
    return {"id": "pending", "kind": "pipeline", "state": "AWAITING_APPROVAL", "action": orch.pending.action.value, "params": orch.pending.params,
            "rationale": orch.pending.rationale, "proposed_at": gate_log["t"] if gate_log else None, "gate_then": gate_log and gate_log.get("verdict"),
            "gate_now": {"verdict": now.verdict.value, "reason": now.reason}, "still_valid": not issues, "issues": issues,
            "note": ("Approving through /approvals/approve re-runs the Safety Supervisor on the current state; it does not re-run the gate. "
                     "The analyst request path re-runs both and is refused when this action is no longer valid.")}


def receipts(orch) -> Dict[str, Any]:
    rows = []
    for r in orch.records("decision_receipt"):
        rows.append({"id": r["id"], "kind": "analyst", "t": r["snapshot"]["sim_t"], "action": r["request"]["action"],
                     "target_rpm": r["request"].get("target_rpm"), "decision": r["decision"], "investigation": r["snapshot"].get("investigation")})
    analyst_cmds = {r.get("command_id") for r in orch.records("decision_receipt")}
    for c in orch.records("command"):
        if c.get("action") in ("REDUCE_SPEED", "STOP") and c["id"] not in analyst_cmds:
            rows.append({"id": f"RP-{c['id']}", "kind": "pipeline", "t": None, "action": c["action"], "target_rpm": (c.get("params") or {}).get("rpm"),
                         "decision": "ACCEPTED", "investigation": c.get("incident"), "status": c.get("status")})
    return {"receipts": rows, "pending": pending_receipt(orch)}
