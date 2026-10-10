# Hardware Wiring & Physical Bench Safety Specification (Phase 6)

> **Note:** the pin map below comes from the quarantined legacy sketch (`esp32/firmware/README_LEGACY_UNSAFE.md`). It is not an approved or verified wiring contract, and the supported firmware is `esp32/torqva_fw`.


## 1. Physical Bench Safety Procedure

> [!CAUTION]
> **ELECTRICAL & MECHANICAL SAFETY MANDATES**:
> 1. **CONDITION MONITORING ONLY**: The ESP32-S3 firmware and FastAPI backend perform **telemetry acquisition and health analysis ONLY**. The ESP32 does **NOT** drive PWM, relays, MOSFETs, or speed controls.
> 2. **INDEPENDENT MOTOR POWER SUPPLY**: The RS-775 24V DC motor must be powered by an external current-limited DC bench power supply (e.g. 24V / 5A) or dedicated fused 24V DC rail. **NEVER** attempt to power the motor from the ESP32-S3 development board or USB bus.
> 3. **VOLTAGE ISOLATION & COMMON GROUND**:
>    - ESP32-S3 GPIO pins operate strictly at **3.3V logic** with a maximum tolerance of 3.6V.
>    - The 24V motor power rail must connect **ONLY** across the INA219 `VIN+` and `VIN-` screw terminals.
>    - A common DC ground reference (**GND**) must be established between the ESP32-S3 board, sensor breakout boards, and the power supply negative terminal.
> 4. **MECHANICAL STABILITY & ROTATIONAL HAZARD**:
>    - Clamp or bolt the RS-775 motor securely to a rigid test bench baseplate. An unmounted 775 motor can torque-twist and cause wire damage or physical injury.
>    - Affix the neodymium magnet firmly to the rotating shaft (using epoxied collar or hub). Ensure clearance of 1–3 mm between the magnet and A3144 Hall-Effect sensor face.
>    - Keep hands, loose cables, clothing, and tools well clear of the exposed rotating shaft and coupling at all times.
> 5. **EMERGENCY STOP CONDITION**:
>    - Disconnect the 24V DC motor power supply immediately if abnormal current draw (>3.0A unloaded), rapid thermal runaway (>65°C within 1 minute), excessive unbalance vibration, stalling, or electrical arcing is observed.

---

## 2. Component Pinout & Wiring Table

