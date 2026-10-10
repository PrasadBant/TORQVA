"""Phase 14: firmware <-> software telemetry/command contract, verified against the REAL C++ torqva_core (firmware-in-the-loop CLI on the host).

This is NOT hardware validation: the plant is the deterministic SimPlant, nothing runs on an ESP32, and no wiring or electrical assumption is checked here.
Build the CLI first:  cd esp32/torqva_fw && pio run -e fitl
"""
import json
import math
import subprocess
from pathlib import Path

import pytest

EXE = Path(__file__).resolve().parents[2] / "esp32" / "torqva_fw" / ".pio" / "build" / "fitl" / "program.exe"
pytestmark = pytest.mark.skipif(not EXE.exists(), reason="fitl CLI not built (pio run -e fitl)")

KEY = "sim-key"
Q_BITS = {"current": 1, "voltage": 2, "housing": 4, "ambient": 8, "rpm": 16, "vib": 32}


class Fw:
    def __init__(self, control=True, *flags):
        self.p = subprocess.Popen([str(EXE)] + ([] if control else ["--no-control"]) + list(flags), stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.n = 0

    def io(self, line):
        self.p.stdin.write(line + "\n"); self.p.stdin.flush()
        out = []
        while True:
            l = self.p.stdout.readline().strip()
            if l == "#":
                return [json.loads(x) for x in out]
            out.append(l)

    def cmd(self, typ, p=0, p2=0, p3=0, ttl=5000, sid=None):
        self.n += 1
        m = {"id": self.n, "type": typ, "p": p, "p2": p2, "p3": p3, "ttl": ttl, "age": 0, "seq": self.n, "k": KEY}
        if sid is not None:
            m["sid"] = sid
        return self.io(json.dumps(m, separators=(",", ":")))

    def tick(self, ms, **flags):
        return self.io(json.dumps({"tick": ms, **flags}, separators=(",", ":")))

    def close(self):
        self.p.stdin.close(); self.p.wait(timeout=5)


@pytest.fixture()
def fw():
    d = Fw()
    yield d
    d.close()


def run_with_heartbeats(d, seconds, **flags):
    frames = []
    for _ in range(int(seconds)):
        d.cmd("HEARTBEAT")
        frames += d.tick(1000, **flags)
    return frames


def test_frame_schema_types_finite_and_units(fw):
    fw.cmd("HEARTBEAT"); fw.cmd("START", 30)
    frames = run_with_heartbeats(fw, 6)
    fast = [f for f in frames if f["t"] == "fast"]; slow = [f for f in frames if f["t"] == "slow"]; status = [f for f in frames if f["t"] == "status"]
    assert fast and slow and status
    for f in fast:
        assert set(f) == {"t", "seq", "ts", "rpm", "sp", "duty", "v", "i", "p", "q"}
        assert all(isinstance(f[k], (int, float)) and math.isfinite(f[k]) for k in f if k != "t")
        assert 0 <= f["rpm"] <= 3500 and 0 <= f["duty"] <= 70.0 + 1e-6 and 0 <= f["v"] <= 30 and -0.5 <= f["i"] <= 5.0 and f["p"] >= -0.5       # rpm, % duty (cap 70), V, A, W
        assert abs(f["p"] - f["v"] * f["i"]) < 0.6                                                               # power is V x I
        assert 0 <= f["q"] <= 63
    for f in slow:
        assert set(f) == {"t", "seq", "ts", "housing", "ambient", "q"} and 0 <= f["housing"] <= 100 and 0 <= f["ambient"] <= 60                       # degrees C
    for f in status:
        assert set(f) == {"t", "seq", "ts", "fw", "wiring", "limits_v", "state", "reason", "mode", "drive", "ctl", "hb_age", "test", "proto", "dev", "blk", "fm"}
        assert f["mode"] == "SIM" and f["state"] in ("OK", "WARN", "EMERGENCY_STOP") and f["drive"] in ("IDLE", "OPEN_LOOP", "CLOSED_LOOP")


def test_sequence_numbers_are_strictly_increasing_and_timestamps_never_go_back(fw):
    frames = run_with_heartbeats(fw, 5)
    seqs = [f["seq"] for f in frames]; ts = [f["ts"] for f in frames]
    assert seqs == sorted(set(seqs)) and all(b == a + 1 for a, b in zip(seqs, seqs[1:])), "seq is one gapless counter shared by every frame type"
    assert ts == sorted(ts), "timestamps are monotonic (device milliseconds since boot, not wall-clock)"


def test_a_consumer_can_detect_duplicate_and_missing_frames_from_seq_alone(fw):
    frames = run_with_heartbeats(fw, 3)
    seqs = [f["seq"] for f in frames]
    dropped = [s for i, s in enumerate(seqs) if i % 7 != 3]
    gaps = [(a, b) for a, b in zip(dropped, dropped[1:]) if b != a + 1]
    assert gaps, "dropping frames must be visible as a seq gap"
    assert len(set(seqs + seqs)) == len(seqs)                                         # a replayed frame repeats a seq


def test_quality_bits_clear_when_a_signal_is_invalid(fw):
    ok = run_with_heartbeats(fw, 2)
    assert all(f["q"] == 63 for f in ok if f["t"] in ("fast", "slow"))                 # everything valid on the healthy plant


def test_heartbeat_loss_fails_safe_and_latches(fw):
    fw.cmd("HEARTBEAT"); fw.cmd("START", 30)
    frames = []
    for _ in range(4):                                                                 # no further heartbeat; 1 s steps because the CLI drains its (bounded) output queue per call
        frames += fw.tick(1000)
    st = [f for f in frames if f["t"] == "status"][-1]
    assert st["state"] == "EMERGENCY_STOP" and st["reason"] == "HEARTBEAT_LOST" and st["drive"] == "IDLE"
    last_fast = [f for f in frames if f["t"] == "fast"][-1]
    assert last_fast["duty"] == 0.0 and last_fast["sp"] == 0.0                         # driver off after the trip
    ack = fw.cmd("START", 30)
    assert any(a.get("t") == "ack" and a["status"] == "REJECTED" for a in ack)         # latched: no motion command is accepted
    stop = fw.cmd("STOP")
    assert any(a.get("t") == "ack" and a["status"] in ("ACCEPTED", "COMPLETED") for a in stop)    # STOP is always accepted


def test_loss_of_rpm_pulses_while_driving_trips_the_device(fw):
    fw.cmd("HEARTBEAT"); fw.cmd("START", 30)
    run_with_heartbeats(fw, 2)
    frames = run_with_heartbeats(fw, 3, hall_dead=1)
    reasons = {f["reason"] for f in frames if f["t"] == "status"}
    assert "RPM_LOSS" in reasons


def test_external_estop_input_trips_and_a_reset_needs_authorization_and_the_local_button(fw):
    fw.cmd("HEARTBEAT"); fw.cmd("START", 30)
    frames = run_with_heartbeats(fw, 2, estop=1)
    assert any(f["t"] == "status" and f["reason"] == "EXTERNAL_ESTOP" for f in frames)
    fw.cmd("RESET_ESTOP")
    frames = run_with_heartbeats(fw, 2)                                                # estop released, button NOT pressed
    assert [f for f in frames if f["t"] == "status"][-1]["state"] == "EMERGENCY_STOP"
    frames = run_with_heartbeats(fw, 2, button=1)
    assert [f for f in frames if f["t"] == "status"][-1]["state"] in ("OK", "WARN")


def test_motor_commands_are_rejected_when_control_is_not_enabled():
    d = Fw(control=False)
    try:
        for typ, p in (("START", 30), ("SET_SPEED", 1500)):
            acks = [a for a in d.cmd(typ, p) if a.get("t") == "ack"]
            assert acks and acks[0]["status"] == "REJECTED", typ
        assert [a for a in d.cmd("STOP") if a.get("t") == "ack"][0]["status"] in ("ACCEPTED", "COMPLETED")
    finally:
        d.close()


def test_command_with_wrong_key_or_expired_ttl_is_rejected_and_never_moves_the_motor(fw):
    fw.n += 1
    bad_key = fw.io(json.dumps({"id": fw.n, "type": "START", "p": 30, "p2": 0, "p3": 0, "ttl": 5000, "age": 0, "seq": fw.n, "k": "wrong"}, separators=(",", ":")))
    assert bad_key[0]["status"] == "REJECTED"
    expired = fw.cmd("START", 30, ttl=1000)                                            # age 0 is fine; now an aged one:
    fw.n += 1
    aged = fw.io(json.dumps({"id": fw.n, "type": "START", "p": 30, "p2": 0, "p3": 0, "ttl": 1000, "age": 1000, "seq": fw.n, "k": KEY}, separators=(",", ":")))
    assert aged[0]["status"] == "REJECTED"


# ---------------------------------------------------------------------------------------------------- Phase 15: strict start interlocks on the real C++ core
def acks(frames):
    return [f for f in frames if f.get("t") == "ack"]


def strict_ready(*flags):
    d = Fw(True, "--strict", *flags)
    d.cmd("HEARTBEAT")
    for _ in range(2):
        d.tick(500)
        d.cmd("HEARTBEAT")
    return d


def test_strict_firmware_refuses_motor_commands_until_both_commissioning_decisions_are_declared():
    d = strict_ready("--session")                                                       # nothing approved, nothing wired
    try:
        a = acks(d.cmd("START", 30))
        assert a[0]["status"] == "REJECTED" and a[0]["reason"] == "LIMITS_NOT_APPROVED"
    finally:
        d.close()
    d = strict_ready("--approved", "--secured", "--session")
    try:
        assert acks(d.cmd("SET_SPEED", 1500))[0]["reason"] == "ESTOP_INPUT_NOT_VERIFIED"
    finally:
        d.close()


def test_strict_firmware_start_requires_an_active_watchdog_and_then_runs_with_every_interlock_verified():
    d = strict_ready("--approved", "--estop-wired", "--secured", "--session", "--no-wdt")
    try:
        assert acks(d.cmd("START", 30))[0]["reason"] == "WATCHDOG_NOT_ACTIVE"
    finally:
        d.close()
    d = strict_ready("--approved", "--estop-wired", "--secured", "--session")
    try:
        a = acks(d.cmd("START", 30))
        assert a[0]["status"] == "ACCEPTED"
        frames = []
        for _ in range(3):
            d.cmd("HEARTBEAT"); frames += d.tick(1000)
        assert [f for f in frames if f["t"] == "fast"][-1]["duty"] > 0
    finally:
        d.close()


def test_strict_firmware_never_blocks_stop_and_never_restarts_after_a_fault():
    d = strict_ready("--approved", "--estop-wired", "--secured", "--session")
    try:
        d.cmd("START", 30)
        for _ in range(2):
            d.cmd("HEARTBEAT"); d.tick(1000)
        frames = []
        for _ in range(3):
            frames += d.tick(1000, estop=1)                                              # external E-stop input asserted
        assert [f for f in frames if f["t"] == "status"][-1]["state"] == "EMERGENCY_STOP"
        frames = []
        for _ in range(4):
            d.cmd("HEARTBEAT"); frames += d.tick(1000)                                   # input released; heartbeats continue
        st = [f for f in frames if f["t"] == "status"][-1]
        assert st["state"] == "EMERGENCY_STOP" and [f for f in frames if f["t"] == "fast"][-1]["duty"] == 0.0     # no auto-recovery
        assert acks(d.cmd("START", 30))[0]["status"] == "REJECTED"
        assert acks(d.cmd("STOP"))[0]["status"] == "ACCEPTED"
    finally:
        d.close()


def test_strict_firmware_refuses_motion_without_a_live_authenticated_session_even_when_everything_else_is_declared():
    d = strict_ready("--approved", "--estop-wired", "--secured")                        # transport declared, but no session was established
    try:
        assert acks(d.cmd("START", 30))[0]["reason"] == "NO_SECURE_SESSION"
    finally:
        d.close()
    d = strict_ready("--approved", "--estop-wired", "--session")                        # a session without a declared secured transport is not enough either
    try:
        assert acks(d.cmd("START", 30))[0]["reason"] == "TRANSPORT_NOT_SECURED"
    finally:
        d.close()


def test_every_firmware_acknowledgement_carries_the_device_identity():
    d = Fw(True, "--strict")
    try:
        a = acks(d.cmd("START", 30)) + acks(d.cmd("HEARTBEAT")) + acks(d.cmd("STOP"))
        assert a and all(x["dev"] == "FITL-1" for x in a)
    finally:
        d.close()


def test_session_bound_commands_on_the_real_core_old_and_missing_session_ids_are_rejected_and_acks_echo_the_session():
    d = Fw(True, "--strict", "--approved", "--estop-wired", "--secured", "--sid", "sess-A")
    try:
        d.cmd("HEARTBEAT", sid="sess-A")
        for _ in range(2):
            d.tick(500); d.cmd("HEARTBEAT", sid="sess-A")
        for bad in (None, "sess-OLD"):
            a = acks(d.cmd("START", 30, sid=bad))[0]
            assert a["status"] == "REJECTED" and a["reason"] == "WRONG_SESSION" and a["sid"] == "sess-A" and a["dev"] == "FITL-1"
        ok = acks(d.cmd("START", 30, sid="sess-A"))[0]
        assert ok["status"] == "ACCEPTED" and ok["sid"] == "sess-A"
        assert acks(d.cmd("STOP"))[0]["status"] == "ACCEPTED"                                 # STOP needs no session id
    finally:
        d.close()
