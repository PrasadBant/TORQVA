// TORQVA device firmware (ESP32-S3). Thin hardware layer around torqva_core::Device.
//
// SAFETY POSTURE OF THIS BUILD:
//  * All motor outputs are driven to the OFF state before anything else runs.
//  * Motor commands require a provisioned key, an authenticated session, the configured hardware checks,
//    approved limits and TORQVA_CONTROL_ENABLED=1. Telemetry works when control is unavailable.
//  * Software builds and tests do not establish physical hardware readiness.
#include <Arduino.h>
#include <Wire.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Adafruit_INA219.h>
#include <esp_task_wdt.h>
#include <esp_system.h>
#include <Preferences.h>
#include "drivers/adxl345.h"
#ifndef TORQVA_OLED
#define TORQVA_OLED 1          // local SH1106 status display on the software-I2C pins 4/5 (annunciation only; never a decision input)
#endif
#if TORQVA_OLED
#include <U8g2lib.h>
#endif
#include "drivers/config_pins.h"
#include "shared/device.h"
#include "communication/wifi_link.h"
#include "communication/ota_esp32.h"
#include "communication/usb_out.h"                                   // the only USB serial writer: whole lines or nothing, never waits on the host (1.1.2)

using namespace torqva;

// A production motor build loads its per-device authentication key from NVS; no key is embedded in the image.
// OTA LED bench profile (platformio env:esp32s3_ota_led_*): an ESP32-S3 with ONE LED on GPIO 5 and no motor hardware. Motor control is compiled out, the
// PWM peripheral is never set up, no sensor is initialised (every reading is reported invalid, nothing is invented) and the OLED is off so GPIO 5 is free.
// See docs/testing/TORQVA_OTA_LED_BENCH_TEST.md. Production builds never define TORQVA_OTA_LED_BENCH and are unchanged.
#ifndef TORQVA_OTA_LED_BENCH
#define TORQVA_OTA_LED_BENCH 0
#endif
#if TORQVA_OTA_LED_BENCH
#if defined(TORQVA_CONTROL_ENABLED)
#error "the OTA LED bench profile must never be built with motor control enabled (TORQVA_CONTROL_ENABLED)"
#endif
#if !defined(TORQVA_OLED) || TORQVA_OLED
#error "the OTA LED bench profile uses GPIO 5 (the OLED clock) for its LED: build it with -DTORQVA_OLED=0"
#endif
#if !defined(TORQVA_BENCH_BLINK_MS) || TORQVA_BENCH_BLINK_MS < 50
#error "the OTA LED bench profile needs -DTORQVA_BENCH_BLINK_MS (LED half-period, >= 50 ms)"
#endif
#elif defined(TORQVA_BENCH_BLINK_MS)
#error "TORQVA_BENCH_BLINK_MS belongs to the OTA LED bench profile only"
#endif
// The same authenticated device protocol can use the Wi-Fi link in a dedicated production build.
// The backend owns one authoritative transport; USB remains available for recovery.
// ---- Commissioning decisions (human-owned). Both default to 0 = motor-energising commands are REFUSED by the start interlocks (interlock.h).
//  TORQVA_LIMITS_APPROVED     1 only after a responsible person approved the safety-trip limits for this motor, driver, PSU and cooling (see docs/hardware/TORQVA_HARDWARE_READINESS.md).
//  TORQVA_ESTOP_INPUT_WIRED   1 only after an independent emergency-stop input exists with a documented wiring contract AND config_pins.h defines its pin;
//                             The firmware READS GPIO 15 (NC contact to GND, pull-up: closed = LOW = healthy) and reports its state in every status frame, but this flag is the owner's
//                             declaration that the independent hardware circuit is installed and verified. Default 0: the input is monitored, not enforced, and motion stays refused.
// Device identity reported to the backend bridge. A label (NOT authentication, NOT a secret); set per unit with -DTORQVA_DEVICE_ID=\"...\". The default is deliberately
// recognisable as unprovisioned, and the bridge reports an unprovisioned or mismatching identity as unverified.
#ifndef TORQVA_DEVICE_ID
#define TORQVA_DEVICE_ID "UNPROVISIONED"
#endif
#ifndef TORQVA_LIMITS_APPROVED
#define TORQVA_LIMITS_APPROVED 0
#endif
//  TORQVA_TRANSPORT_SECURED   1 = the owner accepts the AUTHENTICATED USB link as the trust boundary: per-device key, HMAC-SHA-256 sessions and commands, replay protection, session expiry.
//                             It is NOT ENCRYPTED and is valid only for a direct USB connection to a controlled local PC (not network-exposed, not USB-over-IP). Without a provisioned key no session
//                             can exist, so motion stays refused (NO_SECURE_SESSION) whatever this flag says.
#ifndef TORQVA_TRANSPORT_SECURED
#define TORQVA_TRANSPORT_SECURED 0
#endif
#ifndef TORQVA_ESTOP_INPUT_WIRED
#define TORQVA_ESTOP_INPUT_WIRED 0
#endif
// Task watchdog timeout. ASSUMPTION (engineering choice to be reviewed, not a validated figure): the control task period is 10 ms and a normal iteration is
// well under 1 ms, so 2 s is generous while still being shorter than a human reaction. It is a panic-reset watchdog: a reset leaves the pins high-impedance until
// setup() runs outputs_off(), so the driver-enable and relay nets MUST be pulled to the OFF level in hardware (documented requirement; not verifiable here).
#ifndef TORQVA_WDT_TIMEOUT_S
#define TORQVA_WDT_TIMEOUT_S 2
#endif
// Raw acceleration older than this is not valid. ASSUMPTION: read at 10 Hz; 1 s tolerates a few missed reads.
#define TORQVA_ACCEL_STALE_MS 1000u
// A sensor reading older than this is not valid. ASSUMPTION: DS18B20 is read every 1 s, the INA219 every cycle; 3 s tolerates two lost conversions.
#define TORQVA_TEMP_STALE_MS 3000u
#define TORQVA_INA219_ADDR 0x40            // Adafruit default address; change if the A0/A1 straps differ


