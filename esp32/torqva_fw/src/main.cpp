// TORQVA device firmware (ESP32-S3). Thin hardware layer around torqva_core::Device.
//
// SAFETY POSTURE OF THIS BUILD:
//  * All motor outputs are driven to the OFF state before anything else runs.
//  * Motor commands are REJECTED unless built with -DTORQVA_CONTROL_ENABLED=1 (not set anywhere in
//    platformio.ini). Telemetry works either way.
//  * This file has only been compiled, never flashed or run (see docs/TORQVA_PROGRESS.md).
#include <Arduino.h>
#include <Wire.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Adafruit_INA219.h>
#include <esp_task_wdt.h>
#include <esp_system.h>
#include "adxl345.h"
#ifndef TORQVA_OLED
#define TORQVA_OLED 1          // local SH1106 status display on the software-I2C pins 4/5 (annunciation only; never a decision input)
#endif
#if TORQVA_OLED
#include <U8g2lib.h>
#endif
#include "config_pins.h"
#include "device.h"

using namespace torqva;

// A build that can drive the motor must not carry the placeholder key below: control needs an explicit -DTORQVA_KEY="...". (Compile-time guard only; no behaviour change otherwise.)
#if defined(TORQVA_CONTROL_ENABLED) && !defined(TORQVA_KEY)
#error "TORQVA_CONTROL_ENABLED requires an explicit -DTORQVA_KEY=\"...\": the built-in placeholder key must never be used with motor control enabled"
#endif
// ---- Commissioning decisions (human-owned). Both default to 0 = motor-energising commands are REFUSED by the start interlocks (interlock.h).
//  TORQVA_LIMITS_APPROVED     1 only after a responsible person approved the safety-trip limits for this motor, driver, PSU and cooling (see docs/TORQVA_HARDWARE_READINESS.md).
//  TORQVA_ESTOP_INPUT_WIRED   1 only after an independent emergency-stop input exists with a documented wiring contract AND config_pins.h defines its pin;
//                             this build reads no E-stop pin (in.external_estop is always false), so the flag must stay 0 until that code exists.
// Device identity reported to the backend bridge. A label (NOT authentication, NOT a secret); set per unit with -DTORQVA_DEVICE_ID=\"...\". The default is deliberately
// recognisable as unprovisioned, and the bridge reports an unprovisioned or mismatching identity as unverified.
#ifndef TORQVA_DEVICE_ID
#define TORQVA_DEVICE_ID "UNPROVISIONED"
#endif
#ifndef TORQVA_LIMITS_APPROVED
#define TORQVA_LIMITS_APPROVED 0
#endif
//  TORQVA_TRANSPORT_SECURED   1 only when the command link runs over an authenticated, confidential, replay-protected channel. The built-in protocol does NOT
//                             provide that (plaintext shared key; a captured command can be replayed after a reboot), so this stays 0 and motor commands are refused.
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

#ifndef TORQVA_KEY
#define TORQVA_KEY "dev-key-change-me"     // TODO(Phase 4): load from NVS, never commit a real key
#endif

// ---------- hardware outputs ----------
using namespace torqva_pins;

// Drive a pin LOW only if it is configured (an UNCONFIGURED pin is never touched).
static void out_low(int pin) {
    if (pin == UNCONFIGURED) return;
    pinMode(pin, OUTPUT);
    digitalWrite(pin, LOW);
}

// Everything that can energise or annunciate goes to the OFF level. Driver enables and PWM first. The OLED and ADXL345 pins are RESERVED and deliberately left untouched
// (this firmware drives no display and reads no accelerometer, so it must not drive those lines).
static void outputs_off() {
    out_low(R_EN);   out_low(L_EN);
    out_low(RPWM);   out_low(LPWM);
    out_low(MOTOR_RELAY);                       // UNCONFIGURED: nothing happens
    out_low(LED_MOTOR); out_low(LED_TEMP); out_low(LED_ACCEL); out_low(LED_INA); out_low(BUZZER);
}

// Returns true only if the PWM peripheral was set up for the RPWM pin. LPWM is never driven (unidirectional): it is held LOW as a plain output.
static bool pwm_begin() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    return ledcAttach(RPWM, PWM_FREQ_HZ, PWM_RES_BITS);
#else
    if (ledcSetup(0, PWM_FREQ_HZ, PWM_RES_BITS) == 0) return false;
    ledcAttachPin(RPWM, 0);
    return true;
