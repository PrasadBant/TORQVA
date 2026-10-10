"""SimulationService: owns a simulated motor + the TORQVA orchestrator for the API. SIMULATION mode only.

Every datum served from here is provenance SIMULATED; the API adds that tag and the UI must show the banner.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .evaluation import build_models
from .pipeline import Orchestrator, PipelineConfig
from .schemas import Hypothesis, Mode, Role
from .sim import MotorSim
from .simdevice import SimDevice
from .store import Store
from .supervisor import SafetySupervisor, SupervisorLimits

DEFAULT_LIMITS = SupervisorLimits(vib_rms_stop_g=2.0, max_rpm=3000.0)


class SimulationService:
    def __init__(self, store: Optional[Store] = None):
        self.store = store or Store()
        self._models = None
        self.orch: Optional[Orchestrator] = None
        self.scenario: Dict[str, Any] = {}
        self.running = False
        self._n = 0

    def _ensure_models(self):
        if self._models is None:
            self._models = build_models()
        return self._models

    # ---------------- lifecycle ----------------
    def start(self, fault: Optional[str], severity: float, clears_below_rpm: Optional[float], seed: int,
              setpoint_rpm: float, inject_after_s: int, hardware_like_approval: bool = False) -> Dict[str, Any]:
        det, tt, hm, dm, pred, sizes = self._ensure_models()
        self._n += 1
        sim = MotorSim(seed)
        dev = SimDevice(sim)
        lim = DEFAULT_LIMITS
        if hardware_like_approval:
            from dataclasses import replace
            lim = replace(lim, auto_approve_in_simulation=False)    # exercise the human-approval path in the UI
        self.orch = Orchestrator(dev, copy.deepcopy(det), copy.deepcopy(tt), copy.deepcopy(hm), dm, copy.deepcopy(pred),
                                 SafetySupervisor(lim), self.store, PipelineConfig(), mode=Mode.SIMULATION, role=Role.OPERATOR,
                                 session=f"S{self._n}")
        dev.send_line('{"id":9999,"type":"SET_SPEED","p":%g,"p2":0,"p3":0,"ttl":5000,"age":0,"seq":0,"k":"%s"}'
                      % (setpoint_rpm, dev.key))
        dev.poll_lines()
        self.scenario = {"fault": fault, "severity": severity, "clears_below_rpm": clears_below_rpm, "seed": seed,
                         "setpoint_rpm": setpoint_rpm, "inject_after_s": inject_after_s,
                         "human_approval_required": hardware_like_approval}
        self._injected = False
        self.running = True
        return self.scenario

    def step(self, n: int = 1) -> int:
        if self.orch is None:
            raise RuntimeError("no simulation")
        done = 0
        for _ in range(max(0, min(n, 600))):
            if not self._injected and self.scenario.get("fault") and self.orch.now >= self.scenario["inject_after_s"]:
                self.orch.dev.sim.inject(Hypothesis(self.scenario["fault"]), self.scenario["severity"],
                                         self.scenario["clears_below_rpm"])
                self._injected = True
            self.orch.step()
            done += 1
        return done

    # ---------------- views (all tagged SIMULATED) ----------------
    def state(self) -> Dict[str, Any]:
        o = self.orch
        if o is None:
            return {"mode": "SIMULATION", "provenance": "SIMULATED", "simulation": None}
        w = o.buf[-1] if o.buf else None
        return {
            "mode": "SIMULATION", "provenance": "SIMULATED", "t": o.now, "scenario": self.scenario,
            "device": {"estop": o.dev.estop, "estop_reason": o.dev.estop_reason, "setpoint_rpm": o.dev.sim.setpoint},
            "incident": ({"id": o.inc.id, "state": o.inc.state.value, "data_requests": o.inc.data_requests,
                          "tests_run": o.inc.tests_run} if o.inc else None),
            "pending_approval": ({"action": o.pending.action.value, "params": o.pending.params,
                                  "rationale": o.pending.rationale} if o.pending else None),
            "last_window": ({"t": w.t, "rpm": w.rpm, "duty": w.duty, "voltage": w.voltage, "current": w.current,
                             "housing": w.housing, "vib_rms": w.vib_rms, "valid": w.valid} if w else None),
            "models": {"c2_validated_by_intervention_experiments": o.pred.validated_by_experiments,
                       "c2_label": "Intervention Outcome Prediction (unvalidated)"
                       if not o.pred.validated_by_experiments else "Counterfactual (validated)"},
            "closed_incidents": len(o.incidents_done),
        }

    def telemetry(self, last: int = 300) -> List[Dict[str, Any]]:
        if self.orch is None:
            return []
        out = []
        for w, s in zip(self.orch.buf[-last:], self.orch.scores[-last:]):
            out.append({"t": w.t, "rpm": w.rpm, "setpoint": w.setpoint, "duty": w.duty, "voltage": w.voltage,
                        "current": w.current, "housing": w.housing, "vib_rms": w.vib_rms,
                        "score": None if s.value is None else s.value / s.threshold, "score_status": s.status,
                        "provenance": "SIMULATED"})
        return out