// Firmware identity embedded in the image, read by the backend's release validation (backend/torqva/device/firmware/firmware.py) so a release version is taken from
// the binary, never from what an uploader types. Kept by setup() below so the linker cannot drop it.
#if TORQVA_OTA_LED_BENCH
extern "C" const char TORQVA_FW_ID[] __attribute__((used)) = "TORQVA_FW_ID:ver=" TORQVA_FW_VERSION ";chip=esp32s3;proto=1;prof=ota_led_bench;";
#else
extern "C" const char TORQVA_FW_ID[] __attribute__((used)) = "TORQVA_FW_ID:ver=" TORQVA_FW_VERSION ";chip=esp32s3;proto=1;";
#endif

// ---------- hardware outputs ----------
using namespace torqva_pins;


// Drive a pin LOW only if it is configured (an UNCONFIGURED pin is never touched).
static void out_low(int pin) {
    if (pin == UNCONFIGURED) return;
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
}

static bool g_pwm_ok = false;           // the driver is eligible to operate only if the PWM peripheral was set up (see setup())

static void pwm_write(float duty_pct);

// Everything that can energise or annunciate goes to the OFF level. Driver enables and PWM first. The OLED and ADXL345 pins are RESERVED and deliberately left untouched
// (this firmware drives no display and reads no accelerometer, so it must not drive those lines).
static void outputs_off() {
    pwm_write(0);
    out_low(R_EN);   out_low(L_EN);
    out_low(RPWM);   out_low(LPWM);
    out_low(MOTOR_RELAY);                       // UNCONFIGURED: nothing happens
    out_low(LED_MOTOR); out_low(LED_TEMP); out_low(LED_ACCEL); out_low(LED_INA); out_low(BUZZER);
}

// Returns true only if the PWM peripheral was set up for the RPWM pin. LPWM is never driven (unidirectional): it is held LOW as a plain output.
static bool pwm_begin() {
#if TORQVA_OTA_LED_BENCH
    return false;                                       // bench: the PWM peripheral is never attached to the driver pin
#elif ESP_ARDUINO_VERSION_MAJOR >= 3
    return ledcAttach(RPWM, PWM_FREQ_HZ, PWM_RES_BITS);
#else
    if (ledcSetup(0, PWM_FREQ_HZ, PWM_RES_BITS) == 0) return false;
    ledcAttachPin(RPWM, 0);
    return true;
#endif
}

static void pwm_write(float duty_pct) {
#if TORQVA_OTA_LED_BENCH
    (void)duty_pct; return;                             // bench: no PWM channel exists; RPWM stays a plain LOW output (outputs_off)
#endif
    if (!g_pwm_ok) return;                              // early boot and setup failure leave the GPIOs driven low
    if (duty_pct < 0) duty_pct = 0;
    if (duty_pct > 100) duty_pct = 100;
    const uint32_t max = (1u << PWM_RES_BITS) - 1;
    const uint32_t v = (uint32_t)(duty_pct * 0.01f * max + 0.5f);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcWrite(RPWM, v);
#else
    ledcWrite(0, v);
#endif
}

