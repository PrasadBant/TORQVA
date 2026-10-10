"""Orchestrator: wires ingestion -> C1 -> hypotheses -> C3 gate -> (C4 test | C2 compare) -> Safety Supervisor ->
dispatcher -> ack -> C5 verification -> case record -> (C6 eligibility).

One simulated second per `step()`. The orchestrator never sends anything to the device except through
`SafetySupervisor.check()` -> `CommandDispatcher.dispatch()`. All records carry provenance.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from typing import Dict, List, Optional, Sequence

import numpy as np

from .c1_robust import AdaptiveBaselineDetector, CoherenceConfig, ReferenceConfig, ReferenceRegistry, assess_session
from .detection import BaselineDetector, ThermalTracker
from .diagnostics import DiagnosticsModel, obs_t1, obs_t3, obs_t4
from .dispatch import CommandDispatcher, CommandRecord
from .gate import GateConfig, GateInputs, TestOption, decide
from .hypotheses import HypothesisModel, Posterior
from .incident import E, Incident, S
from .learning import CaseRecord, LabelSource
from .prediction import InterventionPredictor, StateSummary
from .recovery import RecoveryAssessment, assess
from .schemas import (ActionType, CommandStatus, Connection, DecisionVerdict, DeviceSafetyState, GateVerdict, Mode,
                      ProposalSource, ProposedAction, Provenance, RecoveryOutcome, Role)
from .simdevice import SimDevice
from .store import Store
from .supervisor import SafetySupervisor, SupervisorContext, mandatory_stop_reasons

TEST_PARAMS = {"T1": {"test": 1, "fraction": 0.7, "hold_ms": 40000}, "T3": {"test": 3, "duration_ms": 300000},
               "T4": {"test": 4}}


@dataclass
class PipelineConfig:
    confirm_windows: int = 10
    clear_windows: int = 3
    posterior_windows: int = 15
    min_evidence_windows: int = 8
    more_data_wait_s: int = 30
    verify_timeout_s: int = 600
    reduce_fraction: float = 0.7
    allowed_tests: Sequence[str] = ("T1", "T3")
    use_ground_truth_labels: bool = False        # lab mode: FaultInjection record supplies the label
    max_cmd_failures: int = 3
    # Phase 8 (opt-in, simulation-validated only): after this many steady windows AND an explicit operator attestation that the
    # warm-up was healthy, propose a validated, reversible per-session reference. 0 = off (original behaviour).
    adaptive_warmup_s: int = 0
    reference_coh_tol: float = 0.10


class Orchestrator:
    def __init__(self, device: SimDevice, det: BaselineDetector, tt: ThermalTracker, hm: HypothesisModel,
                 dm: DiagnosticsModel, pred: InterventionPredictor, sup: SafetySupervisor, store: Store,
                 cfg: Optional[PipelineConfig] = None, mode: Mode = Mode.SIMULATION, role: Role = Role.OPERATOR,
                 gate_cfg: GateConfig = GateConfig(), session: str = "S0"):
        self.session = session
        self.dev, self.det, self.tt, self.hm, self.dm, self.pred = device, det, tt, hm, dm, pred
        self.sup, self.store, self.cfg, self.mode, self.role, self.gate_cfg = sup, store, cfg or PipelineConfig(), mode, role, gate_cfg
        self.disp = CommandDispatcher(device.send_line, device.key)
        self.heartbeat_enabled = True
        self.buf: List = []                  # all windows (scored in place)
        self.scores: List = []
        self.inc: Optional[Incident] = None
        self.incidents_done: List[Incident] = []
        self.dismissed: List[Incident] = []          # suspected but not confirmed (logged, not incidents)
        self.log: List[Dict] = []
        self.cases: List[CaseRecord] = []
        self.post: Optional[Posterior] = None
        self.post_override = False
        self.anom_run = self.clear_run = 0
        self.cmd: Optional[CommandRecord] = None
        self.cmd_failures = 0
        self.test_running: Optional[str] = None
        self.test_start_idx = 0
        self.wait_until = 0.0
        self.pending: Optional[ProposedAction] = None
        self.assessment: Optional[RecoveryAssessment] = None
        self.last_unresolved = False
        self.verify_started = 0.0
        self.last_gate = None
        self.last_comparison = None
        self.last_status = "OK"
        self.tt.reset(device.sim.housing)
        self.refs = ReferenceRegistry(audit=lambda e: self._log("c1_reference", **e))
        self._warmup_attested = False
        self._ref_attempted = False
        self._hold_until: Optional[float] = None         # Phase 9: operator-declared, time-bounded supervised warm-up
        self.hold_info: Optional[Dict] = None

    # ---------------- persistence (all records are scoped by session: ids restart per run) ----------------
    def _put(self, kind: str, id, body: Dict, provenance: str, ts: Optional[float] = None) -> None:
        self.store.put(kind, f"{self.session}/{id}", {**body, "session": self.session}, provenance, ts)

    def get(self, kind: str, id):
        return self.store.get(kind, f"{self.session}/{id}")

    def records(self, kind: str) -> List[Dict]:
        return [d for d in self.store.list(kind) if d.get("session") == self.session]

    # ---------------- logging ----------------
    @property
    def now(self) -> float:
        return self.dev.sim.t

    def _log(self, kind: str, **detail) -> None:
        rec = {"t": self.now, "kind": kind, "incident": self.inc.id if self.inc else None, **detail}
        self.log.append(rec)
        self.store.audit(kind, "orchestrator", rec, ts=self.now)

    def _fire(self, ev: E) -> S:
        before = self.inc.state
        after = self.inc.fire(ev)
        self._log("transition", frm=before.value, event=ev.value, to=after.value)
        if self.inc:
            self._put("incident", self.inc.id, {"state": self.inc.state.value, "history":
                           [(a.value, b.value, c.value) for a, b, c in self.inc.history]}, Provenance.SIMULATED.value, self.now)
        return after

    # ---------------- supervisor context ----------------
    def _ctx(self) -> SupervisorContext:
        w = self.buf[-1] if self.buf else None
        return SupervisorContext(
            mode=self.mode, hardware_control_enabled=self.dev.control_enabled, connection=Connection.CONNECTED,
            device_state=DeviceSafetyState.EMERGENCY_STOP if self.dev.estop else DeviceSafetyState.OK,
            telemetry_age_s=0.0, sensors_valid=bool(w and w.valid), motor_running=self.dev.sim.setpoint > 0,
            current_setpoint_rpm=self.dev.sim.setpoint, test_active=self.test_running is not None,
            housing_c=w.housing if w else None, current_a=w.current if w else None, voltage_v=w.voltage if (w and w.driven) else None,
            vib_rms_g=None, tests_run_in_incident=self.inc.tests_run if self.inc else 0,
            max_tests_per_incident=self.inc.max_tests if self.inc else 2)

    # ---------------- command path (ONLY via supervisor) ----------------
    def _propose(self, p: ProposedAction) -> Optional[CommandRecord]:
        d = self.sup.check(p, self._ctx())
        self._put("decision", f"{self.now:.0f}-{p.action.value}-{len(self.log)}",
                       {"proposal": p.model_dump(mode="json"), "verdict": d.verdict.value, "reasons": d.reasons,
                        "mandatory_stop": d.mandatory_stop}, Provenance.SIMULATED.value, self.now)
        self._log("supervisor", action=p.action.value, verdict=d.verdict.value, reasons=d.reasons)
        if d.verdict == DecisionVerdict.ALLOW and d.approved is not None and p.action != ActionType.CONTINUE_MONITORING:
            rec = self.disp.dispatch(d.approved, self.now)
            self._persist_cmd(rec)
            return rec
        self._last_decision = d
        return None

    def _persist_cmd(self, rec: CommandRecord) -> None:
        self._put("command", str(rec.id), {"id": rec.id, "action": rec.action.value, "params": rec.params, "status": rec.status.value,
                       "reason": rec.reason, "history": rec.history, "incident": rec.incident_id,
                       "counts_as_executed": rec.counts_as_executed()}, Provenance.SIMULATED.value, self.now)

    def approve(self, role: Role = Role.OPERATOR) -> None:
        """Human approval of a deferred proposal (hardware mode / strict simulation)."""
        if self.pending is None:
            return
        p = self.pending.model_copy(update={"human_approved": True, "role": role})
        self.pending = None
        self._execute_proposal(p)

    def reject(self) -> None:
        if self.pending is None:
            return
        self.pending = None
        if self.inc.state == S.AWAITING_APPROVAL:
            self._fire(E.REJECTED_OR_EXPIRED); self._fire(E.ACTION_INCONCLUSIVE)
        elif self.inc.state == S.DIAGNOSTIC_PROPOSED:
            self._fire(E.TEST_REJECTED)

    def _execute_proposal(self, p: ProposedAction) -> None:
        st = self.inc.state
        rec = self._propose(p)
        if rec is None:
            d = self._last_decision
            if d.verdict == DecisionVerdict.DEFER:
                self.pending = p                       # wait for approve()/reject()
                return
            # REJECT: never silently continue. Record and escalate (action) / drop test.
            if st == S.AWAITING_APPROVAL:
                self._fire(E.REJECTED_OR_EXPIRED); self._fire(E.ACTION_INCONCLUSIVE); self._fire(E.GATE_ESCALATE)
            elif st == S.DIAGNOSTIC_PROPOSED:
                self._fire(E.TEST_REJECTED)
            return
        self.cmd = rec
        if st == S.AWAITING_APPROVAL:
            self._fire(E.APPROVED)
            self._fire(E.DISPATCHED)
        elif st == S.DIAGNOSTIC_PROPOSED:
            self._fire(E.TEST_APPROVED)
            self.test_running = self._test_name(p)
            self.test_start_idx = len(self.buf)

    @staticmethod
    def _test_name(p: ProposedAction) -> str:
        return {1: "T1", 3: "T3", 4: "T4"}[int(p.params["test"])]

    # ---------------- main step ----------------
    def step(self) -> None:
        if self.heartbeat_enabled:
            hb = self.sup.check(ProposedAction(action=ActionType.HEARTBEAT, source=ProposalSource.SYSTEM), self._ctx())
            if hb.approved:
                self.disp.dispatch(hb.approved, self.now)
        for w in self.dev.advance(1):
            self._ingest(w)
        for line in self.dev.poll_lines():
            m = json.loads(line)
            if m.get("t") == "ack":
                rec = self.disp.on_ack(m, self.now)
                if rec and rec.action != ActionType.HEARTBEAT:
                    self._persist_cmd(rec)
        for rec in self.disp.poll(self.now):
            if rec.action != ActionType.HEARTBEAT:
                self._persist_cmd(rec)
        self._advance_incident()

    def _ingest(self, w) -> None:
        if len(self.buf) == 0:
            self.tt.reset(w.housing)
        self.tt.update(w)
        sc = self.det.score(w)
        if self._warmup_pending() or self.hold_active():
            # Attested healthy warm-up (opt-in): scores are not yet evidence. Hard limits are NOT affected: see _advance_incident.
            sc = replace(sc, anomalous=False, status="TRANSIENT")
        self.buf.append(w)
        self._maybe_propose_reference()
        self.scores.append(sc)
        if sc.status != "TRANSIENT":
            self.last_status = sc.status
        if sc.status == "TRANSIENT":
            pass                                         # neither evidence for nor against an anomaly
        elif sc.value is not None and sc.anomalous and w.valid:
            self.anom_run += 1; self.clear_run = 0
        else:
            self.clear_run += 1
            if self.clear_run >= self.cfg.clear_windows:
                self.anom_run = 0

    # ---------------- Phase 8: session reference (opt-in) ----------------
    def attest_healthy_warmup(self, by: str = "operator") -> None:
        """Human attestation that the motor is healthy during the warm-up. Without it no reference is ever proposed."""
        self._warmup_attested = True
        self._log("c1_warmup_attested", by=by)

    # --- Phase 9: supervised warm-up hold (operator action, audited, bounded). It defers only SCORE-triggered incident opening so that a
    # healthy-but-shifted motor can be observed for attestation; mandatory-stop conditions open an incident immediately, exactly as before.
    MAX_HOLD_S = 300.0

    def begin_supervised_warmup(self, by: str, seconds: float = 90.0) -> Dict:
        if not (0 < seconds <= self.MAX_HOLD_S):
            raise ValueError(f"hold must be in (0, {self.MAX_HOLD_S:.0f}] simulated seconds")
        if self.inc is not None:
            raise ValueError("cannot start a supervised warm-up while an incident is open")
        self._hold_until = self.now + seconds
        self.hold_info = {"by": by, "from": self.now, "until": self._hold_until, "seconds": seconds}
        self._log("c1_warmup_hold_started", by=by, seconds=seconds, until=self._hold_until)
        return dict(self.hold_info)

    def end_supervised_warmup(self, by: str) -> None:
        if self._hold_until is not None:
            self._hold_until = None
            self._log("c1_warmup_hold_ended", by=by)

    def hold_active(self) -> bool:
        return self._hold_until is not None and self.now < self._hold_until

    def _warmup_pending(self) -> bool:
        # Bounded: if no steady warm-up materialises within 3x the requested length the attempt is abandoned (see below), so score-based
        # detection can never stay suppressed indefinitely.
        return bool(self.cfg.adaptive_warmup_s and self._warmup_attested and not self._ref_attempted
                    and isinstance(self.det, AdaptiveBaselineDetector))

    def _maybe_propose_reference(self) -> None:
        n = self.cfg.adaptive_warmup_s
        if not n or self._ref_attempted or not isinstance(self.det, AdaptiveBaselineDetector) or not self._warmup_attested:
            return
        steady = [x for x in self.buf if self.det.steady(x)]
        if len(steady) < n:
            if len(self.buf) >= 3 * n:
                self._ref_attempted = True               # abandon: scoring resumes unadapted
                self._log("c1_reference", event="abandoned", version=None, reason="no_steady_warmup_within_limit", metrics={})
            return
        self._ref_attempted = True                       # one attempt per session: never retried inside an incident
        self.refs.propose(self.det, steady[-n:], trusted=True, incident_open=self.inc is not None,
                          in_cooldown=self.cmd is not None, cfg=ReferenceConfig(coh_tol=self.cfg.reference_coh_tol))
        self.det.reference = self.refs.active

    def rollback_reference(self) -> None:
        """Return to the last known-good reference, or to the unadapted trained baseline."""
        self.refs.rollback()
        self.det.reference = self.refs.active

    def regime_assessment(self, last_n: int = 40):
        """HEALTHY / FAULT / UNFAMILIAR verdict over the most recent windows (None if the detector is the plain control)."""
        if not isinstance(self.det, AdaptiveBaselineDetector) or not self.buf:
            return None
        return assess_session(self.det, self.buf[-last_n:], ref=self.det.reference, regime_aware=True,
                              cfg=CoherenceConfig(coh_tol=self.cfg.reference_coh_tol))

    # ---------------- incident handling ----------------
    def _new_incident(self) -> None:
        self.inc = Incident(f"INC-{len(self.incidents_done) + len(self.dismissed) + 1:03d}")
        self.cmd = None; self.post = None; self.post_override = False; self.cmd_failures = 0
        self.test_running = None; self.assessment = None
        self._log("incident_opened")

    def _close(self) -> None:
        self.incidents_done.append(self.inc)
        self._log("incident_closed", final=self.inc.state.value)
        self.inc = None
        self.anom_run = 0

    def _advance_incident(self) -> None:
        if self.inc is None:
            # While a warm-up is pending the score trigger is off; a mandatory-stop condition must still open an incident at once.
            hard = (self._warmup_pending() or self.hold_active()) and bool(mandatory_stop_reasons(self._ctx(), self.sup.limits))
            if (self.anom_run >= 1 or hard) and not self.dev.estop:
                self._new_incident()
                self._fire(E.SCORE_HIGH)
            elif self.dev.estop:
                self._new_incident(); self._fire(E.DEVICE_ESTOP)
            return
        inc = self.inc
        # Device-reported emergency stop wins over backend belief.
        if self.dev.estop and inc.state not in (S.EMERGENCY_STOP, S.CLOSED):
            if inc.state in (S.VERIFYING_RECOVERY, S.AWAITING_ACK, S.COMMAND_SENT) and self.cmd and \
               self.cmd.action == ActionType.STOP:
                pass     # a commanded stop that coincides with a trip is still a stop; keep verifying safety
            else:
                self._fire(E.DEVICE_ESTOP); return
        # Mandatory-stop rules: evaluated every step, independent of any model, never delayed.
        mand = mandatory_stop_reasons(self._ctx(), self.sup.limits)
        if mand and inc.state not in (S.COMMAND_SENT, S.AWAITING_ACK, S.VERIFYING_RECOVERY, S.EMERGENCY_STOP,
                                      S.RECOVERED, S.UNRESOLVED, S.INCONCLUSIVE, S.HUMAN_INSPECTION_REQUIRED, S.CLOSED) \
           and self.dev.sim.setpoint > 0:
            self._log("mandatory_stop", reasons=mand)
            self._fire(E.MANDATORY_STOP)
            self._send_stop("mandatory_stop:" + ",".join(mand))
            return

        h = getattr(self, f"_on_{inc.state.value.lower()}", None)
        if h:
            h()

    def _send_stop(self, why: str) -> None:
        rec = self._propose(ProposedAction(action=ActionType.STOP, source=ProposalSource.SYSTEM, rationale=why,
                                           incident_id=self.inc.id))
        self.cmd = rec
        if rec is not None and self.inc.state == S.COMMAND_SENT:
            self._fire(E.DISPATCHED)

    # --- states ---
    def _on_anomaly_suspected(self) -> None:
        if self.anom_run >= self.cfg.confirm_windows:
            self._fire(E.PERSISTS)
        elif self.clear_run >= self.cfg.clear_windows:
            self._fire(E.NOT_CONFIRMED)
            self.dismissed.append(self.inc); self.inc = None

    def _on_unfamiliar_operating_point(self) -> None:
        pass

    def _evidence(self) -> List:
        """Signed z-vectors of recent ANOMALOUS windows. Hypothesis ranking is conditional on an anomaly, so healthy
        windows from before onset are not evidence for any fault class."""
        recent = [s for s in self.scores[-3 * self.cfg.posterior_windows:] if s.z is not None and s.anomalous]
        return [s.z for s in recent[-self.cfg.posterior_windows:]]

    def _on_investigating(self) -> None:
        n = self.cfg.min_evidence_windows
        if self.post_override:
            self.post_override = False
            self._fire(E.HYPOTHESES_RANKED)
            return
        zs = self._evidence()
        if len(zs) < n:
            return
        self.post = self.hm.posterior(zs)
        self._log("hypotheses", ranked=[(h.value, round(p, 4)) for h, p in self.post.ranked()], label=self.post.label(),
                  n_windows=self.post.n_windows)
        self._fire(E.HYPOTHESES_RANKED)

    def _state_summary(self) -> StateSummary:
        return StateSummary.from_windows(self.buf)

    def _on_gate_evaluation(self) -> None:
        ctx = self._ctx()
        st = self._state_summary()
        cont = self.pred.predict(self.post, st, "CONTINUE_MONITORING")
        trust = self.pred.trust(self.post, op_familiar=self.last_status in ("OK", "INTERPOLATED", "FROZEN"))
        best = None
        allowed = []
        for t in self.cfg.allowed_tests:
            d = self.sup.check(ProposedAction(action=ActionType.RUN_TEST, params=dict(TEST_PARAMS[t]),
                                              source=ProposalSource.GATE, role=self.role), ctx)
            if d.verdict in (DecisionVerdict.ALLOW, DecisionVerdict.DEFER):
                allowed.append(t)
        bt = self.dm.best_test(self.post, allowed) if allowed else None
        if bt:
            best = TestOption(bt[0], bt[1], True)
        recent_valid = all(w.valid for w in self.buf[-10:])
        gi = GateInputs(mandatory_stop=bool(mandatory_stop_reasons(ctx, self.sup.limits)), risk=cont.risk, data_ok=recent_valid,
                        sensor_unreliable=not recent_valid, posterior=self.post, c2_trusted=trust.trusted, best_test=best,
                        data_requests=self.inc.data_requests, max_data_requests=self.inc.max_data_requests,
                        tests_run=self.inc.tests_run, max_tests=self.inc.max_tests,
                        op_point_familiar=self.last_status in ("OK", "INTERPOLATED", "FROZEN"))
        dec = decide(gi, self.gate_cfg)
        self.last_gate = dec
        self._put("decision", f"gate-{self.now:.0f}", {"verdict": dec.verdict.value, "reason": dec.reason, "test": dec.test,
                       "inputs": dec.inputs, "c2_trust": trust.reasons}, Provenance.SIMULATED.value, self.now)
        self._log("gate", verdict=dec.verdict.value, reason=dec.reason, test=dec.test)
        v = dec.verdict
        if v == GateVerdict.ACT:
            self._fire(E.GATE_ACT)
        elif v == GateVerdict.RUN_DIAGNOSTIC_TEST:
            self._fire(E.GATE_TEST)
            self.pending = None
            self._execute_proposal(ProposedAction(action=ActionType.RUN_TEST, params=dict(TEST_PARAMS[dec.test]),
                                                  source=ProposalSource.GATE, role=self.role, incident_id=self.inc.id,
                                                  rationale=dec.reason))
        elif v == GateVerdict.REQUEST_MORE_DATA:
            self._fire(E.GATE_MORE_DATA)
            if self.inc.state == S.AWAITING_MORE_DATA:
                self.wait_until = self.now + self.cfg.more_data_wait_s
        elif v == GateVerdict.SAFE_STOP:
            self._fire(E.GATE_STOP)
            self._send_stop(dec.reason)
        else:   # ESCALATE_HUMAN, SENSOR_UNRELIABLE
            self._fire(E.GATE_ESCALATE)

    def _on_awaiting_more_data(self) -> None:
        if self.now >= self.wait_until:
            zs = self._evidence()
            if len(zs) >= self.cfg.min_evidence_windows and not self.post_override:
                self.post = self.hm.posterior(zs)
            self._fire(E.MORE_DATA_READY)

    def _on_action_evaluation(self) -> None:
        st = self._state_summary()
        sp = self.dev.sim.setpoint
        ranked = self.pred.compare(self.post, st, self.cfg.reduce_fraction * sp)
        self.last_comparison = ranked
        for p in ranked:
            self._put("prediction", f"{self.now:.0f}-{p.action}", {
                "action": p.action, "target_rpm": p.target_rpm, "risk": p.risk, "risk_by_signal": p.risk_by_signal,
                "mean_at_30_60_120": {s: [float(p.mean[s][i - 1]) for i in (30, 60, 120)] for s in p.mean},
                "lo_120": {s: float(p.lo[s][-1]) for s in p.lo}, "hi_120": {s: float(p.hi[s][-1]) for s in p.hi},
                "validated_by_experiments": self.pred.validated_by_experiments}, "PREDICTED", self.now)
        choice = next((p for p in ranked if p.action != "CONTINUE_MONITORING"), None)
        self._log("c2_ranking", ranking=[(p.action, round(p.risk, 3)) for p in ranked], chosen=choice.action if choice else None)
        if choice is None:
            self._fire(E.ACTION_INCONCLUSIVE)
            return
        action = ActionType.REDUCE_SPEED if choice.action == "REDUCE_SPEED" else ActionType.STOP
        params = {"rpm": choice.target_rpm} if action == ActionType.REDUCE_SPEED else {}
        self._fire(E.ACTION_PROPOSED)
        self._execute_proposal(ProposedAction(action=action, params=params, source=ProposalSource.GATE, role=self.role,
                                              incident_id=self.inc.id,
                                              rationale=f"C2 ranks {choice.action} first (risk {choice.risk:.2f})"))

    def _on_awaiting_approval(self) -> None:
        pass                                           # waits for approve()/reject()

    def _on_diagnostic_proposed(self) -> None:
        pass

    def _on_diagnostic_running(self) -> None:
        rec = self.cmd
        if rec is None:
            return
        if rec.status == CommandStatus.COMPLETED:
            name = self.test_running
            obs = self._test_observation(name)
            self.post = self.dm.update(self.post, name, obs)
            self._log("test_result", test=name, obs=obs.tolist(), posterior=[(h.value, round(p, 4)) for h, p in self.post.ranked()])
            self.test_running = None
            self.post_override = True
            self._fire(E.TEST_COMPLETED)
        elif rec.status in (CommandStatus.REJECTED, CommandStatus.ABORTED, CommandStatus.TIMEOUT, CommandStatus.EXPIRED):
            self._log("test_aborted", status=rec.status.value, reason=rec.reason)
            self.test_running = None
            self._fire(E.TEST_ABORTED)
            self.wait_until = self.now + 5

    def _test_observation(self, name: str) -> np.ndarray:
        ws = self.buf
        i = self.test_start_idx
        if name == "T1":
            return obs_t1(ws[max(0, i - 20):i - 5], ws[-15:])
        if name == "T3":
            return obs_t3(ws[i:], _tracker_copy(self.tt))
        return obs_t4(ws[i:])

    def _on_diagnostic_aborted(self) -> None:
        if self.now >= self.wait_until:
            self._fire(E.MORE_DATA_READY)

    def _on_command_sent(self) -> None:
        if self.cmd is not None and self.inc.state == S.COMMAND_SENT:
            self._fire(E.DISPATCHED)

    def _on_awaiting_ack(self) -> None:
        rec = self.cmd
        if rec is None:
            return
        if rec.status in (CommandStatus.ACCEPTED, CommandStatus.COMPLETED):
            self.verify_started = self.now
            self._fire(E.ACK_OK)
        elif rec.status in (CommandStatus.REJECTED, CommandStatus.ABORTED, CommandStatus.TIMEOUT, CommandStatus.EXPIRED):
            self.cmd_failures += 1
            self._log("command_failed", status=rec.status.value, reason=rec.reason)
            self._fire(E.ACK_FAIL)

    def _on_command_failed(self) -> None:
        self._fire(E.MORE_DATA_READY)                # back to the gate: the failed command is NOT a recovery path

    def _on_verifying_recovery(self) -> None:
        if int(self.now - self.verify_started) % 10 != 0:
            return
        post_ack = [w for w in self.buf if w.t >= self.cmd.acked_at]
        a = assess(self.cmd, post_ack, self.det, self.tt, self.now, previous_unresolved=self.last_unresolved)
        self.assessment = a
        r = a.outcome
        if r == RecoveryOutcome.INCONCLUSIVE and not a.reasons[0].startswith("stopped_condition") \
           and self.now - self.verify_started < self.cfg.verify_timeout_s:
            return                                  # keep waiting for a fresh window
        self._log("recovery_assessment", outcome=r.value, reasons=a.reasons, criteria=a.criteria)
        self.last_unresolved = (r == RecoveryOutcome.UNRESOLVED)
        self._fire({RecoveryOutcome.RECOVERED: E.REC_RECOVERED, RecoveryOutcome.UNRESOLVED: E.REC_UNRESOLVED,
                    RecoveryOutcome.INCONCLUSIVE: E.REC_INCONCLUSIVE,
                    RecoveryOutcome.HUMAN_INSPECTION_REQUIRED: E.REC_HUMAN}[r])
        self._record_outcome(a)
        self._fire(E.CLOSE)
        self._close()

    def _on_human_inspection_required(self) -> None:
        pass                                        # waits for a human; CLOSE is a human action

    def _on_emergency_stop(self) -> None:
        pass

    def human_close(self) -> None:
        if self.inc and self.inc.state == S.HUMAN_INSPECTION_REQUIRED:
            self._fire(E.CLOSE); self._close()

    # ---------------- outcome + learning dataset ----------------
    def _record_outcome(self, a: RecoveryAssessment) -> None:
        cmd = self.cmd
        executed = bool(cmd and cmd.counts_as_executed())
        out = {"incident": self.inc.id, "outcome": a.outcome.value, "reasons": a.reasons, "criteria": a.criteria,
               "observed": a.observed, "n_fresh": a.n_fresh, "command": cmd.id if cmd else None,
               "command_executed": executed, "action": cmd.action.value if cmd else None,
               "predicted_top": self.last_comparison[0].action if self.last_comparison else None}
        self._put("outcome", self.inc.id, out, Provenance.SIMULATED.value, self.now)
        if self.post is None or a.outcome not in (RecoveryOutcome.RECOVERED, RecoveryOutcome.UNRESOLVED):
            return
        zs = self._evidence()
        if self.cfg.use_ground_truth_labels and self.dev.sim.truth.fault is not None:
            label, src = self.dev.sim.truth.fault, LabelSource.LAB_GROUND_TRUTH
        else:
            label, src = self.post.top, LabelSource.SYSTEM
        case = CaseRecord(self.inc.id, Provenance.SIMULATED, label, src, a.outcome, executed,
                          all(w.valid for w in self.buf[-30:]), zs)
        self.cases.append(case)
        self._put("case", case.id, {"label": label.value, "label_source": src.value, "outcome": a.outcome.value,
                       "executed": executed}, Provenance.SIMULATED.value, self.now)


def _tracker_copy(tt: ThermalTracker) -> ThermalTracker:
    c = ThermalTracker()
    c.a, c.b = tt.a, tt.b
    return c
