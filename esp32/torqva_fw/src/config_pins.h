// Pin map "W0-optionB" (DRAFT, docs/TORQVA_WIRING.md section 4.2 Option B). NOT verified against the
// physical build: the wiring ID reported in every status frame stays "W0-optionB-UNVERIFIED" until a human
// confirms the real wiring (Phase 8). All pins are valid on ESP32-S3 N16R8 (none of 0/3/45/46, 19/20, 35-37).
#pragma once

#define TORQVA_WIRING_ID   "W0-optionB-UNVERIFIED"
#define TORQVA_FW_VERSION  "3.0.0-dev"

#define PIN_HALL        9     // A3144 open-collector, interrupt
#define PIN_ONEWIRE     6     // DS18B20 x2: index 0 housing, index 1 ambient
#define PIN_I2C1_SDA    7     // INA219 (legacy second I2C bus)
#define PIN_I2C1_SCL    8
#define PIN_RPWM        15    // BTS7960 forward PWM
#define PIN_LPWM        16    // held LOW (unidirectional)
#define PIN_EN          17    // R_EN
#define PIN_EN2         18    // L_EN (tied to the same net as R_EN in hardware)
#define PIN_RELAY       21    // motor-power relay (via driver stage); energised = motor power present
#define PIN_BUTTON      38    // local acknowledge button, active LOW, internal pull-up

// Sensor scaling. INA219 library calibrates for a 0.1 ohm shunt; after the shunt swap set this to 0.05.
#ifndef TORQVA_SHUNT_OHM
#define TORQVA_SHUNT_OHM 0.1f
#endif

#define PWM_FREQ_HZ     20000
#define PWM_RES_BITS    10
#define HALL_MIN_PERIOD_US 2000   // ignore pulses faster than 30 000 rpm (bounce / noise)