static void apply(const HalOut& o) {
    if (!g_pwm_ok || !o.driver_enable || !o.relay_on) {
        pwm_write(0);
        digitalWrite(R_EN, LOW);
        digitalWrite(L_EN, LOW);
        if (MOTOR_RELAY != UNCONFIGURED) digitalWrite(MOTOR_RELAY, LOW);
        return;
    }
    if (MOTOR_RELAY != UNCONFIGURED) digitalWrite(MOTOR_RELAY, HIGH);
    digitalWrite(R_EN, HIGH);
    digitalWrite(L_EN, HIGH);
    pwm_write(o.duty_pct);
}

// Status LEDs and buzzer: annunciators only, never safety functions. LED_ACCEL stays off: the accelerometer is not supported by this firmware.
static void indicators(const HalIn& in, const HalOut& o, bool latched) {
    digitalWrite(LED_MOTOR, o.driver_enable ? HIGH : LOW);
    digitalWrite(LED_TEMP, in.housing_valid ? HIGH : LOW);
    digitalWrite(LED_INA, (in.current_valid && in.voltage_valid) ? HIGH : LOW);
    digitalWrite(LED_ACCEL, in.acc_valid ? HIGH : LOW);
#if TORQVA_OTA_LED_BENCH
    // The bench LED on GPIO 5 (OLED_SCL in the production map; the OLED is compiled out here) shows which image runs: its half-period is this build's.
    digitalWrite(torqva_pins::OLED_SCL, ((millis() / (uint32_t)(TORQVA_BENCH_BLINK_MS)) & 1u) ? HIGH : LOW);
#endif
    static uint32_t last_toggle = 0; static bool beep = false;
    if (latched) {                                          // a latched safety fault beeps (300 ms) until the intentional reset
        if ((uint32_t)(millis() - last_toggle) >= 300) { last_toggle = millis(); beep = !beep; digitalWrite(BUZZER, beep ? HIGH : LOW); }
    } else if (beep) { beep = false; digitalWrite(BUZZER, LOW); }
}

// ---------- hall RPM (1 pulse / rev, period timing) ----------
static volatile uint32_t g_last_pulse_us = 0;
static volatile uint32_t g_period_us = 0;
static volatile bool g_have_period = false;

void IRAM_ATTR hall_isr() {
    const uint32_t now = micros();
    const uint32_t dt = now - g_last_pulse_us;
    if (g_last_pulse_us != 0 && dt < HALL_MIN_PERIOD_US) {
        return; // debounce: drop noise pulses without shifting baseline
    }
    if (g_last_pulse_us != 0) { g_period_us = dt; g_have_period = true; }
    g_last_pulse_us = now;
}

static void read_rpm(HalIn& in) {
    uint32_t last, period; bool have;
    noInterrupts(); last = g_last_pulse_us; period = g_period_us; have = g_have_period; interrupts();
    const uint32_t elapsed_us = (last != 0) ? (micros() - last) : 0;
    const uint32_t since_ms = elapsed_us / 1000;
    in.pulse_recent = (last != 0) && since_ms < 1000;
#if TORQVA_OTA_LED_BENCH
    in.pulse_recent = false; in.rpm = 0.0f; in.rpm_valid = false;     // bench: there is no Hall sensor, so there is no speed reading (never "0 rpm")
    (void)have; (void)period; return;
#endif
    // Sensor is "valid" whenever it is readable; a stopped shaft legitimately reads 0 rpm.
    in.rpm_valid = true;
    if (in.pulse_recent && have && period > 0) {
        // If elapsed time since last pulse exceeds the measured period, the motor is decelerating.
        // If no pulse has arrived for >= 300 ms, the motor is effectively stopped.
        if (since_ms >= 300) {
            in.rpm = 0.0f;
        } else if (elapsed_us > period && elapsed_us > 0) {
            in.rpm = 60.0e6f / (float)elapsed_us;
        } else {
            in.rpm = 60.0e6f / (float)period;
        }
        if (!isfinite(in.rpm) || in.rpm < 0.0f) {
            in.rpm = 0.0f;
            in.rpm_valid = false;
        }
    } else {
        in.rpm = 0.0f;
    }
}

// ---------- slow sensors ----------
static OneWire g_ow(torqva_pins::TEMP_DATA);
static DallasTemperature g_ds(&g_ow);
static Adafruit_INA219 g_ina;
static bool g_ina_ok = false;
static uint32_t g_last_temp_ms = 0;
static float g_housing = 0, g_ambient = 0;
static bool g_housing_ok = false, g_ambient_ok = false;
static uint32_t g_housing_ms = 0, g_ambient_ms = 0;     // time of the last successful reading of each sensor

