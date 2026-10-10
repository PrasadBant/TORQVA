"""Shared enums and typed records. No logic here beyond validation."""
from __future__ import annotations

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class Provenance(str, Enum):
    MEASURED = "MEASURED"
    DERIVED = "DERIVED"
    PREDICTED = "PREDICTED"
    SIMULATED = "SIMULATED"
    HUMAN_CONFIRMED = "HUMAN_CONFIRMED"


class Mode(str, Enum):
    SIMULATION = "SIMULATION"
    HARDWARE = "HARDWARE"


class Role(str, Enum):
    VIEWER = "viewer"
    OPERATOR = "operator"
    ADMIN = "admin"


class Connection(str, Enum):
    CONNECTED = "CONNECTED"
    DEGRADED = "DEGRADED"
    DISCONNECTED = "DISCONNECTED"


class DeviceSafetyState(str, Enum):
    OK = "OK"
    WARN = "WARN"
    EMERGENCY_STOP = "EMERGENCY_STOP"
    UNKNOWN = "UNKNOWN"


class ActionType(str, Enum):
    CONTINUE_MONITORING = "CONTINUE_MONITORING"
    REDUCE_SPEED = "REDUCE_SPEED"
    STOP = "STOP"
    RUN_TEST = "RUN_TEST"
    START = "START"
    SET_SPEED = "SET_SPEED"
    ABORT_TEST = "ABORT_TEST"
    HEARTBEAT = "HEARTBEAT"
    RESET_ESTOP = "RESET_ESTOP"


class ProposalSource(str, Enum):
    GATE = "gate"          # C3
    PREDICTOR = "c2"
    HUMAN = "human"
    LLM = "llm"            # may only produce text; the supervisor rejects it as a command source
    SYSTEM = "system"      # mandatory-stop rules


class ProposedAction(BaseModel):
    """What a model or human wants. NOT executable: only the supervisor can turn this into an ApprovedAction."""
    action: ActionType
    params: Dict[str, float] = Field(default_factory=dict)
    source: ProposalSource
    rationale: str = ""
    incident_id: Optional[str] = None
    requested_by: Optional[str] = None
    role: Role = Role.VIEWER
    human_approved: bool = False


class DecisionVerdict(str, Enum):
    ALLOW = "ALLOW"
    REJECT = "REJECT"
    DEFER = "DEFER"        # needs human approval / more data; nothing sent


class CommandStatus(str, Enum):
    PENDING = "PENDING"
    ACCEPTED = "ACCEPTED"
    COMPLETED = "COMPLETED"
    REJECTED = "REJECTED"
    ABORTED = "ABORTED"
    TIMEOUT = "TIMEOUT"
    EXPIRED = "EXPIRED"


class GateVerdict(str, Enum):
    ACT = "ACT"
    REQUEST_MORE_DATA = "REQUEST_MORE_DATA"
    RUN_DIAGNOSTIC_TEST = "RUN_DIAGNOSTIC_TEST"
    SAFE_STOP = "SAFE_STOP"
    ESCALATE_HUMAN = "ESCALATE_HUMAN"
    SENSOR_UNRELIABLE = "SENSOR_UNRELIABLE"


class RecoveryOutcome(str, Enum):
    RECOVERED = "RECOVERED"
    UNRESOLVED = "UNRESOLVED"
    INCONCLUSIVE = "INCONCLUSIVE"
    HUMAN_INSPECTION_REQUIRED = "HUMAN_INSPECTION_REQUIRED"


class Hypothesis(str, Enum):
    IMBALANCE = "imbalance"
    LOOSENESS = "looseness"
    OVERLOAD = "overload"
    COOLING_FAILURE = "cooling_failure"
    SUPPLY_VOLTAGE = "supply_voltage"
    SENSOR_FAULT = "sensor_fault"


class AuditEvent(BaseModel):
    ts: float
    kind: str
    actor: str
    detail: Dict[str, Any] = Field(default_factory=dict)
