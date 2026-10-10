"""Simulated device: MotorSim behind the same JSON-line command/ack protocol the firmware speaks.

It re-implements the firmware's validation rules in Python for the end-to-end simulation. Conformance with
the real C++ `torqva_core` is NOT proven by this file (see docs/TORQVA_PROGRESS.md: firmware-in-the-loop task).
All telemetry is SIMULATED.
"""
from __future__ import annotations

import json
from typing import Dict, List, Optional

from .schemas import Hypothesis
from .sim import MotorSim, Window


class SimDevice:
    def __init__(self, sim: MotorSim, key: str = "sim-key", control_enabled: bool = True,
                 max_rpm: float = 3000.0, vib_limit_commissioned: bool = True, heartbeat_timeout_s: float = 2.0):
        self.sim = sim
        self.key = key
        self.control_enabled = control_enabled
        self.max_rpm = max_rpm
        self.vib_ok = vib_limit_commissioned
        self.hb_timeout = heartbeat_timeout_s
        self.windows: List[Window] = []
        self.out: List[str] = []
        self.estop = False
        self.estop_reason = ""
        self.last_seq = -1
        self._acks: Dict[int, dict] = {}
        self._last_hb: Optional[float] = None
        self._test: Optional[dict] = None
        self._test_cmd: Optional[int] = None
        # failure injection (communication faults / device misbehaviour)
        self.drop_incoming = False
        self.drop_acks = False
        self.reject_next: Optional[str] = None
        self.ignore_stop = False          # test hook ONLY: simulates a stuck driver, to exercise "motor still turning"
        self.stuck_sensor = False

    # ------------- protocol -------------
    def _ack(self, cid: int, status: str, reason: str) -> None:
        rec = {"t": "ack", "id": cid, "status": status, "reason": reason}
        self._acks[cid] = rec
        if not self.drop_acks:
            self.out.append(json.dumps(rec, separators=(",", ":")))

    def poll_lines(self) -> List[str]:
        o, self.out = self.out, []
        return o

    def send_line(self, line: str) -> None:
        if self.drop_incoming:
            return
        m = json.loads(line)
        cid, typ = int(m["id"]), m["type"]
        if cid in self._acks:                          # idempotent replay
            if not self.drop_acks:
                self.out.append(json.dumps(self._acks[cid], separators=(",", ":")))
            return
        if typ == "STOP":
            if not self.ignore_stop:
                self.sim.stop()
                self._abort_test("STOP_CMD")
            self._ack(cid, "ACCEPTED", "OK"); self._ack(cid, "COMPLETED", "STOPPED")
            return
        if m.get("k") != self.key:
            return self._ack(cid, "REJECTED", "UNAUTHORIZED")
        ttl, age = int(m.get("ttl", 0)), int(m.get("age", 0))
        if ttl <= 0 or ttl > 30000:
            return self._ack(cid, "REJECTED", "BAD_TTL")
        if age >= ttl:
            return self._ack(cid, "REJECTED", "EXPIRED")
        if int(m["seq"]) <= self.last_seq:
            return self._ack(cid, "REJECTED", "OUT_OF_SEQUENCE")
        if self.estop and typ not in ("HEARTBEAT", "RESET_ESTOP"):
            return self._ack(cid, "REJECTED", "ESTOP_LATCHED")
        if self.reject_next and typ != "HEARTBEAT":
            why, self.reject_next = self.reject_next, None
            return self._ack(cid, "REJECTED", why)
        if typ in ("SET_SPEED", "START", "RUN_TEST") and not self.control_enabled:
            return self._ack(cid, "REJECTED", "NOT_IN_HARDWARE_CONTROL")
        self.last_seq = int(m["seq"])
        p, p2, p3 = float(m.get("p", 0)), float(m.get("p2", 0)), float(m.get("p3", 0))

        if typ == "HEARTBEAT":
            self._last_hb = self.sim.t
            return self._ack(cid, "ACCEPTED", "OK")
        if typ == "SET_SPEED":
            if self.max_rpm <= 0:
                return self._ack(cid, "REJECTED", "NOT_COMMISSIONED")
            if not (0 <= p <= self.max_rpm):
                return self._ack(cid, "REJECTED", "RPM_OUT_OF_RANGE")
            if self._test:
                return self._ack(cid, "REJECTED", "TEST_ACTIVE")
            self.sim.set_setpoint(p) if p > 0 else self.sim.stop()
            return self._ack(cid, "ACCEPTED", "OK")
        if typ == "START":
            if not (0 < p <= 70):
                return self._ack(cid, "REJECTED", "DUTY_OUT_OF_RANGE")
            self.sim.set_setpoint(p * self.sim.p.rpm_per_pct)
            return self._ack(cid, "ACCEPTED", "OK")
        if typ == "RUN_TEST":
            return self._start_test(cid, int(p), p2, p3)
        if typ == "ABORT_TEST":
            self._abort_test("COMMAND")
            return self._ack(cid, "ACCEPTED", "OK")
        if typ == "RESET_ESTOP":
            if not self.estop:
                return self._ack(cid, "REJECTED", "NOT_LATCHED")
            self._ack(cid, "ACCEPTED", "OK")
            self._pending_reset = cid                      # completes on local button
            return
        self._ack(cid, "REJECTED", "UNKNOWN_TYPE")

    def press_button(self) -> None:
        cid = getattr(self, "_pending_reset", None)
        if self.estop and cid is not None:
            self.estop = False
            self._pending_reset = None
            self._ack_update(cid, "COMPLETED", "RESET")

    def _ack_update(self, cid, status, reason):
        rec = {"t": "ack", "id": cid, "status": status, "reason": reason}
        self._acks[cid] = rec
        if not self.drop_acks:
            self.out.append(json.dumps(rec, separators=(",", ":")))

    # ------------- on-device test executor -------------
    def _start_test(self, cid: int, test: int, p2: float, p3: float) -> None:
        sp = self.sim.setpoint
        if self._test:
            return self._ack(cid, "REJECTED", "TEST_ACTIVE")
        if not self.vib_ok:
            return self._ack(cid, "REJECTED", "VIB_LIMIT_NOT_SET")
        if sp <= 0:
            return self._ack(cid, "REJECTED", "NOT_RUNNING")
        if test == 1:
            if not (0.3 <= p2 <= 1.0):
                return self._ack(cid, "REJECTED", "FRACTION_OUT_OF_RANGE")
            if not (5000 <= p3 <= 60000):
                return self._ack(cid, "REJECTED", "HOLD_OUT_OF_RANGE")
            self._test = {"id": 1, "end": self.sim.t + p3 / 1000.0, "start_sp": sp}
            self.sim.set_setpoint(sp * p2)
        elif test == 3:
            if not (1000 <= p2 <= 600000):
                return self._ack(cid, "REJECTED", "DURATION_OUT_OF_RANGE")
            self._test = {"id": 3, "end": self.sim.t + p2 / 1000.0, "start_sp": sp}
        elif test == 4:
            self._test = {"id": 4, "end": self.sim.t + 60.0, "start_sp": sp}
            self.sim.stop()
        else:
            return self._ack(cid, "REJECTED", "UNKNOWN_TEST")
        self._test_cmd = cid
        self._ack(cid, "ACCEPTED", "OK")

    def _abort_test(self, why: str) -> None:
        if self._test and self._test_cmd is not None:
            self._ack_update(self._test_cmd, "ABORTED", why)
        self._test = None
        self._test_cmd = None

    def _finish_test_if_due(self) -> None:
        t = self._test
        if not t:
            return
        done = self.sim.t >= t["end"] or (t["id"] == 4 and self.sim.rpm <= 0.05 * t["start_sp"])
        if done:
            self._ack_update(self._test_cmd, "COMPLETED", "TEST_DONE")
            self._test = None
            self._test_cmd = None

    # ------------- time -------------
    def _check_safety(self, w: Window) -> None:
        reason = ""
        if w.housing > 60:
            reason = "TEMP_STOP"
        elif w.current > 5.0:
            reason = "OVER_CURRENT_INSTANT"
        elif w.driven and not (20.0 <= w.voltage <= 25.5):
            reason = "VOLTAGE"
        elif self.control_enabled and self._last_hb is not None and self.sim.t - self._last_hb >= self.hb_timeout:
            reason = "HEARTBEAT_LOST"
        if reason and not self.estop:
            self.estop, self.estop_reason = True, reason
            self.sim.stop()
            self._abort_test("SAFETY_TRIP")

    def inject_estop(self, reason: str = "EXTERNAL_ESTOP") -> None:
        self.estop, self.estop_reason = True, reason
        self.sim.stop()
        self._abort_test("SAFETY_TRIP")

    def advance(self, seconds: int = 1) -> List[Window]:
        new = []
        for _ in range(int(seconds)):
            if self._last_hb is None:
                self._last_hb = self.sim.t
            w = self.sim.step(1.0)
            if self.stuck_sensor:
                w.valid = False
            self._check_safety(w)
            self._finish_test_if_due()
            self.windows.append(w)
            new.append(w)
        return new
