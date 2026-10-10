"""Phase 15 follow-up: legacy-firmware quarantine and fail-closed firmware configuration. Static checks of the repository; nothing is built for or sent to hardware."""
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
LEGACY = ROOT / "esp32" / "firmware" / "smart_motor_monitor" / "smart_motor_monitor.ino"
FW = ROOT / "esp32" / "torqva_fw"
INI = chr(10).join(l for l in (FW / "platformio.ini").read_text().splitlines() if not l.lstrip().startswith(";"))      # comments are not configuration
MAIN = (FW / "src" / "main.cpp").read_text()


def test_legacy_sketch_refuses_to_compile_unless_explicitly_acknowledged_before_any_include():
    src = LEGACY.read_text()
    guard = src.index("#ifndef TORQVA_LEGACY_UNSAFE_ACKNOWLEDGED")
    assert guard < src.index("#include"), "the guard must precede every include"
    assert "#error" in src[guard:guard + 400]


@pytest.mark.skipif(not shutil.which("g++"), reason="no host C++ preprocessor")
def test_preprocessor_stops_on_the_guard_and_only_proceeds_when_the_macro_is_defined():
    plain = subprocess.run(["g++", "-E", "-x", "c++", str(LEGACY)], capture_output=True, text=True)
    assert plain.returncode != 0 and "Legacy sketch quarantined" in plain.stderr
    acked = subprocess.run(["g++", "-E", "-x", "c++", "-DTORQVA_LEGACY_UNSAFE_ACKNOWLEDGED", str(LEGACY)], capture_output=True, text=True)
    assert "Legacy sketch quarantined" not in acked.stderr          # past the guard (it then fails on the missing Arduino headers, which is expected here)


def test_no_platformio_environment_builds_the_legacy_sketch():
    assert "firmware/" not in INI and "smart_motor_monitor" not in INI
    assert "src_dir" not in INI and "src_filter" not in INI.replace("build_src_filter", "")
    for env in re.findall(r"^\[env:(\w+)\]", INI, re.M):
        assert env in ("native", "fitl", "esp32s3"), env


def test_user_facing_docs_that_describe_uploading_the_sketch_carry_the_warning():
    for rel in ("docs/software.md", "README.md"):
        t = (ROOT / rel).read_text()
        assert "legacy sketch is quarantined" in t, rel
    assert (ROOT / "esp32" / "firmware" / "README_LEGACY_UNSAFE.md").exists()


# ----------------------------------------------------------------------------------------------- fail-closed configuration of the supported firmware
def test_default_target_builds_with_no_control_commissioning_or_secret_flags():
    env = re.search(r"\[env:esp32s3\](.*?)(?:\n\[|\Z)", INI, re.S).group(1)
    for flag in ("TORQVA_CONTROL_ENABLED", "TORQVA_LIMITS_APPROVED", "TORQVA_ESTOP_INPUT_WIRED", "TORQVA_TRANSPORT_SECURED", "TORQVA_KEY"):
        assert flag not in env, flag


def test_every_commissioning_flag_defaults_to_zero_and_hardware_never_relaxes_interlocks():
    for flag in ("TORQVA_LIMITS_APPROVED", "TORQVA_ESTOP_INPUT_WIRED", "TORQVA_TRANSPORT_SECURED"):
        assert re.search(r"#ifndef %s\n#define %s 0\n" % (flag, flag), MAIN), flag
    assert "cfg.relaxed_interlocks = false" in MAIN
    assert re.search(r"#ifdef TORQVA_CONTROL_ENABLED\s+cfg\.control_enabled = true;\s+#else\s+cfg\.control_enabled = false;", MAIN)


def test_a_control_enabled_build_cannot_carry_the_placeholder_key():
    assert re.search(r"#if defined\(TORQVA_CONTROL_ENABLED\) && !defined\(TORQVA_KEY\)\s*\n#error", MAIN)


def test_motor_outputs_are_forced_off_before_anything_else_in_setup():
    body = MAIN[MAIN.index("void setup() {"):]
    assert body.lstrip("void setup() {").lstrip().startswith("outputs_off();")


def test_watchdog_is_fed_only_after_a_complete_control_iteration_and_not_on_lock_contention():
    task = MAIN[MAIN.index("static void control_task"):MAIN.index("void setup() {")]
    assert task.index("g_dev->step(in)") < task.index("apply(out)") < task.index("esp_task_wdt_reset()")
    contention = task[task.index("!= pdTRUE"):task.index("out = g_dev->step")]
    assert "outputs_off()" in contention and "esp_task_wdt_reset" not in contention