The default software configuration defined in [esp32/firmware/smart_motor_monitor.ino](file:///c:/Users/dkdar/.gemini/antigravity-ide/scratch/smart-motor-monitor/esp32/firmware/smart_motor_monitor.ino) maps to standard ESP32-S3 DevKit boards:

| Component | Pin / Signal | ESP32-S3 GPIO | Power Rail | Ground | Wiring & Pull-Up Notes |
|---|---|---|---|---|---|
| **ADXL345** (Vibration) | `VCC` | — | `3.3V` | `GND` | Decoupled 3.3V supply from ESP32 board |
| | `GND` | — | — | `GND` | Common ground bus |
| | `SDA` | `GPIO 8` | — | — | Shared I2C data bus (Address `0x53`) |
| | `SCL` | `GPIO 9` | — | — | Shared I2C clock bus |
| | `CS` | — | `3.3V` | — | Tied HIGH to select I2C mode |
| | `SDO / ALT` | — | — | `GND` | Tied to GND for address `0x53` (or 3.3V for `0x1D`) |
| **INA219** (Power) | `VCC` | — | `3.3V` | `GND` | Logic supply from ESP32 3.3V rail |
| | `GND` | — | — | `GND` | Common ground bus |
| | `SDA` | `GPIO 8` | — | — | Shared I2C data bus (Address `0x40`) |
| | `SCL` | `GPIO 9` | — | — | Shared I2C clock bus |
| | `VIN+` | — | `+24V Supply` | — | High-side power supply positive terminal |
| | `VIN-` | — | `Motor (+)` | — | Downstream connection to motor positive terminal |
| **DS18B20** (Temperature)| `VCC` / Red | — | `3.3V` | `GND` | 3.3V sensor supply |
| | `GND` / Black | — | — | `GND` | Common ground bus |
| | `DATA` / Yellow | `GPIO 4` | — | — | **Requires 4.7kΩ pull-up resistor** between `DATA` and `3.3V` |
| **A3144** (Hall RPM) | `VCC` / Pin 1 | — | `3.3V` | `GND` | 3.3V sensor supply |
| | `GND` / Pin 2 | — | — | `GND` | Common ground bus |
| | `OUT` / Pin 3 | `GPIO 5` | — | — | Open-drain output with ESP32 `INPUT_PULLUP` enabled |

---

## 3. I2C Bus Architecture & Device Discovery

Both the **ADXL345** and **INA219** operate concurrently on the primary hardware I2C bus (`Wire`):
- **SDA Pin**: `GPIO 8`
- **SCL Pin**: `GPIO 9`
- **Clock Frequency**: 100 kHz standard mode / 400 kHz fast mode

### I2C Address Map:
- **`0x40`**: Adafruit INA219 High-Side Power Monitor (Default address with `A0`/`A1` grounded).
- **`0x53`**: Analog Devices ADXL345 3-Axis Accelerometer (Default address with `SDO` pin grounded).
- *(Alternate `0x1D`)*: ADXL345 if `SDO` is pulled to 3.3V.

### I2C Scanner Diagnostic Procedure:
To verify device detection prior to running full monitoring firmware, run an I2C scan:
```cpp
#include <Wire.h>

void setup() {
  Serial.begin(115200);
  Wire.begin(8, 9); // SDA=GPIO8, SCL=GPIO9
  Serial.println("\n--- Scanning I2C Bus (SDA: 8, SCL: 9) ---");
  for (byte address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) {
      Serial.printf("Found device at address 0x%02X\n", address);
    }
  }
}
void loop() {}
```

---

## 4. Mechanical Mounting Guidelines

1. **ADXL345 Accelerometer Mounting**:
   - Rigidly adhere or screw the ADXL345 breakout board onto the motor casing near the front drive bearing using non-conductive epoxy, thermal mounting tape, or a dedicated 3D-printed mounting bracket.
   - Orient the board such that one axis ($Z$) is perpendicular to the motor housing surface.
2. **DS18B20 Temperature Probe**:
   - Place the metallic probe directly against the motor stator casing.
   - Apply a small dab of thermal paste and secure with thermal insulation tape to minimize ambient cooling bias.
3. **A3144 Hall-Effect RPM Sensor**:
   - Fix the Hall sensor onto a stationary bracket facing the motor shaft.
   - Mount a small neodymium disc magnet onto the motor shaft or coupling sleeve with South pole facing the sensor face.
   - Maintain air gap of $1.5\text{ mm} \pm 0.5\text{ mm}$.
   - Ensure `#define PULSES_PER_REV 1` in firmware matches the physical magnet count.

---

## 5. Wi-Fi & Host Machine Network Configuration

1. **Host Backend Discovery**:
   - The ESP32-S3 communicates with FastAPI over standard HTTP REST (`POST /api/ingest`, `GET /api/device/commands`, etc.).
   - In [esp32/firmware/smart_motor_monitor.ino](file:///c:/Users/dkdar/.gemini/antigravity-ide/scratch/smart-motor-monitor/esp32/firmware/smart_motor_monitor.ino):
     ```cpp
     const char* WIFI_SSID    = "YOUR_WLAN_SSID";
     const char* WIFI_PASS    = "YOUR_WLAN_PASSWORD";
     const char* BACKEND_HOST = "192.168.1.100"; // IPv4 address of laptop running FastAPI
     const int   BACKEND_PORT = 8000;
     ```
2. **Windows Firewall Rule**:
   - Allow Python / Uvicorn inbound on port `8000` across Private networks:
     ```powershell
     New-NetFirewallRule -DisplayName "FastAPI Motor Monitor (Port 8000)" -Direction Inbound -LocalPort 8000 -Protocol TCP -Action Allow
     ```

---

## 6. Pre-Power Checklist

- [ ] Motor securely bolted to bench plate.
- [ ] 24V DC bench power supply set to current limit (max 3.5A).
- [ ] INA219 high-side connections verified (`VIN+` to Power Supply +, `VIN-` to Motor +).
- [ ] Common ground established between ESP32 GND and power supply negative terminal.
- [ ] 4.7kΩ pull-up verified on DS18B20 `DATA` line.
- [ ] Shaft magnet secure and clear of wiring.
- [ ] ESP32-S3 connected via USB-C to host development PC.
