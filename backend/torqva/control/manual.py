"""Normal physical command submission and diagnostic preemption."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Dict, Optional

from torqva.access.auth import manual_command_denial
from torqva.control.commands import CmdState, CommandRecord, validate_motion_parameters
from torqva.models.schemas import Role
from torqva.telemetry.device_state import Conn
from torqva.telemetry.recording import recorder

if TYPE_CHECKING:
    from torqva.device.serial_bridge import DeviceBridge


def submit_manual_command(bridge: DeviceBridge, action: str, params: Optional[Dict[str, Any]], user: str, role: Role, diagnostic_guard: Optional[tuple]) -> CommandRecord:
    transport = bridge._transport
    params = dict(params or {})
    if action in ("MAINTAIN_SPEED", "REDUCE_SPEED", "APPLY_RECOMMENDATION"):
        action = "SET_SPEED"
    elif action in ("STOP_MOTOR", "HALT"):
        action = "STOP"
    if action == "SET_SPEED" and "rpm" not in params:
        if "target_rpm" in params:
            params["rpm"] = params["target_rpm"]
        elif "target" in params:
            params["rpm"] = params["target"]
    recorder.notify_drive_command("PHYSICAL", action, params)
    rec = bridge._record(action, params, user, role)
    if action not in ("STOP", "START", "SET_SPEED", "SET_PWM", "SET_RAMP", "RESET_ESTOP"):
        return bridge._reject(rec, ["UNSUPPORTED_COMMAND"])
    if reason := manual_command_denial(action, role):
        return bridge._reject(rec, [reason])

    if diagnostic_guard is not None and diagnostic_guard != (bridge._manual_revision, bridge._transport, bridge._auth.get("sid")):
        return bridge._reject(rec, ["DIAGNOSTIC_INTERRUPTED"])

    reason = validate_motion_parameters(action, params, bridge.policy)
    if reason:
        return bridge._reject(rec, [reason])

    if not bridge.connected or transport is None:
        return bridge._reject(rec, ["DEVICE NOT CONNECTED"])

    if diagnostic_guard is None:
        bridge._manual_revision += 1
    rec.state = CmdState.AUTHORIZED
    with bridge._command_wire_lock:
        return bridge._write_command(rec, action, params, transport)
