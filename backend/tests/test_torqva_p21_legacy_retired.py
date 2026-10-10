"""Phase 21: the legacy smart_motor_monitor firmware is RETIRED from the tracked tree; esp32/torqva_fw is the sole supported firmware. Replaces the old quarantine tests (compile guards of the
removed sketch). Static repository checks plus MemoryTransport protocol tests: no serial port is opened, nothing is flashed, no device command reaches any device."""
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva.schemas import Role
from torqva.serial_bridge import CmdState, Conn, DeviceBridge, FrameError, MemoryTransport, parse_frame
from torqva import serial_bridge as sb

ROOT = Path(__file__).resolve().parents[2]
FW = ROOT / "esp32" / "torqva_fw"
INI_RAW = (FW / "platformio.ini").read_text()
INI = "\n".join(l for l in INI_RAW.splitlines() if not l.lstrip().startswith(";"))          # comments are not configuration

# historical records: allowed to MENTION the retired sketch, but only together with the word "retired" (they are annotated, not rewritten)
HISTORICAL = {"docs/ARCHITECTURE.md", "docs/NEW_LAPTOP_SETUP_REPORT.md", "docs/PHASE_6_HARDWARE_VALIDATION_REPORT.md", "docs/TORQVA_AUDIT.md", "docs/TORQVA_HARDWARE_READINESS.md",
              "docs/TORQVA_PROGRESS.md", "communication/PROTOCOL_DOCS.md", "communication/TCP_PROTOCOL.md"}
CURRENT_DOCS = ["README.md", "esp32/README.md", "docs/software.md", "docs/hardware.md", "docs/HARDWARE_WIRING.md"]


def tracked():
    if not shutil.which("git"):
        pytest.skip("git not available")
    r = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        pytest.skip("not a git checkout")
    return [f for f in r.stdout.split("\0") if f and (ROOT / f).is_file()]      # tracked AND present (a staged deletion is not "present")


def text(rel):
    return (ROOT / rel).read_text(encoding="utf-8", errors="replace")


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


# ====================================================================================== the legacy source is gone
def test_legacy_firmware_source_is_absent_from_the_tracked_tree_and_the_working_tree():
    files = tracked()
    assert not [f for f in files if f.lower().endswith((".ino", ".pde"))], "an Arduino sketch is tracked"
    assert not [f for f in files if "smart_motor_monitor" in f.lower() or f.startswith("esp32/firmware/")], "legacy firmware paths are tracked"
    assert not (ROOT / "esp32" / "firmware").exists()
    assert not (ROOT / "esp32" / "firmware" / "smart_motor_monitor" / "smart_motor_monitor.ino").exists()
    assert (FW / "platformio.ini").exists() and (FW / "src" / "main.cpp").exists()           # the supported firmware is still there


def test_no_tracked_source_contains_the_legacy_compile_guards_or_the_tcp_motor_command_handler():
    for f in tracked():
        if f.startswith(("backend/tests/", "docs/", "communication/")) or not f.endswith((".cpp", ".h", ".c", ".ino", ".ini", ".py", ".ps1", ".sh", ".bat", ".mjs", ".js", ".jsx")):
            continue
        t = text(f)
        assert "TORQVA_LEGACY_UNSAFE_ACKNOWLEDGED" not in t and "TORQVA_LEGACY_ENABLE_MOTOR" not in t, f
    for f in tracked():
        if f.startswith("esp32/"):
            assert "MOTOR_ON" not in text(f) or f.endswith(".md"), f              # the supported firmware has no text MOTOR_ON command


def test_no_script_workflow_or_build_file_selects_the_legacy_sketch():
    for f in tracked():
        if f.endswith((".ps1", ".sh", ".bat", ".cmd", ".yml", ".yaml", ".json", ".toml", ".ini", ".cfg", ".mjs", ".cjs")) and not f.startswith("docs/eval/") and "package-lock" not in f:
            t = text(f)
            assert "smart_motor_monitor" not in t and "esp32/firmware" not in t, f
            assert "arduino-cli" not in t.lower(), f
    assert "smart_motor_monitor" not in INI and "firmware/" not in INI
    assert "default_envs" not in INI and "upload_port" not in INI and "src_dir" not in INI                  # nothing selects a build or an upload target by default


