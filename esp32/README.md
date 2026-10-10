# ESP32-S3 Firmware & Sensor Integration (Phase 3)

Embedded C++ firmware for the **Smart DC Motor Monitoring and Predictive Maintenance System** targeting the **ESP32-S3** microcontroller.

---

## 1. Hardware Architecture & Safety Isolation

The system strictly acts as a **Condition Monitoring & Telemetry Node**.

> [!WARNING]
> **ELECTRICAL SAFETY MANDATE**:
> - **NO MOTOR ACTUATION**: The ESP32 does **NOT** drive PWM signals, relays, or motor power switches.
> - **VOLTAGE ISOLATION**: The 24V DC motor power bus must **NEVER** connect directly to any ESP32-S3 GPIO pin (3.3V logic max).
> - **INA219 WIRING**: The INA219 high-side sensor must be placed in series on the motor power rail (rated up to 26V DC, 3.2A default shunt). Ensure ESP32 GND and sensor supply grounds are properly referenced.
> - **A3144 HALL SENSOR**: The Hall-effect output requires a pull-up resistor (internal or external 10kΩ to 3.3V). Do not feed 5V or 24V to the Hall sensor output into the ESP32 GPIO.

---

## 2. Hardware Pinout (ESP32-S3)

> [!IMPORTANT]
> **VERIFY BEFORE WIRING**:
> Different ESP32-S3 boards (DevKitC-1, Waveshare ESP32-S3, Xiao ESP32S3, etc.) have varying pinouts and strapping pins. Verify usable GPIOs on your physical board before connecting. All pin assignments are centralized in Section 1 of `esp32/firmware/smart_motor_monitor.ino`.

| Sensor / Module | Signal | ESP32-S3 GPIO | Bus / Protocol | Notes & Pull-ups |
|---|---|---|---|---|
| **ADXL345** | SDA | `GPIO 8` | I2C (Shared) | I2C Address `0x53` (or `0x1D` if SDO pulled high) |
| **ADXL345** | SCL | `GPIO 9` | I2C (Shared) | Connected to common I2C clock bus |
| **INA219** | SDA | `GPIO 8` | I2C (Shared) | I2C Address `0x40` |
| **INA219** | SCL | `GPIO 9` | I2C (Shared) | Connected to common I2C clock bus |
| **DS18B20** | DATA / DQ | `GPIO 4` | OneWire | **Requires 4.7kΩ pull-up resistor** to 3.3V |
| **A3144 Hall** | OUT / Signal | `GPIO 5` | Hardware Interrupt | Triggered on `FALLING` edge with `INPUT_PULLUP` |

---

## 3. Required Arduino Libraries

Install the following libraries via the **Arduino IDE Library Manager** (`Ctrl+Shift+I` or `Cmd+Shift+I`):

1. **`ArduinoJson`** by *Benoît Blanchon* (v6.x or v7.x) — Fast JSON serialization & deserialization.
2. **`Adafruit ADXL345`** by *Adafruit* — I2C driver for 3-axis accelerometer.
3. **`Adafruit Unified Sensor`** by *Adafruit* — Common sensor abstraction layer.
4. **`DallasTemperature`** by *Miles Burton* — Driver for DS18B20 digital thermometer.
5. **`OneWire`** by *Paul Stoffregen* — OneWire communication bus.
6. **`Adafruit INA219`** by *Adafruit* — High-side DC voltage and current monitor.

*(The `WiFi.h`, `HTTPClient.h`, and `Wire.h` libraries are included automatically in the ESP32 Arduino core).*

---

## 4. Signal Processing & Algorithms

### 4.1 Vibration RMS Calculation
To provide meaningful vibration telemetry rather than raw instantaneous spikes, the firmware uses a windowed dynamic RMS calculation:
1. Samples acceleration across $X$, $Y$, and $Z$ axes over a window of $N = 32$ samples at 2 kHz.
2. Converts raw $m/s^2$ to $g$ ($g = a / 9.80665$).
3. Computes instantaneous acceleration magnitude: $a_{\text{mag}} = \sqrt{g_x^2 + g_y^2 + g_z^2}$.
4. Removes static $1\text{g}$ Earth gravity to isolate the mechanical dynamic vibration: $a_{\text{dyn}} = |a_{\text{mag}} - 1.0\text{g}|$.
5. Averages squared dynamic values and takes the square root:
   $$\text{vibration\_rms} = \sqrt{\frac{\sum_{i=1}^{N} a_{\text{dyn}, i}^2}{N}}$$

### 4.2 Shaft RPM Measurement
- A neodymium magnet is affixed to the motor shaft.
- The A3144 Hall sensor triggers an interrupt service routine (`IRAM_ATTR onHallSensorPulse`) on each magnetic pass.
- Every 500ms, the pulse counter is read and cleared atomically.
- RPM is calculated as:
  $$\text{RPM} = \left(\frac{\text{pulses}}{\text{PULSES\_PER\_REV}}\right) \times \left(\frac{60000}{\text{elapsed\_ms}}\right)$$
- If using multiple magnets on the shaft (e.g. 2 magnets for higher resolution at low speeds), change `#define PULSES_PER_REV 2`.