#endif
}

static void pwm_write(float duty_pct) {
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

static bool g_pwm_ok = false;           // the driver is eligible to operate only if the PWM peripheral was set up (see setup())

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
    if (g_last_pulse_us != 0 && dt < HALL_MIN_PERIOD_US) return;
    if (g_last_pulse_us != 0) { g_period_us = dt; g_have_period = true; }
    g_last_pulse_us = now;
}

static void read_rpm(HalIn& in) {
    uint32_t last, period; bool have;
    noInterrupts(); last = g_last_pulse_us; period = g_period_us; have = g_have_period; interrupts();
    const uint32_t since_ms = (micros() - last) / 1000;
    in.pulse_recent = (last != 0) && since_ms < 1000;
    // Sensor is "valid" whenever it is readable; a stopped shaft legitimately reads 0 rpm.
    in.rpm_valid = true;
    in.rpm = (in.pulse_recent && have && period > 0) ? 60.0e6f / (float)period : 0.0f;
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
    g_housing_ok = (h != DEVICE_DISCONNECTED_C && h > -40.0f && h < 150.0f);
    g_ambient_ok = (a != DEVICE_DISCONNECTED_C && a > -40.0f && a < 100.0f);
    if (g_housing_ok) { g_housing = h; g_housing_ms = now; }
    if (g_ambient_ok) { g_ambient = a; g_ambient_ms = now; }
    g_ds.requestTemperatures();
}

