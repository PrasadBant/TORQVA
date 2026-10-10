"""Command dispatch + acknowledgment tracking. Accepts ONLY supervisor-minted ApprovedAction objects."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from .schemas import ActionType, CommandStatus
from .supervisor import ApprovedAction

# Which firmware command type each approved action becomes.
_FW_TYPE = {
    ActionType.STOP: "STOP",
    ActionType.START: "START",
    ActionType.SET_SPEED: "SET_SPEED",
    ActionType.REDUCE_SPEED: "SET_SPEED",
    ActionType.RUN_TEST: "RUN_TEST",
    ActionType.ABORT_TEST: "ABORT_TEST",
    ActionType.HEARTBEAT: "HEARTBEAT",
    ActionType.RESET_ESTOP: "RESET_ESTOP",
}


@dataclass
class CommandRecord:
    id: int
    action: ActionType
    fw_type: str
    params: dict
    incident_id: Optional[str]
    mode: str
    sent_at: float
    ttl_ms: int
    status: CommandStatus = CommandStatus.PENDING
    reason: str = ""
    resends: int = 0
    seq: int = 0
    acked_at: Optional[float] = None
    history: List[str] = field(default_factory=list)

    def counts_as_executed(self) -> bool:
        """True only when the device confirmed it took effect. Rejected/aborted/timed-out/expired never count."""
        if self.action == ActionType.RUN_TEST:
            return self.status == CommandStatus.COMPLETED
        return self.status in (CommandStatus.ACCEPTED, CommandStatus.COMPLETED)


class CommandDispatcher:
    def __init__(self, send_line: Callable[[str], None], key: str, ack_timeout_s: float = 2.0,
                 max_resends: int = 2, default_ttl_ms: int = 5000):
        self._send = send_line
        self._key = key
        self._ack_timeout = ack_timeout_s
        self._max_resends = max_resends
        self._ttl = default_ttl_ms
        self._id = 0
        self._seq = 0
        self.records: Dict[int, CommandRecord] = {}

    def _line(self, rec: CommandRecord, age_ms: int) -> str:
        p = rec.params
        p1 = p2 = p3 = 0.0
        if rec.action == ActionType.START:
            p1 = p.get("duty_pct", 0.0)
        elif rec.action in (ActionType.SET_SPEED, ActionType.REDUCE_SPEED):
            p1 = p.get("rpm", 0.0)
        elif rec.action == ActionType.RUN_TEST:
            p1 = p.get("test", 0.0)
            if int(p1) == 1:
                p2, p3 = p.get("fraction", 0.0), p.get("hold_ms", 0.0)
            elif int(p1) == 3:
                p2 = p.get("duration_ms", 0.0)
        return json.dumps({"id": rec.id, "type": rec.fw_type, "p": p1, "p2": p2, "p3": p3,
                           "ttl": rec.ttl_ms, "age": age_ms, "seq": rec.seq, "k": self._key},
                          separators=(",", ":"))

    def dispatch(self, approved: ApprovedAction, now: float) -> CommandRecord:
        if not isinstance(approved, ApprovedAction):
            raise PermissionError("dispatch() accepts only supervisor-approved actions")
        if approved.action == ActionType.CONTINUE_MONITORING:
            raise ValueError("CONTINUE_MONITORING is not a device command")
        self._id += 1
        self._seq += 1
        rec = CommandRecord(self._id, approved.action, _FW_TYPE[approved.action], dict(approved.params),
                            approved.incident_id, approved.mode.value, now, self._ttl)
        rec.seq = self._seq
        self.records[rec.id] = rec
        self._send(self._line(rec, 0))
        rec.history.append("SENT")
        return rec

    def on_ack(self, ack: dict, now: float) -> Optional[CommandRecord]:
        rec = self.records.get(int(ack.get("id", -1)))
        if rec is None:
            return None
        if rec.status in (CommandStatus.REJECTED, CommandStatus.TIMEOUT, CommandStatus.EXPIRED):
            return rec           # terminal; late acks do not resurrect it
        try:
            new = CommandStatus(ack.get("status"))
        except ValueError:
            return rec
        # COMPLETED/ABORTED are final; an ACCEPTED replay after COMPLETED must not downgrade.
        if rec.status in (CommandStatus.COMPLETED, CommandStatus.ABORTED):
            return rec
        rec.status = new
        rec.reason = str(ack.get("reason", ""))
        rec.acked_at = now
        rec.history.append(new.value)
        return rec

    def poll(self, now: float) -> List[CommandRecord]:
        """Resend un-acked commands (same id: idempotent on the device) until TTL/limit, then mark them."""
        changed: List[CommandRecord] = []
        for rec in self.records.values():
            if rec.status != CommandStatus.PENDING:
                continue
            waited = now - rec.sent_at
            if waited * 1000 >= rec.ttl_ms:
                rec.status = CommandStatus.EXPIRED
                rec.history.append("EXPIRED")
                changed.append(rec)
            elif waited >= self._ack_timeout * (rec.resends + 1):
                if rec.resends >= self._max_resends:
                    rec.status = CommandStatus.TIMEOUT
                    rec.history.append("TIMEOUT")
                    changed.append(rec)
                else:
                    rec.resends += 1
                    self._send(self._line(rec, int(waited * 1000)))
                    rec.history.append("RESENT")
        return changed