# ====================================================================================== docs
def test_every_mention_of_the_legacy_sketch_is_marked_retired_and_current_docs_give_no_upload_instructions():
    for f in tracked():
        if not f.endswith((".md", ".h", ".cpp", ".py", ".txt")) or f.startswith(("backend/tests/", "docs/eval/")):
            continue
        t = text(f)
        if "smart_motor_monitor" in t:
            assert re.search(r"retired", t, re.I), f"{f} mentions the legacy sketch without saying it is retired"
    for f in CURRENT_DOCS:
        for line in text(f).splitlines():
            if re.search(r"smart_motor_monitor", line) and re.search(r"open|upload|flash|compile|select|set", line, re.I):
                assert re.search(r"retired|history", line, re.I), f"{f}: {line.strip()[:120]}"
            assert "esp32/firmware/" not in line.replace("esp32/firmware/ (", ""), f"{f}: points at the removed esp32/firmware directory"
            if "Ctrl+U" in line or re.search(r"(open|compile|upload|flash)[^.]{0,60}(in|with|using)\s+(the\s+)?Arduino IDE", line, re.I):      # (a COM-port-holder hint naming the IDE is not an instruction)
                assert re.search(r"retired|not used|history", line, re.I), f"{f}: {line.strip()[:120]}"
    for f in HISTORICAL:
        assert re.search(r"retired", text(f), re.I), f


def test_current_docs_state_the_supported_firmware_the_retirement_and_that_hardware_is_not_ready():
    for f in ("README.md", "docs/software.md", "esp32/README.md"):
        t = text(f)
        assert "esp32/torqva_fw" in t and "sole supported firmware" in t, f
        assert re.search(r"retired", t, re.I), f
        assert "STATUS: MOTOR OFF" in t, f"{f} must say old serial text is not valid TORQVA telemetry"
        assert "not ready for physical motor operation" in t, f
    assert "current TORQVA" in text("README.md") and "protocol" in text("README.md")
    e = text("esp32/README.md")
    for env in ("native", "fitl", "esp32s3_uart", "esp32s3"):
        assert f"`{env}`" in e, env
    assert "UART0" in e and "native USB" in e and "not merged" in e


# ====================================================================================== supported PlatformIO environments
def test_supported_platformio_environments_remain_and_are_not_merged():
    assert re.findall(r"^\[env:(\w+)\]", INI, re.M) == ["native", "fitl", "esp32s3", "esp32s3_uart"]
    uart = re.search(r"\[env:esp32s3_uart\](.*?)(?:\n\[|\Z)", INI, re.S).group(1)
    usb = re.search(r"\[env:esp32s3\](.*?)(?:\n\[|\Z)", INI, re.S).group(1)
    assert "ARDUINO_USB_CDC_ON_BOOT=1" in usb and "ARDUINO_USB_CDC_ON_BOOT=0" in uart and "extends = env:esp32s3" in uart
    for e in (usb, uart):
        assert "TORQVA_CONTROL_ENABLED" not in e and "upload_port" not in e and "-t upload" not in e                     # control stays compiled out; no upload target is selected


def test_gpio_map_is_unchanged_by_the_retirement():
    pm = text("esp32/torqva_fw/lib/torqva_core/pinmap.h")
    expected = (("OLED_SDA", 4), ("OLED_SCL", 5), ("TEMP_DATA", 6), ("INA_SDA", 7), ("INA_SCL", 8), ("HALL_INPUT", 9), ("LED_MOTOR", 10), ("LED_TEMP", 11), ("LED_ACCEL", 12), ("LED_INA", 13),
                ("BUZZER", 14), ("ADXL_SDA", 16), ("ADXL_SCL", 17), ("R_EN", 18), ("L_EN", 21), ("RPWM", 38), ("LPWM", 39))
    for name, pin in expected:
        assert re.search(r"constexpr int %s\s*=\s*%d;" % (name, pin), pm), f"{name} {pin}"
    for name in ("MOTOR_RELAY", "LOCAL_RESET_BUTTON", "ESTOP_INPUT"):                      # never invented
        assert re.search(r"constexpr int %s\s*=\s*UNCONFIGURED;" % name, pm), name


# ====================================================================================== legacy telemetry is not TORQVA telemetry
LEGACY_LINES = ["STATUS: MOTOR OFF", "STATUS              : MOTOR OFF", "MOTOR_ON", "MOTOR_OFF", "MOTOR_ON_ACK", "MOTOR_OFF_ACK", "--- OVERALL CONDITION ---",
                "[MOTOR] BTS7960 Driver DEACTIVATED: MOTOR OFF", "BUZZER              : OFF", "[TCP RX] Command received: MOTOR_ON",
                '{"device_id":"ESP32-MOTOR-01","temperature":42.6,"rpm":1450,"motor_running":false}']


@pytest.mark.parametrize("line", LEGACY_LINES)
def test_the_protocol_parser_rejects_legacy_text(line):
    with pytest.raises(FrameError):
        parse_frame(line)