// The Adafruit INA219 driver cannot report a failed read (it returns stale/zero values), so the bus is probed every 100 ms: a missing device invalidates current and voltage.
static bool ina_alive(uint32_t now) {
    static uint32_t last = 0; static bool alive = false;
    if ((uint32_t)(now - last) >= 100 || last == 0) {
        last = now;
        Wire1.beginTransmission(TORQVA_INA219_ADDR);
        alive = (Wire1.endTransmission() == 0);
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
        // Plausibility: INA219 bus range is 0..26 V; an exact 0 V reading with a powered system is a bus fault.
        in.current_valid = isfinite(in.current_a) && in.current_a > -10.0f && in.current_a < 20.0f;
        in.voltage_valid = isfinite(in.voltage_v) && in.voltage_v > 1.0f && in.voltage_v < 27.0f;
    } else {
        in.current_a = 0; in.voltage_v = 0; in.current_valid = false; in.voltage_valid = false;
    }
    read_temps(in.now_ms);
    // Valid only if the LAST read succeeded AND it is recent (wrap-safe): a stuck bus or an unread sensor cannot stay "valid" forever.
    in.housing_c = g_housing;  in.housing_valid = g_housing_ok && (uint32_t)(in.now_ms - g_housing_ms) < TORQVA_TEMP_STALE_MS;
    in.ambient_c = g_ambient;  in.ambient_valid = g_ambient_ok && (uint32_t)(in.now_ms - g_ambient_ms) < TORQVA_TEMP_STALE_MS;
    read_rpm(in);
    in.vib_rms_g = 0; in.vib_valid = false;            // vibration RMS is NOT implemented: the raw acceleration below is a different quantity
    read_accel(in);
    // No reset button is documented (UNCONFIGURED): it reads as never pressed, so a latched trip cannot be reset by software; only a power cycle clears it.
    in.button_pressed = (torqva_pins::LOCAL_RESET_BUTTON != torqva_pins::UNCONFIGURED) && digitalRead(torqva_pins::LOCAL_RESET_BUTTON) == LOW;
    in.external_estop = false;                         // no E-stop feedback wired in this pin map
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

void setup() {
    outputs_off();                                     // FIRST: motor off before anything can fail
    if (torqva_pins::LOCAL_RESET_BUTTON != torqva_pins::UNCONFIGURED) pinMode(torqva_pins::LOCAL_RESET_BUTTON, INPUT_PULLUP);
    Serial.begin(115200);
#if defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT
    Serial.setTxTimeoutMs(0);                          // a stalled or absent USB host must never block the loop that parses STOP: telemetry is dropped instead
#endif
    g_pwm_ok = pwm_begin();
    pwm_write(0);

    Wire1.begin(torqva_pins::INA_SDA, torqva_pins::INA_SCL);          // INA219 bus
    Wire.begin(torqva_pins::ADXL_SDA, torqva_pins::ADXL_SCL);         // ADXL345 bus (separate from the INA219 bus)
    Wire.setTimeOut(20);
    g_adxl_ok = adxl_begin();                                          // false if the sensor is absent or answers with a wrong id: accel frames then report ok=0
    g_ina_ok = g_ina.begin(&Wire1);
    if (g_ina_ok) g_ina.setCalibration_32V_2A();
    g_ds.begin();
    g_ds.setWaitForConversion(false);
    g_ds.requestTemperatures();
    pinMode(torqva_pins::HALL_INPUT, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(torqva_pins::HALL_INPUT), hall_isr, FALLING);

    DeviceConfig cfg = {};
    cfg.fw_version = TORQVA_FW_VERSION;
    cfg.wiring_id = TORQVA_WIRING_ID;
    cfg.mode = "HW";
    strncpy(cfg.key, TORQVA_KEY, sizeof(cfg.key) - 1);
#ifdef TORQVA_CONTROL_ENABLED
    cfg.control_enabled = true;
#else
    cfg.control_enabled = false;
#endif
    cfg.kp = 0.01f; cfg.ki = 0.03f;                    // placeholders: tune during commissioning
    cfg.device_id = TORQVA_DEVICE_ID;
    cfg.accel_supported = true;                        // this build reads the ADXL345 (frames report ok=0 when it is absent or invalid)
    cfg.limits_approved = (TORQVA_LIMITS_APPROVED != 0);
    cfg.estop_input_wired = (TORQVA_ESTOP_INPUT_WIRED != 0);
    cfg.transport_secured = (TORQVA_TRANSPORT_SECURED != 0);
    cfg.relaxed_interlocks = false;                    // strict: hardware builds never relax the start interlocks
    // max_rpm and vib_rms_stop_g stay 0 (= not commissioned) until a human sets them.
    g_dev = new Device(default_limits(), cfg);
    g_mu = xSemaphoreCreateMutex();
    // A PWM setup failure leaves the driver disabled (apply() never enables it) and latches a visible fault until a power cycle / intentional reset.
    if (!g_pwm_ok) g_dev->latch_boot_fault(TripReason::OUTPUT_INIT_FAULT);
    // A restart caused by a watchdog, brown-out or panic is a FAULT: latch it so the motor cannot be started again until a person performs the intentional reset
    // (authorised RESET_ESTOP + local button). Ordinary power-on, software, USB and external resets do not latch. The session is never set here: no secured
    // transport is implemented, so Device::set_secure_session() is never called with true and motor commands stay refused (NO_SECURE_SESSION).
    switch (esp_reset_reason()) {
        case ESP_RST_TASK_WDT: case ESP_RST_INT_WDT: case ESP_RST_WDT: case ESP_RST_BROWNOUT: case ESP_RST_PANIC:
            g_dev->latch_boot_fault(TripReason::RESET_FAULT);
            break;
        default: break;
    }
    // Task watchdog (Arduino-ESP32 2.x / IDF 4.4 API). Panic = reset on expiry. The control task registers itself in control_task().
    g_wdt_init_ok = (esp_task_wdt_init(TORQVA_WDT_TIMEOUT_S, true) == ESP_OK);
    if (!g_wdt_init_ok) Serial.println("{\"t\":\"warn\",\"msg\":\"task watchdog init failed: motor commands stay refused\"}");

    xTaskCreatePinnedToCore(control_task, "control", 6144, nullptr, configMAX_PRIORITIES - 2, nullptr, 1);
}

void loop() {
    // Communications on the Arduino loop task (core 1 by default; control task has higher priority).
    static char line[256];
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
#if TORQVA_OLED
    static uint32_t last_oled = 0; static bool oled_started = false;
    if (!oled_started) { g_oled.begin(); oled_started = true; }
    if ((uint32_t)(millis() - last_oled) >= 500) {
        last_oled = millis();
        Device::DisplayInfo di;
        bool ok = false;
        if (xSemaphoreTake(g_mu, pdMS_TO_TICKS(5)) == pdTRUE) { g_dev->display_info(&di, millis()); xSemaphoreGive(g_mu); ok = true; }
        if (ok) oled_draw(di);
    }
#endif
    char out[320];
    for (int i = 0; i < 8; i++) {
        bool got;
        xSemaphoreTake(g_mu, portMAX_DELAY);
        got = g_dev->pop_line(out, sizeof(out));
        xSemaphoreGive(g_mu);
        if (!got) break;
        Serial.println(out);
    }
    delay(2);
}