static void read_temps(uint32_t now) {
    if (now - g_last_temp_ms < 1000) return;           // DS18B20 12-bit needs ~750 ms: request, read next second
    g_last_temp_ms = now;
    float h = g_ds.getTempCByIndex(0);
    float a = g_ds.getTempCByIndex(1);
    // 85.0 C is the DS18B20 power-on reset default.
    // Discard 85.0 C if previous reading was well below 70 C to avoid false TEMP_STOP trips on power jitter.
    if (h == 85.0f && g_housing < 70.0f) {
        g_ds.requestTemperatures();
        return;
    }
    g_housing_ok = (h != DEVICE_DISCONNECTED_C && h > -40.0f && h < 150.0f);
    g_ambient_ok = (a != DEVICE_DISCONNECTED_C && a > -40.0f && a < 100.0f);
    if (g_housing_ok) { g_housing = h; g_housing_ms = now; }
    if (g_ambient_ok) { g_ambient = a; g_ambient_ms = now; }
    g_ds.requestTemperatures();
}

// The Adafruit INA219 driver cannot report a failed read (it returns stale/zero values), so the bus is probed every 100 ms: a missing device invalidates current and voltage.
static bool ina_alive(uint32_t now) {
    static uint32_t last = 0;
    static uint32_t last_ok = 0;
    static bool alive = false;
    if ((uint32_t)(now - last) >= 100 || last == 0) {
        last = now;
        Wire1.beginTransmission(TORQVA_INA219_ADDR);
        if (Wire1.endTransmission() == 0) {
            last_ok = now;
            alive = true;
        } else if (last_ok != 0 && (uint32_t)(now - last_ok) >= 2000) {
            alive = false;
        }
    }
    return alive;
}

// ---------- ADXL345 (I2C bus 0 on GPIO 16/17). Raw acceleration only: the magnitude includes gravity and is NOT vibration RMS. ----------
static bool g_adxl_ok = false;                    // the sensor answered with the right device id at start-up
static AccelSample g_acc = {0, 0, 0, 0, false};
static uint32_t g_acc_ms = 0, g_acc_last_try = 0;

static bool adxl_read(uint8_t reg, uint8_t* buf, uint8_t n) {
    Wire.beginTransmission(ADXL345_I2C_ADDR);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom((int)ADXL345_I2C_ADDR, (int)n) != n) return false;
    for (uint8_t i = 0; i < n; i++) buf[i] = (uint8_t)Wire.read();
    return true;
}

static bool adxl_write(uint8_t reg, uint8_t v) {
    Wire.beginTransmission(ADXL345_I2C_ADDR);
    Wire.write(reg); Wire.write(v);
    return Wire.endTransmission() == 0;
}

static bool adxl_begin() {
    uint8_t id = 0;
    if (!adxl_read(ADXL345_REG_DEVID, &id, 1) || !adxl345_devid_ok(id)) return false;
    return adxl_write(ADXL345_REG_POWER_CTL, ADXL345_POWER_MEASURE) && adxl_write(ADXL345_REG_DATA_FORMAT, ADXL345_FORMAT_FULL_RES_16G);
}

static void read_accel(HalIn& in) {
    const uint32_t now = in.now_ms;
    if (g_adxl_ok && (uint32_t)(now - g_acc_last_try) >= 100) {        // 10 Hz; a failed read invalidates the sample, it never leaves a stale value valid
        g_acc_last_try = now;
        uint8_t id = 0, raw[6];
        if (adxl_read(ADXL345_REG_DEVID, &id, 1) && adxl345_devid_ok(id) && adxl_read(ADXL345_REG_DATAX0, raw, 6)) {
            g_acc = adxl345_decode(raw);
            if (g_acc.valid) g_acc_ms = now;
        } else {
            g_acc.valid = false;
        }
    }
    const bool fresh = g_acc.valid && (uint32_t)(now - g_acc_ms) < TORQVA_ACCEL_STALE_MS;
    in.acc_valid = fresh;
    in.acc_x_g = fresh ? g_acc.x_g : 0.0f; in.acc_y_g = fresh ? g_acc.y_g : 0.0f; in.acc_z_g = fresh ? g_acc.z_g : 0.0f; in.acc_mag_g = fresh ? g_acc.mag_g : 0.0f;   // zeros only when acc_valid is false: never shown
}

