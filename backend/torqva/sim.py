"""Deterministic motor simulator with ground truth. Everything produced here is provenance=SIMULATED.

NOT calibrated to the real RS-775 rig: parameters are plausible placeholders until commissioning data
exists (master prompt section 9). Results obtained with it must be reported as simulation results and never
mixed with measured results.
"""
from __future__ import annotations

import copy
import math
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
class Regime:
    """Simulation regime: how hard/realistic the synthetic world is. Defaults reproduce the original simulator exactly."""
    name: str = "baseline"
    noise_mult: float = 1.0            # scales measurement noise
    session_offsets: bool = False      # healthy session-to-session shifts (vibration gain, ambient, supply, current)
    sensor_fault_mode: str = "stuck"   # stuck | noisy_harmonics (speed-independent, looks like looseness at one speed) | intermittent
    looseness_mode: str = "steady"     # steady | intermittent (harmonics present in ~half the windows)
    description: str = "Original simulator."


REGIMES: Dict[str, Regime] = {r.name: r for r in [
    Regime("baseline"),
    Regime("noisy", noise_mult=2.0, description="Twice the measurement noise."),
    Regime("session_shift", session_offsets=True, description="Healthy baselines shift between sessions (gain, ambient, supply, current offset)."),
    Regime("confusable_sensor", sensor_fault_mode="noisy_harmonics",
           description="Sensor fault = speed-independent noise on the harmonic channels: mimics looseness at one speed."),
    Regime("intermittent", sensor_fault_mode="intermittent", looseness_mode="intermittent",
           description="Both looseness and the sensor fault come and go from window to window."),
    Regime("hard", noise_mult=2.0, session_offsets=True, sensor_fault_mode="noisy_harmonics", looseness_mode="intermittent",
           description="All of the above combined."),
]}


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
    def __init__(self, seed: int = 0, params: Optional[SimParams] = None, regime: Optional[Regime] = None):
        self.p = params or SimParams()
        self.regime = regime or REGIMES["baseline"]
        self.rng = np.random.RandomState(seed)
        # Session offsets come from a separate stream so enabling them never perturbs the main noise sequence.
        orng = np.random.RandomState(seed + 99991)
        if self.regime.session_offsets:
            self.vib_gain = float(np.clip(1.0 + 0.10 * orng.randn(), 0.7, 1.3))
            self.ambient_c = self.p.ambient_c + float(np.clip(2.0 * orng.randn(), -5, 5))
            self.supply_off = float(np.clip(0.25 * orng.randn(), -0.6, 0.6))
            self.current_off = float(np.clip(0.03 * orng.randn(), -0.08, 0.08))
        else:
            self.vib_gain, self.ambient_c, self.supply_off, self.current_off = 1.0, self.p.ambient_c, 0.0, 0.0
        self.t = 0.0
        self.rpm = 0.0
        self.setpoint = 0.0
        self.driven = False
        self.housing = self.ambient_c
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
        cur = (p.i_idle_a + p.i_per_pct_a * duty + extra_i + self.current_off) if self.driven else 0.0
        volt = p.supply_v + self.supply_off - p.r_supply_ohm * cur - 3.0 * s_sup

        cool = p.cool_per_s * (1.0 - 0.7 * s_cool)
        self.housing += (p.heat_per_a2 * cur * cur - cool * (self.housing - self.ambient_c)) * dt
        self.t += dt

        # Vibration (g). 1x ~ rpm^2 (imbalance), harmonics + broadband for looseness.
        rg = self.regime
        if s_loose > 0 and rg.looseness_mode == "intermittent" and rng.rand() < 0.5:
            s_loose = 0.0                                          # harmonics absent in this window
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
        if self.vib_gain != 1.0:
            v1, v2, v3, vhf = (x * self.vib_gain for x in (v1, v2, v3, vhf))
        floor = abs(rng.randn()) * p.noise_abs * rg.noise_mult
        rms = math.sqrt(v1 * v1 + v2 * v2 + v3 * v3 + vhf * vhf + floor * floor)

        rpm_meas, valid = r, True
        if s_sens > 0:
            mode = rg.sensor_fault_mode
            if mode == "noisy_harmonics" and r > 50:
                # Electronics noise on the harmonic channels: does NOT scale with shaft speed (looseness does).
                v2 = v2 + s_sens * 1.2e-4 * 1500.0 * (0.6 + 0.8 * rng.rand())
                v3 = v3 + s_sens * 0.8e-4 * 1500.0 * (0.6 + 0.8 * rng.rand())
                vhf = vhf + 0.020 * s_sens
                rms = math.sqrt(v1 * v1 + v2 * v2 + v3 * v3 + vhf * vhf + floor * floor)
            elif mode == "intermittent":
                if rng.rand() < 0.4:                              # burst of garbage, otherwise looks healthy
                    v1 = v2 = v3 = (0.05 + abs(rng.randn()) * 0.05) * (0.5 + s_sens)
                    vhf = 0.03
                    rms = math.sqrt(v1 * v1 * 3 + vhf * vhf)
            else:
                # stuck: vibration channel stops tracking speed (stuck + noise)
                v1 = v2 = v3 = 0.05 * s_sens + abs(rng.randn()) * 0.01
                vhf = 0.02
                rms = math.sqrt(v1 * v1 * 3 + vhf * vhf)
        nm = rg.noise_mult
        return Window(self.t, rpm_meas + rng.randn() * 2.0 * nm if r > 0 else 0.0, self.setpoint, self.driven,
                      duty + rng.randn() * 0.2 * nm if self.driven else 0.0,
                      volt + rng.randn() * 0.03 * nm, cur + (rng.randn() * 0.02 * nm if self.driven else 0.0),
                      volt * cur, self.housing + rng.randn() * 0.03 * nm, self.ambient_c, rms, v1, v2, v3, vhf, valid)

    def _noisy(self, x: float) -> float:
        m, randn = self.regime.noise_mult, self.rng.randn
        return max(0.0, x * (1.0 + self.p.noise_rel * m * randn()) + 0.2 * self.p.noise_abs * m * randn() * (x > 0))

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
