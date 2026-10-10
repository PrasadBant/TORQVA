# Hardware Specification & Pinout Guide

> **Note:** the pin map below was carried over from the wiring of the retired legacy sketch (removed from the current tree; Git history only). It is not an approved or verified wiring contract. The authoritative map is `esp32/torqva_fw/lib/torqva_core/pinmap.h`; `esp32/torqva_fw/` is the sole supported firmware. The hardware is not ready for physical motor operation.


## 1. Overview
The Smart DC Motor Monitoring and Predictive Maintenance System utilizes an **ESP32-S3** microcontroller paired with industrial-grade sensors and a high-current **BTS7960 DC Motor Driver** for an RS-775 24V DC Motor.

---

## 2. Microcontroller & Sensor Summary

| Module / Sensor | Primary Function | Protocol / Interface | Operating Voltage |
|---|---|---|---|
| **ESP32-S3** | Microcontroller & Processing Unit | Wi-Fi 802.11 b/g/n, Dual I2C | 3.3V Logic |
| **ADXL345** | 3-Axis Acceleration & Vibration RMS | I2C (Bus 0, Address `0x53`) | 3.3V |
| **DS18B20** | Casing Temperature (°C) | OneWire (4.7kΩ pull-up) | 3.3V |
| **INA219** | DC Bus Voltage ($V$), Current ($A$), Power ($W$) | I2C (Bus 1, Address `0x40`) | 3.3V Logic / Up to 26V DC Rail |
| **A3144** | Shaft RPM Hall Interrupt | Digital Interrupt (`INPUT_PULLUP`) | 3.3V |
| **SH1106 OLED** | 1.3" 128x64 Local Status Display | I2C (Bus 0) | 3.3V |
| **BTS7960** | 43A High-Power DC Motor Driver | PWM & Enable Pins | 3.3V Logic / 24V Motor Bus |
| **Status LEDs** | Individual Sensor Health Indicators | Digital GPIO Outputs | 3.3V |
| **Buzzer** | Audible Sensor Fault Alert | Digital GPIO Output | 3.3V |

---

## 3. ESP32-S3 Hardware Pin Mapping

> [!IMPORTANT]
> HISTORICAL pin table (an older revision of the retired sketch's wiring). It can disagree with the authoritative map `esp32/torqva_fw/lib/torqva_core/pinmap.h` (for example BTS7960 and ADXL345 pins); where they differ, `pinmap.h` wins, and neither is a verified wiring contract.

| Function / Signal | Pin Name | ESP32-S3 GPIO | Interface / Mode | Notes & Wiring |
|---|---|---|---|---|
| **ADXL345 SDA** | `ADXL_SDA` | `GPIO 4` | I2C Bus 0 | Shared I2C data bus with OLED |
| **ADXL345 SCL** | `ADXL_SCL` | `GPIO 5` | I2C Bus 0 | Shared I2C clock bus with OLED |
| **DS18B20 Temp** | `ONE_WIRE_BUS` | `GPIO 6` | OneWire | Requires 4.7kΩ pull-up resistor to 3.3V |
| **INA219 SDA** | `INA_SDA` | `GPIO 7` | I2C Bus 1 | Dedicated I2C bus for high-side sensor |
| **INA219 SCL** | `INA_SCL` | `GPIO 8` | I2C Bus 1 | Dedicated I2C bus for high-side sensor |
| **A3144 Hall RPM**| `HALL_PIN` | `GPIO 9` | Digital Interrupt | `FALLING` edge trigger, `INPUT_PULLUP` |
| **ADXL Status LED**| `ADXL_LED` | `GPIO 10` | Digital Output | Active HIGH when ADXL345 is healthy |
| **TEMP Status LED**| `TEMP_LED` | `GPIO 11` | Digital Output | Active HIGH when DS18B20 is healthy |
| **INA Status LED** | `INA_LED` | `GPIO 12` | Digital Output | Active HIGH when INA219 is healthy |
| **HALL Status LED**| `HALL_LED` | `GPIO 13` | Digital Output | Active HIGH when Hall sensor is healthy |
| **Buzzer Output** | `BUZZER_PIN` | `GPIO 14` | Digital Output | Active HIGH on sensor fault |
| **BTS7960 RPWM**  | `PIN_RPWM` | `GPIO 15` | PWM Output | Forward Speed PWM (Default 200/255) |
| **BTS7960 LPWM**  | `PIN_LPWM` | `GPIO 16` | Digital Output | Reverse Speed PWM (Set to 0) |
| **BTS7960 R_EN**  | `PIN_R_EN` | `GPIO 17` | Digital Output | Forward Enable (HIGH = ON, LOW = OFF) |
| **BTS7960 L_EN**  | `PIN_L_EN` | `GPIO 18` | Digital Output | Reverse Enable (HIGH = ON, LOW = OFF) |

---

## 4. BTS7960 Motor Driver Integration Safety

- **Do NOT connect the motor directly to ESP32-S3 GPIO pins.**
- The BTS7960 motor driver handles the high current (up to 43A) required by the RS-775 24V DC motor.
- ESP32-S3 controls the motor safely via 3.3V logic signals on GPIO 15, 16, 17, and 18.
- Common Ground (GND) must be tied between ESP32-S3, BTS7960 logic GND, and the 24V power supply GND.
