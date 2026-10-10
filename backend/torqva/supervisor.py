"""Deterministic Safety Supervisor. No ML, no LLM, no I/O.

Every command or test reaches the device only as an `ApprovedAction`, which this module alone can mint.
The device firmware re-validates independently; this layer exists so unsafe requests are refused early,
with a reason, and recorded.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from .schemas import (
    ActionType, Connection, DecisionVerdict, DeviceSafetyState, Mode, ProposalSource,
    ProposedAction, Role,
)

_MINT = object()   # module-private capability token


@dataclass(frozen=True)
class SupervisorLimits:
    """Mirrors the device defaults. Learning code never receives a mutable reference to this."""
    temp_stop_c: float = 60.0
    current_stop_a: float = 4.0
    volt_min_v: float = 20.0
    volt_max_v: float = 25.5
    vib_rms_stop_g: float = 0.0          # 0 = not commissioned -> tests refused
    max_telemetry_age_s: float = 1.0
    max_rpm: float = 0.0                 # 0 = not commissioned -> speed commands refused
    min_speed_fraction: float = 0.3      # REDUCE_SPEED may not go below this fraction of current setpoint
    max_duty_pct: float = 70.0
    hardware_validated_tests: tuple = ("T1", "T3", "T4")
    auto_approve_in_simulation: bool = True


@dataclass
class SupervisorContext:
    mode: Mode
    hardware_control_enabled: bool
    connection: Connection
    device_state: DeviceSafetyState
    telemetry_age_s: float
    sensors_valid: bool
    motor_running: bool
    current_setpoint_rpm: float = 0.0
    test_active: bool = False
    # latest measured/derived values for mandatory-stop evaluation (None = unknown)
    housing_c: Optional[float] = None
    current_a: Optional[float] = None
    voltage_v: Optional[float] = None
    vib_rms_g: Optional[float] = None
    tests_run_in_incident: int = 0
    max_tests_per_incident: int = 2


@dataclass(frozen=True)
class Decision:
    verdict: DecisionVerdict
    reasons: List[str]
    mandatory_stop: bool = False
    approved: Optional["ApprovedAction"] = None


@dataclass(frozen=True)
class ApprovedAction:
    """Executable action. Constructible only via SafetySupervisor.check()."""
    action: ActionType
    params: dict
    source: ProposalSource
    incident_id: Optional[str]
    requested_by: Optional[str]
    mode: Mode
    _token: object = field(default=None, repr=False, compare=False)

    def __post_init__(self):
        if self._token is not _MINT:
            raise PermissionError("ApprovedAction can only be created by SafetySupervisor")


def mandatory_stop_reasons(ctx: SupervisorContext, lim: SupervisorLimits) -> List[str]:
    """Conditions that require STOP regardless of any model output or uncertainty."""
    r: List[str] = []
    if ctx.device_state == DeviceSafetyState.EMERGENCY_STOP:
        r.append("device_emergency_stop")
    if ctx.housing_c is not None and ctx.housing_c >= lim.temp_stop_c:
        r.append("housing_temp_at_stop_limit")
    if ctx.current_a is not None and ctx.current_a >= lim.current_stop_a:
        r.append("current_at_stop_limit")
    if ctx.voltage_v is not None and not (lim.volt_min_v <= ctx.voltage_v <= lim.volt_max_v):
        r.append("supply_voltage_out_of_window")
    if lim.vib_rms_stop_g > 0 and ctx.vib_rms_g is not None and ctx.vib_rms_g >= lim.vib_rms_stop_g:
        r.append("vibration_at_stop_limit")
    return r


class SafetySupervisor:
    def __init__(self, limits: SupervisorLimits = SupervisorLimits()):
        self._lim = limits

    @property
    def limits(self) -> SupervisorLimits:
        return self._lim

    def _mint(self, p: ProposedAction, ctx: SupervisorContext) -> ApprovedAction:
        return ApprovedAction(p.action, dict(p.params), p.source, p.incident_id, p.requested_by, ctx.mode, _MINT)

    def check(self, p: ProposedAction, ctx: SupervisorContext) -> Decision:
        lim = self._lim
        mandatory = mandatory_stop_reasons(ctx, lim)

        # 1. STOP is always allowed (from anyone, any state): it can only make the system safer.
        if p.action == ActionType.STOP:
            return Decision(DecisionVerdict.ALLOW, ["stop_always_allowed"] + mandatory, bool(mandatory),
                            self._mint(p, ctx))

        # 2. LLM text can never become a command.
        if p.source == ProposalSource.LLM:
            return Decision(DecisionVerdict.REJECT, ["llm_source_forbidden"], bool(mandatory))

        # 3. Mandatory stop beats everything else: refuse non-stop actions and say why.
        #    The one exception: RESET_ESTOP may clear the *latched device e-stop itself*, but never while a
        #    physical condition (temperature, current, voltage, vibration) is still at its stop limit.
        if p.action == ActionType.RESET_ESTOP:
            mandatory = [m for m in mandatory if m != "device_emergency_stop"]
        if mandatory:
            return Decision(DecisionVerdict.REJECT, ["mandatory_stop_active"] + mandatory, True)

        # 4. Monitoring-only actions carry no device command.
        if p.action == ActionType.CONTINUE_MONITORING:
            return Decision(DecisionVerdict.ALLOW, ["no_device_command"], False, self._mint(p, ctx))
        if p.action == ActionType.HEARTBEAT:
            return Decision(DecisionVerdict.ALLOW, ["heartbeat"], False, self._mint(p, ctx))

        reasons: List[str] = []
        # 5. Authorisation for anything that moves the motor.
        if p.role == Role.VIEWER and p.source == ProposalSource.HUMAN:
            reasons.append("viewer_not_authorised")
        if p.action == ActionType.RESET_ESTOP and p.role != Role.ADMIN:
            reasons.append("reset_requires_admin")

        # 6. Link and sensor preconditions.
        if ctx.connection != Connection.CONNECTED:
            reasons.append("device_not_connected")
        if ctx.telemetry_age_s > lim.max_telemetry_age_s:
            reasons.append("telemetry_stale")
        if not ctx.sensors_valid and p.action != ActionType.RESET_ESTOP:
            reasons.append("sensors_not_valid")
        if ctx.device_state == DeviceSafetyState.UNKNOWN:
            reasons.append("device_state_unknown")

        # 7. Hardware control must be explicitly enabled.
        if ctx.mode == Mode.HARDWARE and not ctx.hardware_control_enabled:
            reasons.append("hardware_control_not_enabled")

        # 8. Per-action envelope.
        if p.action in (ActionType.START, ActionType.SET_SPEED, ActionType.REDUCE_SPEED) and ctx.test_active:
            reasons.append("test_active")
        if p.action == ActionType.START:
            duty = p.params.get("duty_pct", -1.0)
            if not (0.0 < duty <= lim.max_duty_pct):
                reasons.append("duty_out_of_range")
        if p.action == ActionType.SET_SPEED:
            rpm = p.params.get("rpm", -1.0)
            if lim.max_rpm <= 0:
                reasons.append("speed_not_commissioned")
            elif not (0.0 <= rpm <= lim.max_rpm):
                reasons.append("rpm_out_of_range")
        if p.action == ActionType.REDUCE_SPEED:
            rpm = p.params.get("rpm", -1.0)
            if not ctx.motor_running or ctx.current_setpoint_rpm <= 0:
                reasons.append("motor_not_running")
            elif not (ctx.current_setpoint_rpm * lim.min_speed_fraction <= rpm < ctx.current_setpoint_rpm):
                reasons.append("reduce_target_outside_envelope")   # also blocks any increase
        if p.action == ActionType.RUN_TEST:
            test = p.params.get("test", 0)
            name = {1: "T1", 3: "T3", 4: "T4"}.get(int(test))
            if name is None:
                reasons.append("unknown_test")
            elif ctx.mode == Mode.HARDWARE and name not in lim.hardware_validated_tests:
                reasons.append("test_not_hardware_validated")
            if lim.vib_rms_stop_g <= 0:
                reasons.append("vibration_limit_not_commissioned")
            if not ctx.motor_running:
                reasons.append("motor_not_running")
            if ctx.test_active:
                reasons.append("test_active")
            if ctx.tests_run_in_incident >= ctx.max_tests_per_incident:
                reasons.append("test_budget_exhausted")
            if name == "T1":
                frac = p.params.get("fraction", 2.0)
                if not (lim.min_speed_fraction <= frac <= 1.0):
                    reasons.append("test_fraction_outside_envelope")
        if p.action == ActionType.ABORT_TEST and not ctx.test_active:
            reasons.append("no_test_active")

        if reasons:
            return Decision(DecisionVerdict.REJECT, reasons, False)

        # 9. Human approval: always in hardware; in simulation unless configured to auto-approve.
        #    A human-sourced proposal still needs the explicit confirmation flag from the UI confirm step.
        needs_human = p.action != ActionType.ABORT_TEST and (
            ctx.mode == Mode.HARDWARE or not lim.auto_approve_in_simulation)
        if needs_human and not p.human_approved:
            return Decision(DecisionVerdict.DEFER, ["awaiting_human_approval"], False)

        return Decision(DecisionVerdict.ALLOW, ["checks_passed"], False, self._mint(p, ctx))