### 4.3 30-Second Baseline Calibration
1. Backend sends `START_BASELINE` command.
2. ESP32 acknowledges with `POST /api/device/command-ack` (`status: "ACKNOWLEDGED"`).
3. ESP32 accumulates valid readings for 30 seconds (`BASELINE_DURATION_MS = 30000`).
4. Average values are computed exclusively from valid sensor readings.
5. Uploaded to backend via `POST /api/baseline/result`.

---

## 5. Network & Firewall Setup (Windows / LAN)

### Finding Your Laptop's LAN IP Address
1. Open PowerShell / Command Prompt on your host laptop.
2. Run:
   ```powershell
   ipconfig
   ```
3. Locate your active **Wireless LAN adapter Wi-Fi** or **Ethernet adapter**.
4. Note the **IPv4 Address** (e.g., `192.168.1.25`).

### Setting Firmware Constants
In `esp32/firmware/smart_motor_monitor.ino`:
```cpp
const char* WIFI_SSID    = "Your_WiFi_Name";
const char* WIFI_PASS    = "Your_WiFi_Password";
const char* BACKEND_HOST = "192.168.1.25"; // Use Laptop's LAN IP, NOT 127.0.0.1
const int   BACKEND_PORT = 8000;
```

> [!CAUTION]
> **DO NOT USE `127.0.0.1`**:
> On the ESP32, `127.0.0.1` refers to localhost (the ESP32 itself). The ESP32 and the laptop must both be connected to the same Wi-Fi network or mobile hotspot.

### Windows Firewall Configuration
If the ESP32 cannot reach `http://<LAPTOP_IP>:8000`:
- Allow Python / Uvicorn through Windows Defender Firewall.
- Or create an inbound rule in Windows Firewall for TCP port `8000` on Private networks.

---

## 6. Arduino IDE Flashing Procedure

1. **Install ESP32 Core**: In Arduino IDE, go to `Tools` > `Board` > `Boards Manager...` and install `esp32` by *Espressif Systems*.
2. **Select Board**: Select `ESP32-S3 Dev Module` (or your specific ESP32-S3 variant).
3. **USB Mode**: Set `USB CDC On Boot` to `Enabled` (if using built-in USB-OTG).
4. **Select Port**: Select the corresponding COM port (e.g., `COM3`, `COM7`).
5. **Open Sketch**: Open `esp32/firmware/smart_motor_monitor.ino`.
6. **Configure Wi-Fi & Host**: Enter your Wi-Fi credentials and laptop LAN IP in Section 2.
7. **Compile & Upload**: Click the Upload button (`Ctrl+U`).
8. **Open Serial Monitor**: Set baud rate to **115200**.

---

## 7. Serial Monitor Output Format

### Boot Diagnostics Banner:
```text
========================================
 SMART DC MOTOR MONITOR (ESP32-S3)
========================================
Device ID: ESP32-MOTOR-01
Firmware : 1.0.0
Mode     : CONDITION MONITORING ONLY (No Actuation)
----------------------------------------
Initializing hardware sensors...
 - ADXL345  : OK (I2C 0x53, Range: +/-16g)
 - DS18B20  : OK (Found 1 OneWire device on GPIO 4)
 - INA219   : OK (I2C 0x40, Calibrated)
 - A3144    : OK (Configured on GPIO 5 Interrupt, 1 pulse/rev)
----------------------------------------
SENSOR HEALTH STATUS:
 ADXL345 (Vibration) : OK
 DS18B20 (Temp)      : OK
 INA219  (Power)     : OK
 A3144   (RPM)       : OK
----------------------------------------
[WIFI] Connecting to SSID: Home_Network ...
[WIFI] Connected successfully!
[WIFI] ESP32 IP : 192.168.1.150
[WIFI] Backend  : http://192.168.1.25:8000
System: READY
========================================
```

### Periodic 1-Second Telemetry Log:
```text
T: 42.6 C | VIB: 0.182 g | RPM: 1450 | V: 23.80 V | I: 1.42 A | P: 33.80 W | WiFi: OK | Backend: 200
```

---

## 8. Sensor Disconnection & Fault Testing Procedures

| Fault Scenario | Trigger Method | Expected Firmware Behavior | Telemetry Health Report |
|---|---|---|---|
| **ADXL345 Disconnected** | Unplug SDA / SCL or VCC | Fails I2C read; sets vibration values to `0.0`. | `"sensor_health": { "adxl345": false }` |
| **DS18B20 Disconnected** | Unplug Data pin | Detects `DEVICE_DISCONNECTED_C` (-127°C); outputs `0.0`. | `"sensor_health": { "ds18b20": false }` |
| **INA219 Disconnected** | Unplug I2C bus | Fails I2C read; voltage, current & power set to `0.0`. | `"sensor_health": { "ina219": false }` |
| **A3144 No Pulses** | Motor stopped / magnet removed | Pulse counter remains `0`; outputs `0.0` RPM. | `"rpm": 0.0`, `"motor_running": false` |
| **Wi-Fi Network Lost** | Disable Wi-Fi AP | Non-blocking background reconnect runs; no crash. | Telemetry paused until Wi-Fi restored |
| **Backend Server Down** | Stop FastAPI backend | Logs HTTP error code; continues sensor acquisition. | Normal sensor sampling continues uninterrupted |
