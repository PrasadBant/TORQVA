"""Deterministic motor simulator with ground truth. Everything produced here is provenance=SIMULATED.

NOT calibrated to the real RS-775 rig: parameters are plausible placeholders until commissioning data
exists (master prompt section 9). Results obtained with it must be reported as simulation results and never
mixed with measured results.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np

from .schemas import Hypothesis, Provenance

FEATURES = ("vib_rms", "v1x", "v2x", "v3x", "vhf", "i_per_krpm", "duty", "thermal_resid", "voltage", "power")


@dataclass
class SimParams:
    rpm_per_pct: float = 45.0
    tau_drive_s: float = 1.0
    tau_coast_s: float = 5.0
    i_idle_a: float = 0.35
    i_per_pct_a: float = 0.025
    supply_v: float = 24.0
    r_supply_ohm: float = 0.3
    ambient_c: float = 22.0
    heat_per_a2: float = 0.012
    cool_per_s: float = 0.0015
    a1x: float = 2.2e-8          # g per rpm^2 (healthy 1x vibration)
    a2x_ratio: float = 0.25
    a3x_ratio: float = 0.12
    vhf_floor: float = 0.010
    noise_rel: float = 0.05
    noise_abs: float = 0.004


@dataclass
class Window:
    """One 1-second feature window. `provenance` is always SIMULATED here."""
    t: float
    rpm: float
    setpoint: float
    driven: bool
    duty: float
    voltage: float
    current: float
    power: float
    housing: float
    ambient: float
    vib_rms: float
    v1x: float
    v2x: float
    v3x: float
    vhf: float
    valid: bool = True
    provenance: Provenance = Provenance.SIMULATED
    thermal_resid: float = 0.0   # measured housing minus thermal-model prediction (set by ThermalTracker)

    @property
    def temp_rise(self) -> float:
        return self.housing - self.ambient

    def features(self) -> np.ndarray:
        rpm = max(self.rpm, 1.0)
        return np.array([self.vib_rms, self.v1x, self.v2x, self.v3x, self.vhf,
                         self.current / rpm * 1000.0, self.duty, self.thermal_resid, self.voltage, self.power])


@dataclass
class GroundTruth:
    fault: Optional[Hypothesis] = None
    severity: float = 0.0
    # Simulation scenario knob: a transient condition (e.g. debris on the rotor) that is shed when the setpoint
    # drops below this value. Models an action that genuinely clears the problem. Documented as a sim scenario.
    clears_below_rpm: Optional[float] = None


class MotorSim:
    def __init__(self, seed: int = 0, params: Optional[SimParams] = None):
        self.p = params or SimParams()
        self.rng = np.random.RandomState(seed)
        self.t = 0.0
        self.rpm = 0.0
        self.setpoint = 0.0
        self.driven = False
        self.housing = self.p.ambient_c
        self.truth = GroundTruth()

    # ---------- control ----------
    def set_setpoint(self, rpm: float) -> None:
        self.setpoint = max(0.0, rpm)
        self.driven = rpm > 0

    def stop(self) -> None:
        self.setpoint = 0.0
        self.driven = False        # coast; no active braking

    def inject(self, fault: Optional[Hypothesis], severity: float = 0.0, clears_below_rpm: Optional[float] = None) -> None:
        self.truth = GroundTruth(fault, severity if fault else 0.0, clears_below_rpm if fault else None)

    def fork(self) -> "MotorSim":
        """Independent copy (state + RNG) for counterfactual ground-truth rollouts."""
        return copy.deepcopy(self)

    # ---------- physics ----------
    def _fault(self, h: Hypothesis) -> float:
        return self.truth.severity if self.truth.fault == h else 0.0

    def step(self, dt: float = 1.0) -> Window:
        p, rng = self.p, self.rng
        if self.truth.clears_below_rpm is not None and self.setpoint < self.truth.clears_below_rpm:
            self.truth = GroundTruth()
        s_over = self._fault(Hypothesis.OVERLOAD)
        s_cool = self._fault(Hypothesis.COOLING_FAILURE)
        s_sup = self._fault(Hypothesis.SUPPLY_VOLTAGE)
        s_imb = self._fault(Hypothesis.IMBALANCE)
        s_loose = self._fault(Hypothesis.LOOSENESS)
        s_sens = self._fault(Hypothesis.SENSOR_FAULT)

        tau_coast = p.tau_coast_s * (1.0 - 0.6 * s_over)          # friction -> faster coast-down
        if self.driven:
            self.rpm += (self.setpoint - self.rpm) / p.tau_drive_s * dt
        else:
            self.rpm -= self.rpm / tau_coast * dt
        self.rpm = max(self.rpm, 0.0)

        extra_i = 1.2 * s_over
        duty = (self.rpm / p.rpm_per_pct) * (1.0 + 0.25 * s_over + 0.15 * s_sup) if self.driven else 0.0
        cur = (p.i_idle_a + p.i_per_pct_a * duty + extra_i) if self.driven else 0.0
        volt = p.supply_v - p.r_supply_ohm * cur - 3.0 * s_sup

        cool = p.cool_per_s * (1.0 - 0.7 * s_cool)
        self.housing += (p.heat_per_a2 * cur * cur - cool * (self.housing - p.ambient_c)) * dt
        self.t += dt

        # Vibration (g). 1x ~ rpm^2 (imbalance), harmonics + broadband for looseness.
        r = self.rpm
        base1 = p.a1x * r * r
        v1 = base1 * (1.0 + 6.0 * s_imb)
        v2 = p.a2x_ratio * base1 + s_loose * 1.2e-4 * r * (0.6 + 0.8 * rng.rand())
        v3 = p.a3x_ratio * base1 + s_loose * 0.8e-4 * r * (0.6 + 0.8 * rng.rand())
        vhf = (p.vhf_floor if r > 50 else 0.0) + 0.020 * s_loose + 0.006 * s_over
        v1 = self._noisy(v1)
        v2 = self._noisy(v2)
        v3 = self._noisy(v3)
        vhf = self._noisy(vhf)
        floor = abs(rng.randn()) * p.noise_abs
        rms = float(np.sqrt(v1 * v1 + v2 * v2 + v3 * v3 + vhf * vhf + floor * floor))

        rpm_meas, valid = r, True
        if s_sens > 0:
            # sensor fault signature: vibration channel stops tracking speed (stuck + noise)
            v1 = v2 = v3 = 0.05 * s_sens + abs(rng.randn()) * 0.01
            vhf = 0.02
            rms = float(np.sqrt(v1 * v1 * 3 + vhf * vhf))
        return Window(self.t, rpm_meas + rng.randn() * 2.0 if r > 0 else 0.0, self.setpoint, self.driven,
                      duty + rng.randn() * 0.2 if self.driven else 0.0,
                      volt + rng.randn() * 0.03, cur + (rng.randn() * 0.02 if self.driven else 0.0),
                      volt * cur, self.housing + rng.randn() * 0.03, p.ambient_c, rms, v1, v2, v3, vhf, valid)

    def _noisy(self, x: float) -> float:
        return max(0.0, x * (1.0 + self.p.noise_rel * self.rng.randn()) + 0.2 * self.p.noise_abs * self.rng.randn() * (x > 0))

    def run(self, seconds: int) -> List[Window]:
        return [self.step(1.0) for _ in range(int(seconds))]


# ---------- ground-truth action outcomes (the simulator knows what would really happen) ----------
def rollout(sim: MotorSim, action: str, horizon_s: int, target_rpm: float = 0.0) -> List[Window]:
    """Run an independent copy of `sim` under an action and return what would actually be measured."""
    f = sim.fork()
    if action == "STOP":
        f.stop()
    elif action == "REDUCE_SPEED":
        f.set_setpoint(target_rpm)
    elif action != "CONTINUE_MONITORING":
        raise ValueError(action)
    return f.run(horizon_s)
