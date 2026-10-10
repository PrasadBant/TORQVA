/*
 * =========================================================================
 * Smart DC Motor Monitoring and Predictive Maintenance System
 * Full Working Firmware with OLED SH1106, Sensor LEDs, Buzzer, Baseline,
 * Live Sensor Acquisition, WiFi, TCP Server Telemetry & BTS7960 Motor Control.
 * =========================================================================
 * 
 * HARDWARE PIN MAP:
 * -------------------------------------------------------------------------
 * ADXL345 SDA        : GPIO 4   (I2C Bus 0 shared with OLED)
 * ADXL345 SCL        : GPIO 5   (I2C Bus 0 shared with OLED)
 * DS18B20 OneWire    : GPIO 6   (Temperature Sensor)
 * INA219 SDA         : GPIO 7   (I2C Bus 1)
 * INA219 SCL         : GPIO 8   (I2C Bus 1)
 * A3144 Hall RPM     : GPIO 9   (ISR Interrupt Pin)
 * ADXL Status LED    : GPIO 10  (Status Indicator)
 * TEMP Status LED    : GPIO 11  (Status Indicator)
 * INA Status LED     : GPIO 12  (Status Indicator)
 * HALL Status LED    : GPIO 13  (Status Indicator)
 * BUZZER             : GPIO 14  (Audible Alert)
 * BTS7960 RPWM       : GPIO 15  (Forward Speed PWM)
 * BTS7960 LPWM       : GPIO 16  (Reverse Speed PWM - Set to 0)
 * BTS7960 R_EN       : GPIO 17  (Forward Enable - HIGH when ON)
 * BTS7960 L_EN       : GPIO 18  (Reverse Enable - HIGH when ON)
 * =========================================================================
 */

#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_ADXL345_U.h>
#include <Adafruit_INA219.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <Preferences.h>
#include <U8g2lib.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <math.h>

// =====================================================
// PIN DEFINITIONS
// =====================================================

#define ADXL_SDA            4
#define ADXL_SCL            5

#define ONE_WIRE_BUS        6

#define INA_SDA             7
#define INA_SCL             8

#define HALL_PIN            9

#define ADXL_LED            10
#define TEMP_LED            11
#define INA_LED             12
#define HALL_LED            13

#define BUZZER_PIN          14

// BTS7960 Motor Driver Pins
#define PIN_RPWM            15
#define PIN_LPWM            16
#define PIN_R_EN            17
#define PIN_L_EN            18

// =====================================================
// MOTOR STATE THRESHOLDS & NETWORK CONFIG
// =====================================================

#define MIN_RUNNING_RPM     100
#define MIN_RUNNING_CURRENT 0.10

#define NORMAL_CONDITION_MIN    25.0
#define CRITICAL_CONDITION_MAX  0.0

#define BUZZER_DURATION         3000

const char* WIFI_SSID       = "YOUR_WIFI_SSID";
const char* WIFI_PASS       = "YOUR_WIFI_PASSWORD";
const char* BACKEND_HOST    = "10.15.170.3";
const int   TCP_SERVER_PORT = 5001;
const int   BACKEND_PORT    = 8000;

const char* DEVICE_ID       = "ESP32-MOTOR-01";
const char* FIRMWARE_VER    = "2.0.0";

// =====================================================
// SENSOR OBJECTS & PERIPHERALS
// =====================================================

Adafruit_ADXL345_Unified accel = Adafruit_ADXL345_Unified(12345);
TwoWire INA_Wire = TwoWire(1);
Adafruit_INA219 ina219;
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);
Preferences preferences;

// SH1106 1.3" I2C OLED Display
U8G2_SH1106_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

// Network TCP Client
WiFiClient tcpClient;

// =====================================================
// HALL SENSOR & INTERRUPT
// =====================================================

volatile unsigned long pulseCount = 0;
volatile unsigned long lastPulseTime = 0;

void IRAM_ATTR countPulse() {
    unsigned long currentTime = micros();
    if (currentTime - lastPulseTime > 5000) { // 5ms debounce
        pulseCount++;
        lastPulseTime = currentTime;
    }
}