#if TORQVA_OLED
// ---------- OLED (software I2C, GPIO 4/5). Runs in the communications task, never in the control task: a software-I2C frame takes tens of ms. ----------
static U8G2_SH1106_128X64_NONAME_F_SW_I2C g_oled(U8G2_R0, torqva_pins::OLED_SCL, torqva_pins::OLED_SDA, U8X8_PIN_NONE);
static void oled_draw(const Device::DisplayInfo& d) {
    char l[40];
    g_oled.clearBuffer();
    g_oled.setFont(u8g2_font_5x8_tf);
    snprintf(l, sizeof(l), "TORQVA %s", d.state == SafetyState::EMERGENCY_STOP ? "FAULT LATCHED" : (d.state == SafetyState::WARN ? "WARNING" : "OK")); g_oled.drawStr(0, 8, l);
    snprintf(l, sizeof(l), "Reason: %s", trip_reason_name(d.reason)); g_oled.drawStr(0, 17, l);
    snprintf(l, sizeof(l), "Drive: %s  Motion: %s", d.drive, d.start_block[0] ? "LOCKED" : "no lock"); g_oled.drawStr(0, 26, l);
    if (d.rpm_valid) snprintf(l, sizeof(l), "RPM: %.0f", d.rpm); else snprintf(l, sizeof(l), "RPM: n/a");
    g_oled.drawStr(0, 35, l);
    if (d.housing_valid) snprintf(l, sizeof(l), "Housing: %.1f C", d.housing_c); else snprintf(l, sizeof(l), "Housing: n/a");
    g_oled.drawStr(0, 44, l);
    if (d.current_valid && d.voltage_valid) snprintf(l, sizeof(l), "%.2f A  %.1f V", d.current_a, d.voltage_v); else snprintf(l, sizeof(l), "I/V: n/a");
    g_oled.drawStr(0, 53, l);
    if (d.acc_valid) snprintf(l, sizeof(l), "|a| %.2f g (total)", d.acc_mag_g); else snprintf(l, sizeof(l), "Accel: n/a");
    g_oled.drawStr(0, 62, l);
    g_oled.sendBuffer();
}
#endif


static void read_inputs(HalIn& in) {
    in.now_ms = millis();
    if (g_ina_ok && ina_alive(in.now_ms)) {
        const float scale = 0.1f / TORQVA_SHUNT_OHM;   // library assumes a 0.1 ohm shunt
        in.current_a = g_ina.getCurrent_mA() * 0.001f * scale;
        in.voltage_v = g_ina.getBusVoltage_V();
        in.current_valid = isfinite(in.current_a) && in.current_a > -10.0f && in.current_a < 20.0f;
        // A responding INA219 that reads 0 V is a VALID measurement of an absent motor supply (the safety logic and the SUPPLY_NOT_PRESENT start interlock handle that);
        // only a non-finite or out-of-range value is a sensor fault.
        in.voltage_valid = isfinite(in.voltage_v) && in.voltage_v >= 0.0f && in.voltage_v < 27.0f;
    } else {
        in.current_a = 0; in.voltage_v = 0; in.current_valid = false; in.voltage_valid = false;
    }
#if !TORQVA_OTA_LED_BENCH
    read_temps(in.now_ms);                             // bench: no DS18B20 bus is started, so nothing is read and the temperatures stay invalid
#endif
    // Valid only if the LAST read succeeded AND it is recent (wrap-safe): a stuck bus or an unread sensor cannot stay "valid" forever.
    in.housing_c = g_housing;  in.housing_valid = g_housing_ok && (uint32_t)(in.now_ms - g_housing_ms) < TORQVA_TEMP_STALE_MS;
    in.ambient_c = g_ambient;  in.ambient_valid = g_ambient_ok && (uint32_t)(in.now_ms - g_ambient_ms) < TORQVA_TEMP_STALE_MS;
    read_rpm(in);
    in.vib_rms_g = 0; in.vib_valid = false;            // vibration RMS is NOT implemented: the raw acceleration below is a different quantity
#if TORQVA_OTA_LED_BENCH
    in.acc_valid = false;                              // bench: no ADXL345
#else
    read_accel(in);
#endif
    // Local reset: BOOT button (GPIO 0) on ESP32-S3 DevKit or the configured local reset button.
    in.button_pressed = (torqva_pins::LOCAL_RESET_BUTTON != torqva_pins::UNCONFIGURED && digitalRead(torqva_pins::LOCAL_RESET_BUTTON) == LOW)
        || (digitalRead(0) == LOW);
    {   // Direct motor mode: E-stop monitoring disabled so an open/unwired GPIO never latches or blocks commands.
        in.estop_state = 0;
        in.external_estop = false;
    }
}

// ---------- device + tasks ----------
static Device* g_dev = nullptr;
static bool g_wdt_init_ok = false;     // esp_task_wdt_init() returned ESP_OK with OUR timeout (anything else leaves the interlocks refusing motor commands)
static SemaphoreHandle_t g_mu;

