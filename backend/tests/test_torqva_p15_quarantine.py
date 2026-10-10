"""Phase 15 follow-up: fail-closed configuration of the supported firmware (the legacy-sketch quarantine tests were replaced by test_torqva_p21_legacy_retired.py when the sketch was retired). Static checks of the repository; nothing is built for or sent to hardware."""
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
FW = ROOT / "esp32" / "torqva_fw"
INI = chr(10).join(l for l in (FW / "platformio.ini").read_text().splitlines() if not l.lstrip().startswith(";"))      # comments are not configuration
MAIN = (FW / "src" / "main.cpp").read_text()


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
