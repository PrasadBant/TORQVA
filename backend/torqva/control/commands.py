"""Direct operator command records and parameter validation."""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

from torqva.safety.operating_policy import PhysicalControlPolicy

class CmdState(str, Enum):
    REQUESTED = "REQUESTED"
    REJECTED = "REJECTED"
    AUTHORIZED = "AUTHORIZED"
    SENT = "SENT"
    ACKNOWLEDGED = "ACKNOWLEDGED"        # the device accepted the command (NOT executed)
    EXECUTED = "EXECUTED"                # device reports completion; actuation is observed separately through telemetry
    FAILED = "FAILED"
    TIMED_OUT = "TIMED_OUT"              # no acknowledgement: outcome unknown, NEVER retried
    UNKNOWN_OUTCOME = "UNKNOWN_OUTCOME"  # the link or the device restarted first: NEVER replayed


_OPEN = (CmdState.SENT, CmdState.ACKNOWLEDGED)


@dataclass
class CommandRecord:
    id: int
    action: str
    params: Dict[str, Any]
    requested_by: str
    role: str
    state: CmdState = CmdState.REQUESTED
    reasons: List[str] = field(default_factory=list)
    created: float = 0.0
    sent_at: Optional[float] = None
    ack_reason: str = ""

    def public(self) -> Dict[str, Any]:
        return {"id": self.id, "action": self.action, "params": self.params, "requested_by": self.requested_by, "state": self.state.value, "reasons": list(self.reasons),
                "created_unix": self.created, "ack_reason": self.ack_reason}


def validate_motion_parameters(action: str, params: Dict[str, Any], policy: PhysicalControlPolicy) -> Optional[str]:
    if action in ("START", "SET_SPEED", "SET_PWM") and params.get("duration_s"):
        return "TIMED_MOTION_UNSUPPORTED"

    checks = {
        "START": [("duty_pct", 0.001, policy.max_duty_pct)],
        "SET_PWM": [("duty_pct", 0, policy.max_duty_pct)],
        "SET_SPEED": [("rpm", 0, policy.max_rpm)],
        "SET_RAMP": [("ramp_up", 0.001, None), ("ramp_down", 0.001, None)],
    }
    for name, lower, limit in checks.get(action, []):
        upper = limit if limit is not None else ({"SET_SPEED": 35000, "SET_RAMP": 1000}.get(action, 100))
        value = params.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not lower <= value <= upper:
            return f"INVALID_PARAMETER: {name} must be in [{lower:g}, {upper:g}]"
    return None