// =====================================================
// GLOBAL STATE VARIABLES
// =====================================================

bool adxlOK = false;
bool inaOK = false;
bool tempOK = false;
bool hallOK = true;
bool motorStateOn = false;

float baselineTemperature = 0;
float baselineVoltage     = 0;
float baselineCurrent     = 0;
float baselinePower       = 0;
float baselineRPM         = 0;
float baselineVibration   = 0;
bool  baselineStored      = false;

unsigned long buzzerStartTime    = 0;
bool          buzzerActive       = false;
bool          previousSensorError = false;

unsigned long lastRpmCalcMillis  = 0;
unsigned long lastTelemetryMillis = 0;
unsigned long lastWiFiAttempt    = 0;

// Filter Accumulators
float accumTemp     = 0;
float accumX        = 0, accumY = 0, accumZ = 0;
float accumVib      = 0;
float accumCurrent  = 0;
float accumVoltage  = 0;

int tempSamples  = 0;
int accelSamples = 0;
int inaSamples   = 0;

// =====================================================
// MOTOR HARDWARE CONTROL LAYER (BTS7960)
// =====================================================

void setMotorState(bool turnOn) {
    if (turnOn) {
        pinMode(PIN_R_EN, OUTPUT);
        pinMode(PIN_L_EN, OUTPUT);
        pinMode(PIN_RPWM, OUTPUT);
        pinMode(PIN_LPWM, OUTPUT);

        digitalWrite(PIN_R_EN, HIGH);
        digitalWrite(PIN_L_EN, HIGH);
        analogWrite(PIN_RPWM, 200);   // Forward PWM speed (200/255)
        digitalWrite(PIN_LPWM, LOW);
        motorStateOn = true;
        Serial.println("[MOTOR] BTS7960 Driver ACTIVATED: MOTOR ON (RPWM=200, R_EN/L_EN=HIGH)");
    } else {
        analogWrite(PIN_RPWM, 0);
        digitalWrite(PIN_LPWM, LOW);
        digitalWrite(PIN_R_EN, LOW);
        digitalWrite(PIN_L_EN, LOW);
        motorStateOn = false;
        Serial.println("[MOTOR] BTS7960 Driver DEACTIVATED: MOTOR OFF (RPWM=0, R_EN/L_EN=LOW)");
    }
}

// =====================================================
// LOAD BASELINE FROM PREFERENCES
// =====================================================

void loadBaseline() {
    preferences.begin("motor", true);
    baselineStored = preferences.getBool("stored", false);
    if (baselineStored) {
        baselineTemperature = preferences.getFloat("temp", 0);
        baselineVoltage     = preferences.getFloat("volt", 0);
        baselineCurrent     = preferences.getFloat("curr", 0);
        baselinePower       = preferences.getFloat("power", 0);
        baselineRPM         = preferences.getFloat("rpm", 0);
        baselineVibration   = preferences.getFloat("vib", 0);
    }
    preferences.end();
}

// =====================================================
// CALCULATE DEVIATIONS & CONDITION PERCENTAGE
// =====================================================

float calculateDeviation(float liveValue, float baselineValue) {
    if (baselineValue == 0) return 0;
    return ((liveValue - baselineValue) / baselineValue) * 100.0;
}

float calculateConditionPercentage(float deviation) {
    return 100.0 - fabs(deviation);
}

float displayConditionPercentage(float conditionPercentage) {
    if (conditionPercentage < 0) return 0;
    if (conditionPercentage > 100) return 100;
    return conditionPercentage;
}

// =====================================================
// OLED DISPLAY FUNCTION
// =====================================================

