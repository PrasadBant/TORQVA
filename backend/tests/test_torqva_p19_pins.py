"""Static checks of the production firmware's pin configuration (the files the firmware actually compiles). Complements the native pin-map tests. No hardware involved."""
import re
from pathlib import Path

FW = Path(__file__).resolve().parents[2] / "esp32" / "torqva_fw"
PINMAP = (FW / "lib" / "torqva_core" / "pinmap.h").read_text()
MAIN = (FW / "src" / "main.cpp").read_text()
CONF = (FW / "src" / "config_pins.h").read_text()

INTENDED = {"OLED_SCL": 5, "OLED_SDA": 4, "ADXL_SDA": 16, "ADXL_SCL": 17, "INA_SDA": 7, "INA_SCL": 8, "TEMP_DATA": 6, "HALL_INPUT": 9, "LED_MOTOR": 10, "LED_TEMP": 11,
            "LED_ACCEL": 12, "LED_INA": 13, "BUZZER": 14, "R_EN": 18, "L_EN": 21, "RPWM": 38, "LPWM": 39}


def constants():
    out = {}
    for m in re.finditer(r"constexpr int (\w+) = (-?\d+|UNCONFIGURED);", PINMAP):
        out[m.group(1)] = -1 if m.group(2) == "UNCONFIGURED" else int(m.group(2))
    return out


def test_production_pinmap_equals_the_intended_reference_and_has_no_duplicates():
    c = constants()
    for k, v in INTENDED.items():
        assert c[k] == v, k
    owned = [v for k, v in c.items() if v >= 0 and k != "UNCONFIGURED"]
    assert len(owned) == len(set(owned)), "duplicate GPIO ownership"


def test_undocumented_interfaces_are_unconfigured_not_invented():
    c = constants()
    for k in ("MOTOR_RELAY", "LOCAL_RESET_BUTTON", "ESTOP_INPUT"):
        assert c[k] == -1, k


def test_main_cpp_uses_named_pins_only_and_no_other_file_defines_a_gpio():
    for pat in (r"pinMode\(\s*\d", r"digitalWrite\(\s*\d", r"digitalRead\(\s*\d", r"digitalPinToInterrupt\(\s*\d", r"Wire1?\.begin\(\s*\d", r"OneWire \w+\(\s*\d", r"ledc\w+\(\s*\d{2}"):
        assert not re.search(pat, MAIN), pat
    assert "#define PIN_" not in CONF and "#define PIN_" not in MAIN
    for f in (FW / "lib" / "torqva_core").glob("*"):
        if f.name != "pinmap.h" and f.suffix in (".h", ".cpp"):
            assert not re.search(r"\bGPIO\s*\d|constexpr int \w+ = \d+;", f.read_text()) or f.name in ("estop.h",), f.name


def test_reserved_pins_are_not_driven_by_this_firmware():
    outputs = MAIN[MAIN.index("static void outputs_off()"):MAIN.index("static bool pwm_begin()")]
    for reserved in ("OLED_SCL", "OLED_SDA", "ADXL_SDA", "ADXL_SCL"):
        assert reserved not in MAIN.replace("(reserved", ""), reserved            # only named in comments: never configured, never driven
    for driven in ("R_EN", "L_EN", "RPWM", "LPWM", "LED_MOTOR", "BUZZER"):
        assert f"out_low({driven})" in outputs, driven


def test_pwm_failure_keeps_the_driver_disabled_and_is_latched():
    assert "g_pwm_ok = pwm_begin();" in MAIN and "if (!g_pwm_ok || !o.driver_enable || !o.relay_on)" in MAIN
    assert "latch_boot_fault(TripReason::OUTPUT_INIT_FAULT)" in MAIN


def test_wiring_id_stays_unverified_and_fits_the_protocol_bound():
    m = re.search(r'#define TORQVA_WIRING_ID\s+"([^"]+)"', CONF)
    assert m and "UNVERIFIED" in m.group(1) and len(m.group(1)) <= 32