def test_legacy_or_malformed_lines_never_complete_a_handshake_or_activate_physical_mode(monkeypatch):
    monkeypatch.setattr(sb, "HANDSHAKE_TIMEOUT_S", 0.3)
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr)
    for line in LEGACY_LINES:
        tr.feed(line)
    tr.feed('{"t":"fast","seq":1,"ts":100,"rpm":1200.0,"sp":0.0,"duty":30.0,"v":24.0,"i":1.5,"p":36.0,"q":63}')          # telemetry without a status handshake is not a device either
    tr.feed(status(2, proto=2))                                                                                          # a different protocol version is refused
    tr.feed(status(3, mode="PHYSICAL"))                                                                                  # an unknown mode is refused
    assert wait(lambda: b.model.last_error_code == "HANDSHAKE_INVALID", 3)
    snap = b.snapshot()
    assert snap["handshake"] is False and snap["origin"] == "none" and snap["label"] == "SIMULATION"
    assert snap["state_label"] != "PHYSICAL DEVICE CONNECTED" and "PHYSICAL" not in snap["state_label"].replace("NON-TORQVA", "")
    assert b.model.counters["malformed"] >= len(LEGACY_LINES)
    assert tr.written == []                                                                                               # nothing was sent to the "device"
    b.disconnect()


def test_the_backend_never_treats_a_legacy_sketch_as_a_valid_torqva_device(monkeypatch):
    monkeypatch.setattr(sb, "HANDSHAKE_TIMEOUT_S", 0.3)
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr)
    for line in ("--- OVERALL CONDITION ---", "STATUS              : MOTOR OFF", "BUZZER              : OFF"):
        tr.feed(line)
    assert wait(lambda: b.model.last_error_code == "HANDSHAKE_INVALID", 3)
    err = b.snapshot()["error"]
    assert "legacy monitoring sketch" in err["message"] and any("retired" in r for r in err["recovery"])             # recognised only to explain the failure
    assert b.model.conn != Conn.CONNECTED and b.snapshot()["values"]["rpm"] is None
    for action, params in (("STOP", {}), ("START", {"duty_pct": 30}), ("SET_SPEED", {"rpm": 1500})):
        rec = b.request_command(action, params, "olga", Role.OPERATOR)
        assert rec.state == CmdState.REJECTED, action                                                                   # no command reaches a non-TORQVA board
    assert tr.written == []
    b.disconnect()


# ====================================================================================== physical motor control stays disabled
def test_physical_motor_controls_stay_disabled_while_commissioning_is_incomplete():
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr)
    tr.feed(status(0))
    assert wait(lambda: b.model.conn == Conn.CONNECTED)
    for action, params in (("START", {"duty_pct": 30}), ("SET_SPEED", {"rpm": 1500})):
        rec = b.request_command(action, params, "olga", Role.OPERATOR)
        assert rec.state == CmdState.REJECTED
    blockers = b.control_blockers()
    assert "PHYSICAL CONTROL DISABLED" in blockers and "SECURE DEVICE TRANSPORT NOT CONFIGURED" in blockers and "SAFETY LIMITS NOT APPROVED" in blockers
    assert tr.written == []
    b.disconnect()


def test_supported_firmware_default_build_keeps_motor_control_compiled_out():
    assert "TORQVA_CONTROL_ENABLED" not in INI                                  # enabling control is a deliberate, separate human decision
    main = text("esp32/torqva_fw/src/main.cpp")
    assert "#ifdef TORQVA_CONTROL_ENABLED" in main and "#define TORQVA_CONTROL_ENABLED" not in main      # only an explicit build flag can compile the actuation path in


# ====================================================================================== interlock display (Phase 22)
def test_interlocks_are_honest_without_a_device_and_hardware_facts_are_never_verified():
    b = DeviceBridge()
    il = {r["id"]: r["status"] for r in b.snapshot()["interlocks"]}
    assert il["handshake"] == "UNAVAILABLE" and il["telemetry"] == "UNAVAILABLE" and il["sensors"] == "UNAVAILABLE"
    assert il["session"] == "BLOCKED" and il["supervisor"] == "BLOCKED" and il["commissioning"] == "BLOCKED"
    assert il["estop"] == "NOT VERIFIED" and il["driver"] == "NOT VERIFIED" and il["watchdog"] == "NOT VERIFIED"


def test_a_healthy_handshake_still_leaves_every_physical_interlock_open():
    b = DeviceBridge(); tr = MemoryTransport(); b.connect(tr)
    tr.feed(status(0, dev="RIG-1"))
    assert wait(lambda: b.model.conn == Conn.CONNECTED)
    il = {r["id"]: r["status"] for r in b.snapshot()["interlocks"]}
    assert il["handshake"] == "VERIFIED" and il["limits"] == "BLOCKED"
    for k in ("session", "supervisor", "commissioning"):
        assert il[k] == "BLOCKED"
    for k in ("estop", "driver", "watchdog"):
        assert il[k] == "NOT VERIFIED"                      # absence of a reported failure is not verification
    tr.feed(status(1, state="EMERGENCY_STOP", reason="OVER_CURRENT_INSTANT", fm=1))
    assert wait(lambda: {r["id"]: r["status"] for r in b.snapshot()["interlocks"]}["fault"] == "BLOCKED")
    b.disconnect()