void displayOLED(String condition) {
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_6x12_tf);
    u8g2.drawStr(0, 12, "MOTOR CONDITION");
    u8g2.drawHLine(0, 16, 128);

    if (condition == "NORMAL") {
        u8g2.setFont(u8g2_font_10x20_tf);
        u8g2.drawStr(15, 42, "NORMAL");
    } else if (condition == "WARNING") {
        u8g2.setFont(u8g2_font_10x20_tf);
        u8g2.drawStr(8, 42, "WARNING");
    } else if (condition == "CRITICAL") {
        u8g2.setFont(u8g2_font_10x20_tf);
        u8g2.drawStr(2, 42, "CRITICAL");
    } else if (condition == "SENSOR FAULT") {
        u8g2.setFont(u8g2_font_9x18_tf);
        u8g2.drawStr(0, 42, "SENSOR ERROR");
    } else if (condition == "MOTOR OFF") {
        u8g2.setFont(u8g2_font_9x18_tf);
        u8g2.drawStr(5, 42, "MOTOR OFF");
    } else {
        u8g2.setFont(u8g2_font_8x13_tf);
        u8g2.drawStr(5, 42, condition.c_str());
    }
    u8g2.sendBuffer();
}

// =====================================================
// UPDATE SENSOR LEDs & BUZZER
// =====================================================

void updateSensorLEDs(bool currentAdxlOK, bool currentTempOK, bool currentInaOK, bool currentHallOK) {
    digitalWrite(ADXL_LED, currentAdxlOK ? HIGH : LOW);
    digitalWrite(TEMP_LED, currentTempOK ? HIGH : LOW);
    digitalWrite(INA_LED,  currentInaOK  ? HIGH : LOW);
    digitalWrite(HALL_LED, currentHallOK ? HIGH : LOW);
}

void updateBuzzer(bool sensorError) {
    unsigned long currentMillis = millis();

    if (sensorError && !previousSensorError) {
        buzzerActive = true;
        buzzerStartTime = currentMillis;
        digitalWrite(BUZZER_PIN, HIGH);
    }

    if (buzzerActive) {
        if (currentMillis - buzzerStartTime >= BUZZER_DURATION) {
            buzzerActive = false;
            digitalWrite(BUZZER_PIN, LOW);
        }
    } else {
        digitalWrite(BUZZER_PIN, LOW);
    }

    previousSensorError = sensorError;
}

// =====================================================
// NON-BLOCKING WIFI & TCP COMMAND HANDLING
// =====================================================

void maintainWiFiConnection() {
    if (WiFi.status() == WL_CONNECTED) return;

    unsigned long currentMillis = millis();
    if (lastWiFiAttempt == 0 || (currentMillis - lastWiFiAttempt >= 5000)) {
        lastWiFiAttempt = currentMillis;
        Serial.printf("[WIFI] Connecting to SSID: %s ...\n", WIFI_SSID);
        WiFi.mode(WIFI_STA);
        WiFi.begin(WIFI_SSID, WIFI_PASS);
    }
}

void maintainTCPConnectionAndPollCommands() {
    if (WiFi.status() != WL_CONNECTED) {
        if (motorStateOn) setMotorState(false);
        return;
    }

    if (!tcpClient.connected()) {
        if (motorStateOn) setMotorState(false);
        static unsigned long lastConnectAttempt = 0;
        if (millis() - lastConnectAttempt > 2000) {
            lastConnectAttempt = millis();
            Serial.printf("[TCP] Connecting to backend TCP server: %s:%d ...\n", BACKEND_HOST, TCP_SERVER_PORT);
            if (tcpClient.connect(BACKEND_HOST, TCP_SERVER_PORT)) {
                tcpClient.setNoDelay(true);
                Serial.println("[TCP] Socket connected successfully to backend server!");
            }
        }
        return;
    }

    // Read incoming commands over active TCP socket stream
    static String tcpCommandBuffer = "";
    while (tcpClient.available() > 0) {
        char c = (char)tcpClient.read();
        if (c == '\n') {
            tcpCommandBuffer.trim();
            if (tcpCommandBuffer.length() > 0) {
                Serial.printf("[TCP RX] Command received: '%s'\n", tcpCommandBuffer.c_str());

                if (tcpCommandBuffer == "MOTOR_ON") {
                    Serial.println("[TCP CMD] Executing MOTOR_ON...");
                    setMotorState(true);
                    tcpClient.print("MOTOR_ON_ACK\n");
                    tcpClient.flush();
                    Serial.println("[TCP TX] Sent MOTOR_ON_ACK to backend.");
                } else if (tcpCommandBuffer == "MOTOR_OFF") {
                    Serial.println("[TCP CMD] Executing MOTOR_OFF...");
                    setMotorState(false);
                    tcpClient.print("MOTOR_OFF_ACK\n");
                    tcpClient.flush();
                    Serial.println("[TCP TX] Sent MOTOR_OFF_ACK to backend.");
                }
            }
            tcpCommandBuffer = "";
        } else if (c != '\r') {
            tcpCommandBuffer += c;
        }
    }
}

