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
// A sensor reading older than this is not valid. ASSUMPTION: DS18B20 is read every 1 s, the INA219 every cycle; 3 s tolerates two lost conversions.
#define TORQVA_TEMP_STALE_MS 3000u
#define TORQVA_INA219_ADDR 0x40            // Adafruit default address; change if the A0/A1 straps differ

#ifndef TORQVA_KEY
#define TORQVA_KEY "dev-key-change-me"     // TODO(Phase 4): load from NVS, never commit a real key
#endif

// ---------- hardware outputs ----------
static void outputs_off() {
    pinMode(PIN_RELAY, OUTPUT);   digitalWrite(PIN_RELAY, LOW);
    pinMode(PIN_EN, OUTPUT);      digitalWrite(PIN_EN, LOW);
    pinMode(PIN_EN2, OUTPUT);     digitalWrite(PIN_EN2, LOW);
    pinMode(PIN_LPWM, OUTPUT);    digitalWrite(PIN_LPWM, LOW);
    pinMode(PIN_RPWM, OUTPUT);    digitalWrite(PIN_RPWM, LOW);
}

static void pwm_begin() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcAttach(PIN_RPWM, PWM_FREQ_HZ, PWM_RES_BITS);
#else
    ledcSetup(0, PWM_FREQ_HZ, PWM_RES_BITS);
    ledcAttachPin(PIN_RPWM, 0);
#endif
}

static void pwm_write(float duty_pct) {
    if (duty_pct < 0) duty_pct = 0;
    if (duty_pct > 100) duty_pct = 100;
    const uint32_t max = (1u << PWM_RES_BITS) - 1;
    const uint32_t v = (uint32_t)(duty_pct * 0.01f * max + 0.5f);
#if ESP_ARDUINO_VERSION_MAJOR >= 3
    ledcWrite(PIN_RPWM, v);
#else
    ledcWrite(0, v);
#endif
}

static void apply(const HalOut& o) {
    if (!o.driver_enable || !o.relay_on) {
        pwm_write(0);
        digitalWrite(PIN_EN, LOW);
        digitalWrite(PIN_EN2, LOW);
        digitalWrite(PIN_RELAY, LOW);
        return;
    }
    digitalWrite(PIN_RELAY, HIGH);
    digitalWrite(PIN_EN, HIGH);
    digitalWrite(PIN_EN2, HIGH);
    pwm_write(o.duty_pct);
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
static OneWire g_ow(PIN_ONEWIRE);
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
    in.vib_rms_g = 0; in.vib_valid = false;            // ADXL345 SPI/FIFO task not implemented yet
    in.button_pressed = digitalRead(PIN_BUTTON) == LOW;
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
        xSemaphoreGive(g_mu);
        apply(out);
        if (wdt_ok) esp_task_wdt_reset();              // fed ONLY after a complete read -> decide -> apply iteration
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(10));     // 100 Hz
    }
}

void setup() {
    outputs_off();                                     // FIRST: motor off before anything can fail
    pinMode(PIN_BUTTON, INPUT_PULLUP);
    Serial.begin(115200);
#if defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT
    Serial.setTxTimeoutMs(0);                          // a stalled or absent USB host must never block the loop that parses STOP: telemetry is dropped instead
#endif
    pwm_begin();
    pwm_write(0);

    Wire1.begin(PIN_I2C1_SDA, PIN_I2C1_SCL);
    g_ina_ok = g_ina.begin(&Wire1);
    if (g_ina_ok) g_ina.setCalibration_32V_2A();
    g_ds.begin();
    g_ds.setWaitForConversion(false);
    g_ds.requestTemperatures();
    pinMode(PIN_HALL, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(PIN_HALL), hall_isr, FALLING);

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
    cfg.limits_approved = (TORQVA_LIMITS_APPROVED != 0);
    cfg.estop_input_wired = (TORQVA_ESTOP_INPUT_WIRED != 0);
    cfg.transport_secured = (TORQVA_TRANSPORT_SECURED != 0);
    cfg.relaxed_interlocks = false;                    // strict: hardware builds never relax the start interlocks
    // max_rpm and vib_rms_stop_g stay 0 (= not commissioned) until a human sets them.
    g_dev = new Device(default_limits(), cfg);
    g_mu = xSemaphoreCreateMutex();
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
    char out[256];
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
