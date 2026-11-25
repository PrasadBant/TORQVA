// THE authoritative GPIO map for the TORQVA firmware. Pure constants (no Arduino dependency) so the firmware (src/main.cpp) and the native tests use the SAME table.
//
// Source: the operator's legacy sketch (smart_motor_monitor, since retired from the tree; Git history only, "TORQVA - ESP32-S3 N16R8"), used as the INTENDED wiring reference. That is evidence of intent, NOT proof that the
// physical wires match: the wiring id reported in every status frame stays "...-UNVERIFIED" until a person confirms the real wiring.
// Target: ESP32-S3 N16R8 (16 MB flash, 8 MB octal PSRAM) per the project's PlatformIO environments and the sketch header; the actual module is not confirmed.
//
// Interfaces that have NO documented pin are UNCONFIGURED (-1). They are never given a guessed GPIO, and everything that depends on them stays disabled:
//   MOTOR_RELAY          no power relay documented  -> the firmware drives no relay
//   LOCAL_RESET_BUTTON   no reset button documented -> a latched trip can only be cleared by a power cycle (the device-side reset needs the button)
//   (ESTOP_INPUT is now assigned GPIO 15 as a MONITORING input; see below. The firmware reads it and reports its state, but the start interlock stays closed until a person declares the
//    circuit installed and verified with -DTORQVA_ESTOP_INPUT_WIRED=1. The ESP32 GPIO is NOT the emergency stop: an independent hardware circuit must remove motor-driver power.)
#pragma once

namespace torqva_pins {

constexpr int UNCONFIGURED = -1;

// OLED SH1106, software I2C (driven by src/main.cpp when TORQVA_OLED=1: annunciation only)
constexpr int OLED_SCL = 5;
constexpr int OLED_SDA = 4;
// ADXL345 accelerometer, I2C bus 0 (read by src/main.cpp: RAW acceleration; the total magnitude includes gravity and is not vibration RMS)
constexpr int ADXL_SDA = 16;
constexpr int ADXL_SCL = 17;
// INA219 current/voltage sensor, separate I2C bus (TwoWire 1)
constexpr int INA_SDA = 7;
constexpr int INA_SCL = 8;
// DS18B20 one-wire data (index 0 = housing; a second sensor, if fitted, = ambient)
constexpr int TEMP_DATA = 6;
// Hall-effect RPM input (interrupt)
constexpr int HALL_INPUT = 9;
// Status annunciators (not safety functions)
constexpr int LED_MOTOR = 10;
constexpr int LED_TEMP = 11;
constexpr int LED_ACCEL = 12;
constexpr int LED_INA = 13;
constexpr int BUZZER = 14;
// BTS7960 / IBT-2 motor driver
constexpr int R_EN = 18;
constexpr int L_EN = 21;
constexpr int RPWM = 38;
constexpr int LPWM = 39;
// No documented pin: unconfigured, never invented
constexpr int MOTOR_RELAY = UNCONFIGURED;
constexpr int LOCAL_RESET_BUTTON = UNCONFIGURED;
// E-stop MONITORING input, proposed by the owner: a normally-closed contact between GPIO 15 and GND with a pull-up. Healthy (closed) reads LOW; a pressed switch, a broken wire or an
// unconnected input reads HIGH = emergency-stop condition. GPIO 15 is a plain GPIO on the ESP32-S3 (it is the 32 kHz crystal pad XTAL_32K_P and is free when no 32 kHz crystal is fitted);
// the board schematic / header must confirm that, which this software cannot do.
constexpr int ESTOP_INPUT = 15;

struct PinEntry {
    const char* name;
    int gpio;            // UNCONFIGURED (-1) = no documented pin
    const char* group;   // peripheral or bus the pin belongs to
    bool required;       // must be assigned for the documented hardware
};

static const PinEntry kPins[] = {
    {"OLED_SCL", OLED_SCL, "oled_i2c_sw", true},           {"OLED_SDA", OLED_SDA, "oled_i2c_sw", true},
    {"ADXL_SDA", ADXL_SDA, "adxl_i2c0", true},             {"ADXL_SCL", ADXL_SCL, "adxl_i2c0", true},
    {"INA_SDA", INA_SDA, "ina_i2c1", true},                {"INA_SCL", INA_SCL, "ina_i2c1", true},
    {"TEMP_DATA", TEMP_DATA, "onewire", true},             {"HALL_INPUT", HALL_INPUT, "hall", true},
    {"LED_MOTOR", LED_MOTOR, "annunciator", true},         {"LED_TEMP", LED_TEMP, "annunciator", true},
    {"LED_ACCEL", LED_ACCEL, "annunciator", true},         {"LED_INA", LED_INA, "annunciator", true},
    {"BUZZER", BUZZER, "annunciator", true},
    {"R_EN", R_EN, "bts7960", true},                       {"L_EN", L_EN, "bts7960", true},
    {"RPWM", RPWM, "bts7960", true},                       {"LPWM", LPWM, "bts7960", true},
    {"MOTOR_RELAY", MOTOR_RELAY, "relay", false},          {"LOCAL_RESET_BUTTON", LOCAL_RESET_BUTTON, "button", false},
    {"ESTOP_INPUT", ESTOP_INPUT, "estop", true},
};
static const int kPinCount = (int)(sizeof(kPins) / sizeof(kPins[0]));

// Pins the ESP32-S3 N16R8 module cannot use as ordinary GPIO, or that this project keeps free for its transport:
//  0, 3, 45, 46   boot strapping            19, 20   native USB D-/D+ (esp32s3 serial transport)
//  26-32          SPI flash                 33-37    octal PSRAM (N16R8)
//  43, 44         UART0 TX/RX (esp32s3_uart serial transport via the CH343 bridge)
// Source: ESP-IDF GPIO documentation for the ESP32-S3 and the module datasheet; a software table cannot prove the board matches.
inline bool gpio_unavailable_on_n16r8(int g) {
    if (g < 0 || g > 48) return true;
    if (g == 0 || g == 3 || g == 45 || g == 46) return true;
    if (g == 19 || g == 20) return true;
    if (g >= 26 && g <= 37) return true;
    if (g == 43 || g == 44) return true;
    return false;
}

}  // namespace torqva_pins