// =====================================================
// SETUP
// =====================================================

void setup() {
    Serial.begin(115200);
    delay(1000);

    // Initialize Pin Outputs
    pinMode(ADXL_LED,   OUTPUT);
    pinMode(TEMP_LED,   OUTPUT);
    pinMode(INA_LED,    OUTPUT);
    pinMode(HALL_LED,   OUTPUT);
    pinMode(BUZZER_PIN, OUTPUT);

    digitalWrite(ADXL_LED,   LOW);
    digitalWrite(TEMP_LED,   LOW);
    digitalWrite(INA_LED,    LOW);
    digitalWrite(HALL_LED,   LOW);
    digitalWrite(BUZZER_PIN, LOW);

    // Initialize Motor Driver Pins
    pinMode(PIN_RPWM, OUTPUT);
    pinMode(PIN_LPWM, OUTPUT);
    pinMode(PIN_R_EN, OUTPUT);
    pinMode(PIN_L_EN, OUTPUT);
    setMotorState(false); // Default: MOTOR OFF

    // Initialize I2C Bus 0 for OLED & ADXL345 (GPIO 4 / 5)
    Wire.begin(ADXL_SDA, ADXL_SCL);
    u8g2.begin();

    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_6x12_tf);
    u8g2.drawStr(5, 25, "MOTOR CONDITION");
    u8g2.drawStr(25, 45, "STARTING...");
    u8g2.sendBuffer();
    delay(1000);

    Serial.println("\n======================================");
    Serial.println("  MOTOR CONDITION MONITOR & CONTROL");
    Serial.println("======================================");

    // Initialize ADXL345
    if (accel.begin()) {
        adxlOK = true;
        accel.setRange(ADXL345_RANGE_16_G);
        Serial.println("ADXL345 : OK (GPIO 4/5)");
    } else {
        Serial.println("ADXL345 : ERROR");
    }

    // Initialize INA219 on I2C Bus 1 (GPIO 7 / 8)
    INA_Wire.begin(INA_SDA, INA_SCL);
    if (ina219.begin(&INA_Wire)) {
        inaOK = true;
        Serial.println("INA219  : OK (GPIO 7/8)");
    } else {
        Serial.println("INA219  : ERROR");
    }

    // Initialize DS18B20 on GPIO 6
    sensors.begin();
    sensors.setWaitForConversion(false);
    if (sensors.getDeviceCount() > 0) {
        tempOK = true;
        Serial.println("DS18B20 : OK (GPIO 6)");
    } else {
        Serial.println("DS18B20 : ERROR");
    }

    // Initialize Hall Sensor on GPIO 9
    pinMode(HALL_PIN, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(HALL_PIN), countPulse, FALLING);
    Serial.println("HALL    : READY (GPIO 9)");

    loadBaseline();
    updateSensorLEDs(adxlOK, tempOK, inaOK, true);

    if (!adxlOK || !tempOK || !inaOK) {
        digitalWrite(BUZZER_PIN, HIGH);
        delay(1000);
        digitalWrite(BUZZER_PIN, LOW);
    }

    // Non-blocking WiFi connection startup
    maintainWiFiConnection();
    lastRpmCalcMillis   = millis();
    lastTelemetryMillis = millis();

    Serial.println("System: READY (Motor OFF by default)\n======================================\n");
}