static void control_task(void*) {
    // Register THIS task with the task watchdog. If registration fails the device is told so and its start interlocks keep refusing motor commands.
    const bool wdt_ok = g_wdt_init_ok && (esp_task_wdt_add(nullptr) == ESP_OK);
    if (xSemaphoreTake(g_mu, portMAX_DELAY) == pdTRUE) { g_dev->set_watchdog_active(wdt_ok); xSemaphoreGive(g_mu); }
    TickType_t wake = xTaskGetTickCount();
    for (;;) {
        HalIn in;
        read_inputs(in);
        HalOut out;
        // Bounded wait: if the communications task holds the lock too long the outputs go OFF (fail-safe) and the watchdog is NOT fed, so a stuck lock ends in a reset.
        if (xSemaphoreTake(g_mu, pdMS_TO_TICKS(5)) != pdTRUE) {
            outputs_off();
            vTaskDelayUntil(&wake, pdMS_TO_TICKS(10));
            continue;
        }
        out = g_dev->step(in);
        const bool latched = g_dev->safety().state() == SafetyState::EMERGENCY_STOP;
        xSemaphoreGive(g_mu);
        apply(out);
        indicators(in, out, latched);
        if (wdt_ok) esp_task_wdt_reset();              // fed ONLY after a complete read -> decide -> apply iteration
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(10));     // 100 Hz
    }
}

#if TORQVA_OLED
static void oled_task(void*);
#endif

