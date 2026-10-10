"""Phase 23: serial input robustness. The REAL SerialTransport line assembler is fed by an in-memory fake pyserial object (no port is ever opened); the REAL firmware core (fitl CLI)
supplies genuine frames. Nothing here touches COM7 or any hardware."""
import json
import logging
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva import serial_bridge as sb
from torqva.schemas import Role
from torqva.serial_bridge import CmdState, Conn, DeviceBridge, FrameError, MemoryTransport, SerialTransport, parse_frame

FITL = Path(__file__).resolve().parents[2] / "esp32" / "torqva_fw" / ".pio" / "build" / "fitl" / "program.exe"


class FakeSerial:
    """Stands in for serial.Serial: hands out queued chunks, never blocks."""

    def __init__(self, chunks):
        self.chunks, self.written = list(chunks), []

    @property
    def in_waiting(self):
        return len(self.chunks[0]) if self.chunks else 0

    def read(self, n):
        if not self.chunks:
            return b""
        c = self.chunks[0]
        out, rest = c[:n], c[n:]
        if rest:
            self.chunks[0] = rest
        else:
            self.chunks.pop(0)
        return out

    def write(self, d):
        self.written.append(d)

    def flush(self):
        pass

    def close(self):
        pass


def transport(chunks):
    t = SerialTransport("FAKE")
    t._s = FakeSerial(chunks)
    return t


def drain(t, limit=100000):
    out = []
    for _ in range(limit):
        if not t._s.chunks and b"\n" not in t._buf:
            break
        ln = t.read_line(0.01)
        if ln is not None:
            out.append(ln)
    return out


def wait(cond, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    return cond()


def status(seq, **kw):
    f = {"t": "status", "seq": seq, "ts": seq * 100, "fw": "3.0.0", "wiring": "W1", "limits_v": 1, "state": "OK", "reason": "NONE", "mode": "HW", "drive": "IDLE", "ctl": 0, "hb_age": 4294967295,
         "test": 0, "proto": 1, "dev": "RIG-1", "blk": "LIMITS_NOT_APPROVED", "fm": 0}
    f.update(kw)
    return json.dumps(f)


# ------------------------------------------------------------------------------------------ line assembly
def test_a_frame_split_into_single_bytes_is_reassembled_and_parses():
    raw = (status(1) + "\n").encode()
    lines = drain(transport([raw[i:i + 1] for i in range(len(raw))]))
    assert len(lines) == 1 and parse_frame(lines[0])["t"] == "status"


def test_concatenated_frames_without_a_newline_are_rejected_and_with_newlines_both_parse():
    glued = status(1).encode() + status(2).encode() + b"\n"
    ln = drain(transport([glued]))
    assert len(ln) == 1
    with pytest.raises(FrameError):
        parse_frame(ln[0])                                                  # two objects on one line are not one frame
    two = drain(transport([status(1).encode() + b"\n" + status(2).encode() + b"\n"]))
    assert [parse_frame(x)["seq"] for x in two] == [1, 2]


def test_invalid_encodings_are_rejected_not_decoded_leniently():
    for bad in (b"\xff\xfe\xfd", b'{"t":"fast","seq":1,"ts":1}\xc3\x28', b"\x00" * 20, b"\xef\xbb\xbf" + status(1).encode()):
        with pytest.raises(FrameError):
            parse_frame(bad)


def test_a_megabyte_without_a_newline_keeps_the_buffer_bounded_and_the_next_valid_line_survives():
    t = transport([b"A" * 1000 for _ in range(1000)] + [b"\n" + status(7).encode() + b"\n"])
    biggest = 0
    lines = []
    for _ in range(5000):
        if not t._s.chunks and b"\n" not in t._buf:
            break
        ln = t.read_line(0.01)
        biggest = max(biggest, len(t._buf))
        if ln is not None:
            lines.append(ln)
    assert biggest <= sb.MAX_LINE * 2 + 300, biggest
    assert any(l.startswith(b"{") and parse_frame(l)["seq"] == 7 for l in lines)


@pytest.mark.skipif(not FITL.exists(), reason="fitl CLI not built (pio run -e fitl)")
def test_genuine_firmware_frames_survive_arbitrary_chunking_and_pass_the_real_parser():
    p = subprocess.Popen([str(FITL), "--strict", "--accel"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
    lines = []
    for _ in range(8):
        p.stdin.write('{"tick":500}\n'); p.stdin.flush()
        while True:
            l = p.stdout.readline().strip()
            if l == "#":
                break
            lines.append(l)
    p.stdin.close(); p.wait(timeout=3)
    stream = ("\n".join(lines) + "\n").encode()
    for step in (1, 3, 7, 64):
        got = drain(transport([stream[i:i + step] for i in range(0, len(stream), step)]))
        assert len(got) == len(lines) and {parse_frame(g)["t"] for g in got} >= {"fast", "slow", "status"}


# ------------------------------------------------------------------------------------------ floods are bounded
def test_a_legacy_text_flood_keeps_logs_samples_events_and_cpu_bounded(caplog, monkeypatch):
    monkeypatch.setattr(sb, "HANDSHAKE_TIMEOUT_S", 0.3)
    caplog.set_level(logging.DEBUG)
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr)
    t0 = time.time()
    for batch in range(10):                                                   # the in-memory queue itself is bounded (1000), so feed in paced batches
        for i in range(500):
            tr.feed(b"STATUS              : MOTOR OFF %d" % (i % 3))
        assert wait(lambda: b.model.counters["malformed"] >= (batch + 1) * 500, 15)
    assert time.time() - t0 < 15
    assert len(caplog.records) < 50                                           # no log line per rejected line
    assert len(b.model.samples) <= 20 and all(len(s) <= 200 for s in b.model.samples)
    assert b.hub is not None
    snap = b.snapshot()
    assert snap["handshake"] is False and snap["label"] == "SIMULATION" and len(json.dumps(snap)) < 20000
    b.disconnect()


# ------------------------------------------------------------------------------------------ latches, reconnects, replay
def test_bad_frames_and_reconnects_never_clear_a_latch_enable_control_or_replay_a_command():
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr)
    tr.feed(status(0, state="EMERGENCY_STOP", reason="OVER_CURRENT_INSTANT", fm=1))
    assert wait(lambda: b.model.conn == Conn.CONNECTED)
    for i in range(300):
        tr.feed(b"OVERALL CONDITION garbage %d" % i)
    assert wait(lambda: b.model.counters["malformed"] >= 300)
    snap = b.snapshot()
    assert snap["safety_state"] == "EMERGENCY_STOP" and any("LATCHED" in x for x in snap["control_blockers"])
    stop = b.request_command("STOP", {}, "olga", Role.OPERATOR)
    assert stop.state in (CmdState.SENT, CmdState.ACKNOWLEDGED)                  # STOP is always permitted
    n_sent = len(tr.written)
    b.disconnect()
    tr2 = MemoryTransport(); b.connect(tr2)                                      # reconnect: a NEW session, nothing carried over
    assert tr2.written == [] and n_sent == 1
    snap = b.snapshot()
    assert snap["handshake"] is False and snap["safety_state"] is None
    assert "DEVICE NOT CONNECTED" in snap["control_blockers"]
    assert b.request_command("START", {"duty_pct": 10}, "olga", Role.OPERATOR).state == CmdState.REJECTED
    assert tr2.written == []
    b.disconnect()
