"""Conformance: the same command scripts through the REAL C++ firmware core (fitl CLI) and the Python SimDevice
must produce identical acknowledgements. The C++ build is the source of truth.

Build the CLI first:  cd esp32/torqva_fw && pio run -e fitl
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.sim import MotorSim
from torqva.simdevice import SimDevice

EXE = Path(__file__).resolve().parents[2] / "esp32" / "torqva_fw" / ".pio" / "build" / "fitl" / "program.exe"
pytestmark = pytest.mark.skipif(not EXE.exists(), reason="fitl CLI not built (pio run -e fitl)")


class Cpp:
    def __init__(self, control=True):
        self.p = subprocess.Popen([str(EXE)] + ([] if control else ["--no-control"]), stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, text=True, bufsize=1)
        self.seq = 0

    def io(self, line):
        self.p.stdin.write(line + "\n"); self.p.stdin.flush()
        out = []
        while True:
            l = self.p.stdout.readline().strip()
            if l == "#":
                return out
            out.append(l)

    def cmd(self, c):
        return [json.loads(x) for x in self.io(json.dumps(c, separators=(",", ":")))]

    def advance(self, seconds, button=False, **f):
        return [json.loads(x) for x in self.io(json.dumps({"tick": int(seconds * 1000), "button": int(button), **f}))]

    def close(self):
        self.p.stdin.close(); self.p.wait(timeout=5)


class Py:
    def __init__(self, control=True):
        self.d = SimDevice(MotorSim(1), control_enabled=control)

    def cmd(self, c):
        self.d.send_line(json.dumps(c, separators=(",", ":")))
        return [json.loads(x) for x in self.d.poll_lines()]

    def advance(self, seconds, button=False, **f):
        self.d.advance(seconds)
        if button:
            self.d.press_button()
        return [json.loads(x) for x in self.d.poll_lines()]


def norm(msgs):
    return [(m["id"], m["status"], m["reason"]) for m in msgs if m.get("t") == "ack"]


def C(i, typ, p=0, p2=0, p3=0, ttl=5000, age=0, seq=None, k="sim-key"):
    return {"id": i, "type": typ, "p": p, "p2": p2, "p3": p3, "ttl": ttl, "age": age, "seq": i if seq is None else seq, "k": k}


SCRIPT_VALIDATION = [
    C(1, "HEARTBEAT"),
    C(2, "START", 30, k="wrong"),
    C(3, "START", 30, ttl=0),
    C(4, "START", 30, ttl=40000),
    C(5, "START", 30, ttl=1000, age=1000),
    C(6, "START", 30, seq=1),                     # out of sequence
    C(7, "FORMAT_DISK"),
    C(8, "START", 80),                            # duty over cap
    C(9, "SET_SPEED", 5000),                      # over max rpm
    C(10, "SET_SPEED", -5),
    C(11, "START", 30),                           # ok
    C(11, "START", 60),                           # duplicate id -> original ack
    C(12, "RUN_TEST", 9),                         # unknown test
    C(13, "RUN_TEST", 1, 0.7, 10000),             # START is open loop, so no closed-loop setpoint to step down
    C(14, "STOP", k="wrong", ttl=0),              # STOP is never refused
    C(15, "ABORT_TEST"),
]


def run_script(driver_cls, script, control=True):
    d = driver_cls(control)
    acks = []
    for c in script:
        acks += norm(d.cmd(c))
    return acks


def test_validation_matrix_matches_cpp():
    cpp, py = run_script(Cpp, SCRIPT_VALIDATION), run_script(Py, SCRIPT_VALIDATION)
    assert cpp == py, "\nC++:    %s\nPython: %s" % (cpp, py)


def test_control_disabled_matches_cpp():
    s = [C(1, "HEARTBEAT"), C(2, "START", 30), C(3, "SET_SPEED", 1500), C(4, "RUN_TEST", 1, 0.7, 10000), C(5, "STOP")]
    assert run_script(Cpp, s, control=False) == run_script(Py, s, control=False)


def run_estop_flow(driver_cls):
    d = driver_cls(True)
    acks = []
    def go(c):
        acks.extend(norm(d.cmd(c)))
    go(C(1, "HEARTBEAT")); go(C(2, "START", 30))
    d.advance(1)
    go(C(3, "HEARTBEAT"))
    d.advance(5)                                       # no heartbeat for 5 s -> device trips
    go(C(4, "START", 30))                              # latched
    go(C(5, "SET_SPEED", 1000))                        # latched
    go(C(6, "RESET_ESTOP"))                            # accepted, needs the local button
    acks += norm(d.advance(1))
    acks += norm(d.advance(1, button=True))            # button + prior command -> reset completes
    go(C(7, "HEARTBEAT"))
    go(C(8, "RESET_ESTOP"))                            # not latched any more
    go(C(9, "STOP"))
    return acks


def test_estop_latch_and_reset_flow_matches_cpp():
    cpp, py = run_estop_flow(Cpp), run_estop_flow(Py)
    assert cpp == py, "\nC++:    %s\nPython: %s" % (cpp, py)
    reasons = [r for _, _, r in cpp]
    assert "ESTOP_LATCHED" in reasons and "RESET" in reasons and "NOT_LATCHED" in reasons


def test_cpp_never_acks_accepted_then_rejected_for_the_same_command():
    d = Cpp()
    acks = []
    for c in SCRIPT_VALIDATION:
        acks += norm(d.cmd(c))
    seen = {}
    for i, st, _ in acks:
        if i in seen and seen[i] == "REJECTED" and st == "ACCEPTED":
            pytest.fail(f"id {i}: REJECTED then ACCEPTED")
        seen.setdefault(i, st)
    d.close()
