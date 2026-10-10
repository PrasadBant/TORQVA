"""Bring-up checks (no board is touched): the supported firmware's frames must pass the REAL backend validator, the legacy text must not, and the PlatformIO environments must be
what the bring-up procedure says. The frames come from the real C++ core (fitl); this is a protocol test, NOT a USB connection."""
import json
import re
import subprocess
from pathlib import Path

import pytest

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))
from torqva.serial_bridge import FrameError, parse_frame, DeviceModel, Q_BITS

ROOT = Path(__file__).resolve().parents[2]
FW = ROOT / "esp32" / "torqva_fw"
EXE = FW / ".pio" / "build" / "fitl" / "program.exe"
INI = "\n".join(l for l in (FW / "platformio.ini").read_text().splitlines() if not l.lstrip().startswith(";"))


def env(name):
    m = re.search(r"\[env:%s\](.*?)(?:\n\[|\Z)" % name, INI, re.S)
    return m.group(1) if m else ""


@pytest.mark.skipif(not EXE.exists(), reason="fitl CLI not built (pio run -e fitl)")
def test_every_frame_the_firmware_emits_passes_the_real_backend_validator_and_the_handshake_fields_are_present():
    p = subprocess.Popen([str(EXE), "--strict"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

    def io(line):
        p.stdin.write(line + "\n"); p.stdin.flush(); out = []
        while True:
            l = p.stdout.readline().strip()
            if l == "#":
                return out
            out.append(l)
    lines = []
    for _ in range(6):
        lines += io('{"tick":500}')
    p.stdin.close(); p.wait(timeout=3)
    kinds, model = set(), DeviceModel()
    for i, l in enumerate(lines):
        f = parse_frame(l)                                  # raises FrameError if the firmware ever emitted something the backend rejects
        kinds.add(f["t"])
        model.ingest(f, float(i), float(i))
    assert {"fast", "slow", "status"} <= kinds
    st = model.status
    assert st["proto"] == 1 and st["dev"] == "FITL-1" and st["blk"] == "LIMITS_NOT_APPROVED" and st["mode"] in ("SIM", "HW")
    assert (st["state"] == "OK") == (st["fm"] == 0)                         # a latched fault (here HEARTBEAT_LOST: no heartbeat was sent in 3 s) is always visible in the mask
    assert model.counters["gaps"] == 0 and model.counters["duplicates"] == 0                 # one gapless shared sequence
    assert model.values["rpm"]["valid"] and model.values["housing"]["valid"]
    assert all(len(l) <= 287 for l in lines)                                                  # fits the firmware line buffer and the backend bound


@pytest.mark.parametrize("legacy", ["--- OVERALL CONDITION ---", "STATUS              : MOTOR OFF", "[MOTOR] BTS7960 Driver DEACTIVATED: MOTOR OFF", "BUZZER              : OFF", "[TCP RX] Command received: 'MOTOR_ON'"])
def test_legacy_sketch_text_is_never_valid_telemetry(legacy):
    with pytest.raises(FrameError):
        parse_frame(legacy)


def test_a_status_frame_from_an_older_or_different_protocol_is_refused():
    old = json.dumps({"t": "status", "seq": 1, "ts": 1, "fw": "2.0.0", "wiring": "W", "limits_v": 1, "state": "OK", "reason": "NONE", "mode": "HW", "drive": "IDLE", "ctl": 0, "hb_age": 0, "test": 0})
    with pytest.raises(FrameError) as e:
        parse_frame(old)
    assert e.value.code == "UNSUPPORTED_PROTOCOL"


def test_platformio_environments_match_the_bringup_procedure():
    usb, uart = env("esp32s3"), env("esp32s3_uart")
    assert "board = esp32-s3-devkitc-1" in usb and "ARDUINO_USB_CDC_ON_BOOT=1" in usb                  # serial on the NATIVE USB port
    assert "extends = env:esp32s3" in uart and "ARDUINO_USB_CDC_ON_BOOT=0" in uart and "ARDUINO_USB_CDC_ON_BOOT=1" not in uart   # serial on UART0 = the CH343 bridge port
    for e in (usb, uart):
        for forbidden in ("TORQVA_CONTROL_ENABLED", "TORQVA_LIMITS_APPROVED", "TORQVA_ESTOP_INPUT_WIRED", "TORQVA_TRANSPORT_SECURED", "TORQVA_KEY", "upload_", "-t upload"):
            assert forbidden not in e, forbidden
    assert re.findall(r"^\[env:(\w+)\]", INI, re.M) == ["native", "fitl", "esp32s3", "esp32s3_uart"]


@pytest.mark.skipif(not (FW / ".pio" / "build" / "esp32s3_uart" / "firmware.elf").exists(), reason="esp32s3_uart not built")
def test_built_artifact_is_torqva_firmware_not_the_legacy_sketch():
    b = (FW / ".pio" / "build" / "esp32s3_uart" / "firmware.elf").read_bytes()
    assert b.count(b'"proto":%u') >= 1 and b"NO_SECURE_SESSION" in b and b"LIMITS_NOT_APPROVED" in b and b"UNPROVISIONED" in b
    assert b"MOTOR_ON" not in b and b"smart_motor" not in b and b"BTS7960" not in b