void setup() {
    outputs_off();                                     // FIRST: motor off before anything can fail
    { const char* volatile keep = TORQVA_FW_ID; (void)keep; }  // takes its address so the linker keeps the identity string in the image
    pinMode(0, INPUT_PULLUP);
    if (torqva_pins::LOCAL_RESET_BUTTON != torqva_pins::UNCONFIGURED) pinMode(torqva_pins::LOCAL_RESET_BUTTON, INPUT_PULLUP);
    // A stalled or absent USB host must never block anything: usb_out drops lines instead of waiting. (1.1.1 used Serial.setTxTimeoutMs(0) here, which
    // in arduino-esp32 2.0.17 makes HWCDC::write wait FOREVER while the cable is plugged in and no host reads - see usb_out.cpp.)
    Serial.setRxBufferSize(2048);
    usb_out_begin(115200);
    g_pwm_ok = pwm_begin();
    pwm_write(0);
#if TORQVA_OTA_LED_BENCH
    // Bench: no sensor bus, no Hall interrupt, no driver. Only the LED pin is configured (starts LOW). g_ina_ok / g_adxl_ok stay false.
    pinMode(torqva_pins::OLED_SCL, OUTPUT); digitalWrite(torqva_pins::OLED_SCL, LOW);
    pinMode(torqva_pins::ESTOP_INPUT, INPUT_PULLUP);          // read and reported only (not wired, never latches: TORQVA_ESTOP_INPUT_WIRED=0)
#else
    Wire1.begin(torqva_pins::INA_SDA, torqva_pins::INA_SCL);          // INA219 bus
    Wire.begin(torqva_pins::ADXL_SDA, torqva_pins::ADXL_SCL);         // ADXL345 bus (separate from the INA219 bus)
    Wire.setTimeOut(20);
    g_adxl_ok = adxl_begin();                                          // false if the sensor is absent or answers with a wrong id: accel frames then report ok=0
    g_ina_ok = g_ina.begin(&Wire1);
    if (!g_ina_ok) { delay(20); Wire1.begin(torqva_pins::INA_SDA, torqva_pins::INA_SCL); g_ina_ok = g_ina.begin(&Wire1); }
    if (g_ina_ok) g_ina.setCalibration_32V_2A();
    g_ds.begin();
    if (g_ds.getDeviceCount() == 0) { delay(20); g_ds.begin(); }
    g_ds.setWaitForConversion(false);
    g_ds.requestTemperatures();
    pinMode(torqva_pins::HALL_INPUT, INPUT_PULLUP);
    pinMode(torqva_pins::ESTOP_INPUT, INPUT_PULLUP);          // NC contact to GND: closed = LOW (healthy); an open circuit floats HIGH = emergency-stop condition
    attachInterrupt(digitalPinToInterrupt(torqva_pins::HALL_INPUT), hall_isr, FALLING);
#endif

    DeviceConfig cfg = {};
    cfg.fw_version = TORQVA_FW_VERSION;
    cfg.wiring_id = TORQVA_WIRING_ID;
    cfg.mode = "HW";
    {
        Preferences auth;
        if (auth.begin("torqva", true)) {
            cfg.auth_enabled = auth.getBytesLength("authkey") == sizeof(cfg.auth_key)
                && auth.getBytes("authkey", cfg.auth_key, sizeof(cfg.auth_key)) == sizeof(cfg.auth_key);
            auth.end();
        }
    }
#if defined(TORQVA_CONTROL_ENABLED) && TORQVA_CONTROL_ENABLED
    cfg.control_enabled = true;
#else
    cfg.control_enabled = false;
#endif
    cfg.kp = 0.0f; cfg.ki = 0.0f;                    // Existing feedforward speed behavior; Hall sensor remains the measured speed source.
    cfg.device_id = TORQVA_DEVICE_ID;
    cfg.rand32 = []() -> uint32_t { return esp_random(); };
    // Runtime limits: a copy of the last configuration accepted over the authenticated session is kept in NVS (namespace "torqva", key "cfg"). After a reboot it is restored ONLY so the
    // safety trips use the approved numbers; it does not approve motion. The backend re-sends the configuration over the new authenticated session, and only that re-approves.
    cfg.persist_cfg = [](const RuntimeLimits& r) {
        Preferences p;
        if (p.begin("torqva", false)) { p.putBytes("cfg", &r, sizeof(r)); p.end(); }
    };
#if TORQVA_OTA_LED_BENCH
    cfg.accel_supported = false;                       // bench: no ADXL345, so no accel frames (nothing invented)
    cfg.ota_led_bench = true;                          // device-core bench eligibility + "prof":"ota_led_bench" in ota_info
#else
    cfg.accel_supported = true;                        // this build reads the ADXL345 (frames report ok=0 when it is absent or invalid)
#endif
    cfg.limits_approved = true;
    cfg.estop_input_wired = true;
    cfg.transport_secured = true;
    cfg.relaxed_interlocks = !TORQVA_OTA_LED_BENCH;
    cfg.direct_mode = !TORQVA_OTA_LED_BENCH;
    cfg.on_sys_cmd = [](const char* cmd, void*) {
        if (!cmd) return;
        if (strcmp(cmd, "restart") == 0) {
            outputs_off();
            wifi_log("WARN", "Remote restart command accepted");
            delay(300);
            ESP.restart();
        } else if (strcmp(cmd, "ota_rollback") == 0) {
            outputs_off();
            if (ota_rollback_partition()) {
                wifi_log("WARN", "OTA rollback slot selected; restarting");
                delay(300);
                ESP.restart();
            } else {
                wifi_log("ERROR", "No valid inactive OTA slot for rollback");
            }
        }
    };
    cfg.on_wifi_cfg = [](const char* ssid, const char* pass, const char* base, void*) {
        if (ota_update_wifi_config(String(ssid ? ssid : ""), String(pass ? pass : ""), String(base ? base : ""))) {
            wifi_log("INFO", "Wi-Fi configuration updated in NVS; reconnecting");
            wifi_link_reconnect();
        } else {
            wifi_log("ERROR", "Failed to save Wi-Fi configuration");
        }
    };
#if defined(TORQVA_WIFI_LINK) && TORQVA_WIFI_LINK
    // Staged network changes (wifi_trial.h): the working network in NVS is not overwritten until the host commits over the NEW network. They change no motor behaviour.
    cfg.wifi_stage_supported = true;
    cfg.on_wifi_stage = [](const char* ssid, const char* pass, const char* base, uint32_t trial_s, void*) -> bool {
        if (!ota_wifi_stage(String(ssid ? ssid : ""), String(pass ? pass : ""), String(base ? base : ""), trial_s)) return false;
        wifi_log("WARN", "Wi-Fi trial started; the previous network returns unless the host commits");
        wifi_link_reconnect();
        return true;
    };
    cfg.on_wifi_commit = [](void*) -> bool {
        if (!ota_wifi_commit()) return false;
        wifi_log("INFO", "Wi-Fi configuration committed");
        return true;
    };
    cfg.on_wifi_scan = [](void*) -> bool { return wifi_scan_start(); };
#endif
    ota_platform_capability(cfg);                      // OTA partitions, compiled-in signing key and NVS provisioning decide whether this boot can update at all
    Limits lim = default_limits();
    if (cfg.direct_mode) {
        lim.max_rpm = 30000.0f;
        lim.max_duty_pct = 100.0f;
        lim.ramp_pct_per_s = 1000.0f;
        lim.volt_min_v = 0.0f;
        lim.volt_max_v = 60.0f;
        lim.current_stop_a = 100.0f;
        lim.current_inst_a = 100.0f;
        lim.temp_stop_c = 150.0f;
        lim.heartbeat_timeout_ms = 0;
        lim.rpm_loss_ms = 0;
    }
    g_dev = new Device(lim, cfg);
    g_mu = xSemaphoreCreateMutex();
    {
        Preferences p;
        RuntimeLimits r;
        if (p.begin("torqva", true)) {
            if (p.getBytes("cfg", &r, sizeof(r)) == sizeof(r)) g_dev->restore_runtime_limits(r);
            p.end();
        }
    }
    // Task watchdog (Arduino-ESP32 2.x / IDF 4.4 API). Panic = reset on expiry. The control task registers itself in control_task().
    g_wdt_init_ok = (esp_task_wdt_init(TORQVA_WDT_TIMEOUT_S, true) == ESP_OK);
    if (!g_wdt_init_ok) usb_out_line("{\"t\":\"warn\",\"msg\":\"task watchdog init failed: motor commands stay refused\"}");

    xTaskCreatePinnedToCore(control_task, "control", 6144, nullptr, configMAX_PRIORITIES - 2, nullptr, 1);
    // Over-the-air update: its own task (Wi-Fi + TLS on the other core, lower priority). It never touches a motor output; the Device refuses motion while it runs
    // and while a new image is unconfirmed, and the first-boot self-test decides whether the new image is kept.
#if TORQVA_OLED
    xTaskCreatePinnedToCore(oled_task, "oled", 4096, nullptr, 1, nullptr, 0);
#endif
    wifi_link_start(g_dev, g_mu);                      // no-op unless TORQVA_WIFI_LINK and the network is provisioned; the device connects out only
    ota_platform_start(g_dev, g_mu, g_ina_ok, TORQVA_OTA_LED_BENCH ? false : g_ds.getDeviceCount() > 0, cfg.auth_enabled && strcmp(TORQVA_DEVICE_ID, "UNPROVISIONED") != 0, outputs_off);
}

