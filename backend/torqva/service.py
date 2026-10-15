"""SimulationService: owns a simulated motor + the TORQVA orchestrator for the API. SIMULATION mode only.

Every datum served from here is provenance SIMULATED; the API adds that tag and the UI must show the banner.
"""
from __future__ import annotations

import copy
import os
import threading
from pathlib import Path
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .attestation import AttestationService
from .serial_bridge import DeviceBridge
from .evaluation import build_models
from .pipeline import Orchestrator, PipelineConfig
from .schemas import Hypothesis, Mode, Role
from .sim import MotorSim
from .simdevice import SimDevice
from .store import Store
from .supervisor import SafetySupervisor, SupervisorLimits

DEFAULT_LIMITS = SupervisorLimits(vib_rms_stop_g=2.0, max_rpm=3000.0)

from . import lab as _lab


class SimulationService:
    def __init__(self, store: Optional[Store] = None, c2_variant: Optional[str] = None):
        self.c2_variant = c2_variant or os.environ.get("TORQVA_C2_VARIANT", "control")      # default: the shipped C2; "noise_aware" is opt-in
        self.store = store or Store()
        self.attestation = AttestationService(self.store)
        self._models = None
        self.orch: Optional[Orchestrator] = None
        self.scenario: Dict[str, Any] = {}
        self.running = False
        self._n = 0
        from .commissioning import Commissioning
        self.bridge = DeviceBridge(expected_device_id=os.environ.get("TORQVA_EXPECTED_DEVICE_ID") or None)   # USB serial bridge: never connects by itself
        from .device_keys import KeyStore
        self.bridge.keystore = KeyStore(os.environ.get("TORQVA_DEVICE_KEYS_FILE") or str(Path(__file__).resolve().parents[1] / "data" / "device_keys.json"))
        self.bridge.commissioning = Commissioning(os.environ.get("TORQVA_COMMISSIONING_FILE") or str(Path(__file__).resolve().parents[1] / "data" / "commissioning.json"))
        from .autoconnect import AutoConnector
        self.bridge.autoconnect = AutoConnector(self.bridge, os.environ.get("TORQVA_DEVICE_PORT") or None, scan=os.environ.get("TORQVA_AUTOCONNECT", "1") != "0")
        if os.environ.get("TORQVA_AUTOCONNECT", "1") != "0":
            self.bridge.autoconnect.start()                       # a TORQVA connection is attempted whenever a USB-serial board appears
        self.gateway = None            # Optional[DeviceGateway]: set only when a device transport is configured (none is, today)
        # Serialises every state change and every read of the live orchestrator (HTTP handlers run in a thread pool). The lock is taken per simulated
        # second inside step(), never for a whole multi-second step, so a STOP is never queued behind a long run.
        self.lock = threading.RLock()
        self._models_lock = threading.Lock()   # separate from `lock`: a model build (~2 s) never delays a STOP or a state read

    def _ensure_models(self):
        with self._models_lock:                # concurrent first requests build the models once, not once each
            if self._models is None:
                self._models = build_models(self.c2_variant)
            return self._models

    def warm_up(self) -> threading.Thread:
        """Build the simulation models in the background so the first simulation start does not wait for them."""
        t = threading.Thread(target=self._ensure_models, name="torqva-model-warmup", daemon=True)
        t.start()
        return t

    # ---------------- lifecycle ----------------
    def start(self, fault: Optional[str], severity: float, clears_below_rpm: Optional[float], seed: int,
              setpoint_rpm: float, inject_after_s: int, hardware_like_approval: bool = False) -> Dict[str, Any]:
        det, tt, hm, dm, pred, sizes = self._ensure_models()
        with self.lock:
            return self._start_locked(det, tt, hm, dm, pred, fault, severity, clears_below_rpm, seed, setpoint_rpm, inject_after_s, hardware_like_approval)

    def _start_locked(self, det, tt, hm, dm, pred, fault, severity, clears_below_rpm, seed, setpoint_rpm, inject_after_s, hardware_like_approval):
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
            with self.lock:                                           # one simulated second at a time (see __init__)
                if self.orch is None:
                    break
                if not self._injected and self.scenario.get("fault") and self.orch.now >= self.scenario["inject_after_s"]:
                    self.orch.dev.sim.inject(Hypothesis(self.scenario["fault"]), self.scenario["severity"],
                                             self.scenario["clears_below_rpm"])
                    self._injected = True
                self.orch.step()
                done += 1
        return done

    # ---------------- views (all tagged SIMULATED) ----------------
    def state(self) -> Dict[str, Any]:
        with self.lock:
            return self._state_locked()

    def _state_locked(self) -> Dict[str, Any]:
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
            "models": {"c2_variant": self.c2_variant, "c2_validated_by_intervention_experiments": o.pred.validated_by_experiments,
                       "c2_label": "Intervention Outcome Prediction (unvalidated)"
                       if not o.pred.validated_by_experiments else "Counterfactual (validated)"},
            "closed_incidents": len(o.incidents_done),
        }

    def telemetry(self, last: int = 300) -> List[Dict[str, Any]]:
        with self.lock:
            return self._telemetry_locked(last)

    def _telemetry_locked(self, last: int) -> List[Dict[str, Any]]:
        if self.orch is None:
            return []
        out = []
        for w, s in zip(self.orch.buf[-last:], self.orch.scores[-last:]):
            out.append({"t": w.t, "rpm": w.rpm, "setpoint": w.setpoint, "duty": w.duty, "voltage": w.voltage,
                        "current": w.current, "housing": w.housing, "vib_rms": w.vib_rms,
                        "score": None if s.value is None else s.value / s.threshold, "score_status": s.status,
                        "provenance": "SIMULATED"})
        return out


    # ---------------- lab ----------------
    def lab_create(self, user: str, **kw) -> Dict[str, Any]:
        s = _lab.new_session(operator=user, **kw)
        sid = f"L-{len(self.store.list('lab_session')) + 1:04d}"
        s["id"] = sid
        self.store.put("lab_session", sid, s, "SIMULATED")
        return s

    def lab_get(self, sid: str) -> Optional[Dict[str, Any]]:
        d = self.store.get("lab_session", sid)
        if d is not None:
            d.pop("_provenance", None)
        return d

    def lab_save(self, s: Dict[str, Any]) -> None:
        self.store.put("lab_session", s["id"], s, "SIMULATED")

    def lab_run(self, s: Dict[str, Any]) -> Dict[str, Any]:
        det, tt, hm, dm, pred, sizes = self._ensure_models()
        r = _lab.run_session(s, det, tt, hm)
        self.lab_save(s)
        return r

    def lab_reproduce(self, s: Dict[str, Any]) -> Dict[str, Any]:
        det, tt, hm, dm, pred, sizes = self._ensure_models()
        return _lab.reproduce(s, det, tt, hm)

    def lab_experiment(self, user: str, **kw) -> Dict[str, Any]:
        det, tt, hm, dm, pred, sizes = self._ensure_models()
        res = _lab.run_experiment(det=det, tt=tt, hm=hm, pred=pred, **kw)
        eid = f"X-{len(self.store.list('experiment')) + 1:04d}"
        res["id"], res["operator"] = eid, user
        self.store.put("experiment", eid, res, "SIMULATED")
        return res