// =====================================================
// MAIN LOOP
// =====================================================

void loop() {
    // Non-blocking Wi-Fi & TCP Connection Maintenance
    maintainWiFiConnection();
    maintainTCPConnectionAndPollCommands();

    // 1. Continuous Non-Blocking Sensor Sampling
    if (tempOK) {
        float t = sensors.getTempCByIndex(0);
        sensors.requestTemperatures();
        if (t != DEVICE_DISCONNECTED_C && t > -50 && t < 150) {
            accumTemp += t;
            tempSamples++;
        }
    }

    if (adxlOK) {
        sensors_event_t event;
        accel.getEvent(&event);
        float x = event.acceleration.x;
        float y = event.acceleration.y;
        float z = event.acceleration.z;
        float mag = sqrt(x * x + y * y + z * z);
        float vib = fabs(mag - 9.81);

        accumX += x; accumY += y; accumZ += z;
        accumVib += vib;
        accelSamples++;
    }

    if (inaOK) {
        accumCurrent += ina219.getCurrent_mA();
        accumVoltage += ina219.getBusVoltage_V();
        inaSamples++;
    }

    // 2. Periodic 1-Second Evaluation & Telemetry Transmission
    unsigned long currentMillis = millis();
    if (currentMillis - lastTelemetryMillis >= 1000) {
        lastTelemetryMillis = currentMillis;

        // Calculate Averages
        float avgTemp = (tempSamples > 0) ? (accumTemp / tempSamples) : 0.0;
        float avgX   = (accelSamples > 0) ? (accumX / accelSamples) : 0.0;
        float avgY   = (accelSamples > 0) ? (accumY / accelSamples) : 0.0;
        float avgZ   = (accelSamples > 0) ? (accumZ / accelSamples) : 0.0;
        float avgVib = (accelSamples > 0) ? (accumVib / accelSamples) : 0.0;
        float avgCurr_A = (inaSamples > 0) ? ((accumCurrent / inaSamples) / 1000.0) : 0.0;
        float avgVolt = (inaSamples > 0) ? (accumVoltage / inaSamples) : 0.0;
        float power_W = avgVolt * avgCurr_A;

        // Reset Sample Accumulators
        accumTemp = 0; tempSamples = 0;
        accumX = 0; accumY = 0; accumZ = 0; accumVib = 0; accelSamples = 0;
        accumCurrent = 0; accumVoltage = 0; inaSamples = 0;

        // Calculate Shaft RPM
        noInterrupts();
        unsigned long pulses = pulseCount;
        pulseCount = 0;
        interrupts();

        float elapsedSec = (currentMillis - lastRpmCalcMillis) / 1000.0;
        lastRpmCalcMillis = currentMillis;
        float rpm = (elapsedSec > 0) ? ((pulses / 1.0) * (60.0 / elapsedSec)) : 0.0;

        // Determine Running & Health Status
        bool motorRunning = motorStateOn || (rpm >= MIN_RUNNING_RPM || avgCurr_A >= MIN_RUNNING_CURRENT);
        bool currentTempOK = tempOK;
        bool currentAdxlOK = adxlOK;
        bool currentInaOK  = inaOK;
        bool currentHallOK = motorRunning ? (pulses > 0) : true;
        bool sensorError   = (!currentAdxlOK || !currentTempOK || !currentInaOK || !currentHallOK);

        updateSensorLEDs(currentAdxlOK, currentTempOK, currentInaOK, currentHallOK);
        updateBuzzer(sensorError);

        // Deviations & Condition Analysis
        float tempDev = 0, voltDev = 0, currDev = 0, powerDev = 0, rpmDev = 0, vibDev = 0;
        float tempCond = 100, voltCond = 100, currCond = 100, powerCond = 100, rpmCond = 100, vibCond = 100;

        if (motorRunning && baselineStored) {
            if (baselineTemperature != 0) { tempDev = calculateDeviation(avgTemp, baselineTemperature); tempCond = calculateConditionPercentage(tempDev); }
            if (baselineVoltage != 0)     { voltDev = calculateDeviation(avgVolt, baselineVoltage);     voltCond = calculateConditionPercentage(voltDev); }
            if (baselineCurrent != 0)     { currDev = calculateDeviation(avgCurr_A, baselineCurrent);   currCond = calculateConditionPercentage(currDev); }
            if (baselinePower != 0)       { powerDev = calculateDeviation(power_W, baselinePower);      powerCond = calculateConditionPercentage(powerDev); }
            if (baselineRPM != 0)         { rpmDev = calculateDeviation(rpm, baselineRPM);              rpmCond = calculateConditionPercentage(rpmDev); }
            if (baselineVibration != 0)   { vibDev = calculateDeviation(avgVib, baselineVibration);     vibCond = calculateConditionPercentage(vibDev); }
        }

        String condition = "NORMAL";
        String reason    = "All parameters within normal baseline range";
        float overallCond = 100.0;

        if (!motorRunning) {
            condition = "MOTOR OFF";
            reason    = "Motor is not running";
        } else if (!baselineStored) {
            condition = "NO BASELINE";
            reason    = "Baseline unavailable";
        } else if (sensorError) {
            condition = "SENSOR FAULT";
            reason    = !currentTempOK ? "Temperature sensor error" : (!currentInaOK ? "INA219 error" : (!currentAdxlOK ? "ADXL345 error" : "Hall sensor error"));
        } else {
            overallCond = tempCond;
            reason = "Temperature deviation";

            if (voltCond < overallCond)  { overallCond = voltCond;  reason = "Voltage deviation"; }
            if (currCond < overallCond)  { overallCond = currCond;  reason = "Current deviation"; }
            if (powerCond < overallCond) { overallCond = powerCond; reason = "Power deviation"; }
            if (rpmCond < overallCond)   { overallCond = rpmCond;   reason = "RPM deviation"; }
            if (vibCond < overallCond)   { overallCond = vibCond;   reason = "Vibration deviation"; }

            if (overallCond <= CRITICAL_CONDITION_MAX) {
                condition = "CRITICAL";
                reason += " reached critical level";
            } else if (overallCond < NORMAL_CONDITION_MIN) {
                condition = "WARNING";
                reason += " reached warning level";
            } else {
                condition = "NORMAL";
                reason = "All parameters within normal baseline range";
            }
        }

        // Update OLED
        displayOLED(condition);

        // Transmit TCP JSON Telemetry to Backend
        StaticJsonDocument<512> doc;
        doc["device_id"]         = DEVICE_ID;
        doc["firmware"]          = FIRMWARE_VER;
        doc["timestamp"]         = (double)millis() / 1000.0;
        doc["motor_running"]     = motorRunning;
        doc["motor"]             = motorStateOn ? "RUNNING" : "OFF";
        doc["temperature"]       = avgTemp;
        doc["vibration_x"]       = avgX / 9.81;
        doc["vibration_y"]       = avgY / 9.81;
        doc["vibration_z"]       = avgZ / 9.81;
        doc["vibration_rms"]     = avgVib / 9.81;
        doc["vibration"]         = avgVib;
        doc["rpm"]               = rpm;
        doc["voltage"]           = avgVolt;
        doc["current"]           = avgCurr_A;
        doc["power"]             = power_W;
        doc["hardware_condition"] = condition;
        doc["hardware_reason"]   = reason;
        doc["status"]            = condition;
        doc["reason"]            = reason;
        doc["condition"]         = displayConditionPercentage(overallCond);

        JsonObject sensorHealth  = doc.createNestedObject("sensor_health");
        sensorHealth["adxl345"]  = currentAdxlOK;
        sensorHealth["ds18b20"]  = currentTempOK;
        sensorHealth["ina219"]   = currentInaOK;
        sensorHealth["a3144"]    = currentHallOK;

        String jsonBody;
        serializeJson(doc, jsonBody);
        Serial.println(jsonBody);

        if (tcpClient.connected()) {
            tcpClient.println(jsonBody);
            tcpClient.flush();
        }
    }
}