#if TORQVA_OLED
// The OLED is driven by bit-banged (software) I2C: one full redraw blocks its caller for ~600 ms. It used to run inside loop(), which stopped draining the
// telemetry queue for that long and dropped about half of the device's frames. It now has its own low-priority task; loop() never waits for the display.
static void oled_task(void*) {
    g_oled.begin();
    for (;;) {
        Device::DisplayInfo di;
        bool ok = false;
        if (xSemaphoreTake(g_mu, pdMS_TO_TICKS(5)) == pdTRUE) { g_dev->display_info(&di, millis()); xSemaphoreGive(g_mu); ok = true; }
        if (ok) oled_draw(di);
        vTaskDelay(pdMS_TO_TICKS(500));
    }
}
#endif

void loop() {
    // Communications on the Arduino loop task (core 1 by default; control task has higher priority).
    static char line[512];
    static size_t n = 0;
    static bool discarding = false;                    // set after an oversized line: skip everything up to the next newline
    while (Serial.available()) {
        const char c = (char)Serial.read();
        if (c == '\n') {
            line[n] = 0;
            if (n > 0 && !discarding) {
                xSemaphoreTake(g_mu, portMAX_DELAY);
                g_dev->on_line(line, millis());
                xSemaphoreGive(g_mu);
            }
            n = 0; discarding = false;
        } else if (c != '\r') {
            if (n < sizeof(line) - 1) line[n++] = c; else { n = 0; discarding = true; }   // overlong line: drop it AND its remainder
        }
    }
    wifi_scan_poll();                                  // emits a finished scan's results (no-op without Wi-Fi or without a scan); never waits
    ota_wifi_trial_tick(millis());                     // a staged network that was never committed is dropped here, and the previous one is used again
    {
        static uint32_t last_wifi_state = 0;
        if ((uint32_t)(millis() - last_wifi_state) >= 500) {
            last_wifi_state = millis();
            bool trial = false; uint32_t left = 0; String act;
            ota_wifi_state(&trial, &left, &act, millis());
            if (xSemaphoreTake(g_mu, pdMS_TO_TICKS(5)) == pdTRUE) { g_dev->set_wifi_state(trial, left, act.c_str()); xSemaphoreGive(g_mu); }
        }
    }
    char out[320];
    for (int i = 0; i < 8; i++) {
        bool got;
        xSemaphoreTake(g_mu, portMAX_DELAY);
        got = g_dev->pop_line(out, sizeof(out));
        xSemaphoreGive(g_mu);
        if (!got) break;
        wifi_link_send(out);                           // the Wi-Fi link first (no-op in builds without it; never waits: a full queue drops and counts)
        usb_out_line(out);                             // USB serial (diagnostics, recovery, and the link when no Wi-Fi link exists): never waits on the host
    }
    delay(2);
}
