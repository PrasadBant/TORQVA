# TORQVA — Complete Project Overview

> **Last updated:** 25 Nov 2026 · Branch `torqva/phase-0-audit` · GitHub `PrasadBant/TORQVA`
>
> This single file captures everything about the project: what it is, how it works, the full tech stack, hardware, firmware, backend, frontend, AI pipeline, test suite, API surface, and development status. Use it as the canonical briefing document.

---

## Wireless engineering status (25 Nov 2026)

The repository has an ESP32-S3 production build profile, `esp32s3_wireless`, that enables the existing authenticated outbound Wi-Fi WebSocket and HTTPS OTA receiver. The backend's `TORQVA_DEVICE_LINK=1` setting accepts that link; the same device bridge and command protocol handle USB and Wi-Fi. The firmware build succeeds, but no physical deployment of this production profile has been verified in this work.

Firmware Manager currently validates and deploys signed **compiled application `.bin` files**. Source upload, isolated PlatformIO compilation from the website, source editing, automatic discovery, network switching, a wireless log console, and manual rollback are not yet implemented. The production USB link stays authoritative while attached; unplugging its data cable allows the board's outbound Wi-Fi link to connect. The existing LED-only bench profile supports USB-to-Wi-Fi handover.

The OTA slot is 3,342,336 bytes under the pinned `default_8MB.csv` partition table despite the N16R8's 16 MB flash. The production wireless binary compiled at 989,497 flash bytes and 54,984 static RAM bytes. The existing signed OTA path and rollback tests are software-verified; hardware verification is pending. See [WIRELESS_ARCHITECTURE.md](WIRELESS_ARCHITECTURE.md) and [TEST_REPORT.md](TEST_REPORT.md).

## 1. What TORQVA Is

TORQVA is a **physical-AI platform for a DC motor test rig**. It reads live sensors on a real RS-775 motor through an ESP32-S3 board, streams the data to a React web app, runs a full AI diagnostic pipeline (anomaly detection → fault hypothesis ranking → outcome prediction → decision gate → diagnostic tests → recovery verification → continuous learning), and allows an authenticated operator to issue motor commands through a multi-layer safety stack.

### Core Design Principles

| Principle | What it means in practice |
|---|---|
| **Physical-device first** | App opens in Physical mode; Simulation is an explicit, labelled opt-in |
| **Never invent data** | Missing/invalid sensors show `UNAVAILABLE`, never `0`; every value carries a provenance badge (`MEASURED`, `DERIVED`, `SIM`, `CMD`, `PRED`) |
| **Direct & safe operation** | Authenticated direct operator control to hardware with real-time feedback and instant response |
| **Honest status** | "Sent" ≠ "Executed". Only a device ack counts. Hardware items are never marked VERIFIED by software |
| **Architectural isolation** | `physical/` and `simulation/` frontend pages never import each other; only `shared/` and `api.js` are shared |

### What Works Today (Nov 2026)

- **Physical mode & live rig**:
  - Live USB-serial bridge to ESP32-S3 (`RIG-1`, firmware `3.0.1-dev`, wire protocol v1) over COM10.
  - Streaming 10 Hz fast telemetry frames (rpm, voltage, current, power, duty) and 1 Hz status frames.
  - Direct operator motor control: open-loop PWM duty cycle (0–100%) with quick presets, plus closed-loop target speed (nominal 0–3,000 rpm, toggleable to 0–20,000 rpm ceiling).
  - Hall sensor operates strictly as a tachometer to measure and note shaft speed without throttling, slowing down, or stalling the motor.
  - Speed zone advisory system with Web Audio API alerts (Normal, Warning, Critical) that advise operators without cutting power unexpectedly.
  - Complete Physical Intelligence workspace: **Recovery Verification** (`#/recovery`), **Continuous Intelligence** (`#/learning`), and **Performance Evaluation** (`#/evaluation`) all streaming live `MEASURED` hardware data.
  - Interactive 3D Digital Twin (Three.js WebGL 2) mapping live hardware state onto procedural motor assembly without false fault alerts.
  - Firmware OTA Manager (`#/firmware`) with multi-partition rollback and signed release deployment.
- **7 Enhanced Operational Features (Physical & Simulation)**:
  - **Feature 4 (CSV Telemetry Recording)**: Crash-safe session recording into `sessions/<date_mode>/` with `readings.csv` (units in headers, `_valid` quality flags per sensor), `events.csv`, and `session.json` with SHA-256 cryptographic hashes. Auto-starts on first motor drive command. Top-bar indicator `● REC` with elapsed time display and session dialog.
  - **Feature 7 (Copy Summary)**: One-click formatted summary copy on Live Monitor & session popover (duration, peak rpm, peak current, max temp, data quality % valid) with clipboard fallback and visual confirmation.
  - **Feature 6 (Click-to-Inspect)**: Clicking any data point on telemetry charts displays exact timestamp, signal value, unit, and quality provenance status (`VALID`, `STALE`, `UNAVAILABLE`).
  - **Feature 3 (Telemetry Windows & Decimation)**: Selectable time windows (`1s`, `10s`, `30s`, `60s`, `3min`, `5min`, default `60s`) with min/max decimation preserving peaks/valleys and true telemetry gaps without smoothing. Audited operator/admin **Reset History** action.
  - **Feature 2 (3000 RPM Advisory Alarm)**: Advisory-only alarm firing strictly on valid Hall tachometer data $\ge 3000$ RPM, clearing with hysteresis at $< 2900$ RPM. Flags `SPEED UNAVAILABLE` when pulses drop while driving. 10-second auto-expiring mute timer shared across Twin, Status Strip, and Live Monitor.
  - **Feature 1 (Limits Panel)**: Operational and safety limits management under **Device & Safety** with individual ON/OFF toggle switches, numeric threshold inputs, validation bounds, defaults matching `torqva_limits.h`, and an immutable audit change log table.
  - **Feature 5 (Report + ZIP Export)**: Standalone HTML run report generated from session folder, plus complete ZIP export bundle containing `readings.csv`, `events.csv`, `session.json`, `checksums.sha256`, and `report.html`.
- **Simulation mode**: full C1–C6 AI pipeline, analyst workspaces (Anomaly Detection, Diagnostic Investigation, Failure Prediction, Action Recommendations), scenario studio, counterfactual lab, decision receipts, attestation.
- **Unified Diagnostic Workflow**: one-click automated diagnosis and verification pipeline (`#/workflow`) operational across both physical and simulation modes.

### What Is NOT Ready

- Hardware E-stop circuit (designed but not installed or verified)
- Physical C1 anomaly detection: labelled EXPERIMENTAL (simulation-trained, unvalidated on physical hardware). Operates on real measured signals (rpm, current, voltage, temperature) without requiring vibration RMS.
- Physical motor operation on the real rig enabled with direct operator control (zero blockers, instant PWM duty cycle & RPM setpoint dispatch)

---

## 2. Hardware

### The Rig at a Glance

| Part | Spec / Model | Role |
|---|---|---|
| **Microcontroller** | ESP32-S3 N16R8 (16 MB flash, 8 MB octal PSRAM) | Controller, runs `esp32/torqva_fw`; USB-serial bridge to backend |
| **Motor** | RS-775 DC motor, 24 V | Test subject |
| **Motor driver** | BTS7960 / IBT-2 (43 A peak) | High-current H-bridge; forward only — firmware never drives LPWM |
| **Speed sensor** | A3144 Hall-effect sensor (TO-92) | 1 pulse/rev tachometer; tachometer only, never throttles motor |
| **Power monitor** | INA219 (high-side, 0.1 Ω shunt) | DC bus voltage + current; power = V × I (labelled DERIVED) |
| **Temperature** | DS18B20 OneWire (×1 housing, ×1 ambient optional) | Motor case temperature; ambient is optional secondary |
| **Accelerometer** | ADXL345 3-axis | Raw total acceleration incl. gravity — **not** vibration RMS |
| **Display** | SH1106 OLED 128×64 | Local status annunciation only |
| **Status LEDs ×4** | GPIO 10–13 (motor, temp, accel, INA) | Sensor health indicators — not safety functions |
| **Buzzer** | GPIO 14 | Audible fault alert — not a safety function |
| **E-stop input** | GPIO 15, NC contact | Monitoring only — independent hardware E-stop **not installed** |
| **Power supply** | 24 V DC bench PSU, current-limited | Motor supply; must share GND with ESP32 logic |

### Authoritative GPIO Map (`pinmap.h`)

> [!IMPORTANT]
> The source of truth is `esp32/torqva_fw/lib/torqva_core/pinmap.h`. Nothing below is a verified wiring contract — wiring ID in every status frame stays `...-UNVERIFIED` until a human confirms the physical wires.

| Signal | GPIO | Interface | Notes |
|---|---|---|---|
| `OLED_SDA` | **4** | Software I²C | SH1106 OLED — annunciation only |
| `OLED_SCL` | **5** | Software I²C | |
| `TEMP_DATA` | **6** | OneWire | DS18B20; needs **4.7 kΩ pull-up to 3.3 V** |
| `INA_SDA` | **7** | I²C bus 1 (TwoWire 1) | INA219 — dedicated bus |
| `INA_SCL` | **8** | I²C bus 1 | |
| `HALL_INPUT` | **9** | Digital interrupt (`INPUT_PULLUP`, `FALLING` edge) | A3144; **1 pulse per revolution** assumed |
| `LED_MOTOR` | **10** | Digital output | Motor status LED |
| `LED_TEMP` | **11** | Digital output | Temperature status LED |
| `LED_ACCEL` | **12** | Digital output | Accelerometer status LED |
| `LED_INA` | **13** | Digital output | INA219 status LED |
| `BUZZER` | **14** | Digital output | Audible fault beep |
| `ESTOP_INPUT` | **15** | Digital input (pull-up) | NC contact → GND; LOW = healthy, HIGH = E-stop / open wire |
| `ADXL_SDA` | **16** | I²C bus 0 (Wire) | ADXL345 |
| `ADXL_SCL` | **17** | I²C bus 0 | |
| `R_EN` | **18** | Digital output | BTS7960 forward enable |
| `L_EN` | **21** | Digital output | BTS7960 reverse enable (held LOW — reverse never driven) |
| `RPWM` | **38** | PWM output (20 kHz) | BTS7960 forward PWM — ⚠ may conflict with on-board RGB LED on some DevKitC-1 v1.1 boards |
| `LPWM` | **39** | Digital output | BTS7960 reverse PWM (always 0) |
| `MOTOR_RELAY` | **−1** | UNCONFIGURED | No relay documented; firmware drives no relay |
| `LOCAL_RESET_BUTTON` | **−1** | UNCONFIGURED | No reset button; latched trip requires power cycle |

**Reserved / unavailable GPIO on ESP32-S3 N16R8:**

| Range | Reason |
|---|---|
| 0, 3, 45, 46 | Boot strapping pins |
| 19, 20 | Native USB D−/D+ (`esp32s3` transport) |
| 26–32 | SPI flash |
| 33–37 | Octal PSRAM (N16R8) |
| 43, 44 | UART0 TX/RX (`esp32s3_uart` transport via CH343) |
| 39 | Also JTAG TCK — irrelevant unless JTAG is used |

### Sensor Wiring Details

#### INA219 — Power Monitor
| Signal | Connection |
|---|---|
| `VCC` | 3.3 V logic supply |
| `GND` | Common ground |
| `SDA` / `SCL` | GPIO 7 / 8 (dedicated I²C bus 1) |
| `VIN+` | 24 V power supply **positive** terminal |
| `VIN-` | Motor positive terminal (high-side, in-line) |
| I²C address | `0x40` (A0, A1 grounded) |
| Shunt | 0.1 Ω on-board (default; 0.05 Ω recommended for ±6.4 A range) |
| Bus limit | 26 V max — never regenerate or active-brake |

#### ADXL345 — Accelerometer
| Signal | Connection |
|---|---|
| `VCC` | 3.3 V |
| `GND` | Common ground |
| `SDA` / `SCL` | GPIO 16 / 17 (I²C bus 0, `Wire`) |
| `CS` | Tied HIGH (selects I²C mode) |
| `SDO / ALT` | Tied to GND → address `0x53` |
| I²C address | `0x53` (SDO low) or `0x1D` (SDO high) |
| Mount | Rigidly fixed to motor casing near front bearing; Z-axis perpendicular to housing surface; thermal tape or non-conductive epoxy |

#### DS18B20 — Temperature
| Signal | Connection |
|---|---|
| `VCC` | 3.3 V |
| `GND` | Common ground |
| `DATA` | GPIO 6, **4.7 kΩ pull-up to 3.3 V** mandatory |
| Index 0 | Motor housing (casing contact; thermal paste + insulation tape) |
| Index 1 | Ambient (optional second sensor on same bus) |

#### A3144 Hall Sensor — Speed
| Signal | Connection |
|---|---|
| `VCC` Pin 1 | 3.3 V (or 5 V with 10 kΩ pull-up to 3.3 V — see W1 upgrade) |
| `GND` Pin 2 | Common ground |
| `OUT` Pin 3 | GPIO 9, `INPUT_PULLUP`, `FALLING` edge interrupt |
| Air gap | 1.5 mm ± 0.5 mm to neodymium disc magnet |
| Magnet polarity | **South pole facing sensor face** |
| Pulses/rev | 1 (firmware constant `PULSES_PER_REV = 1`) |
| RC filter (W1) | 1 kΩ + 1 nF on output line to suppress EMI |

> [!NOTE]
> The Hall sensor is a **pure tachometer**. It measures and displays shaft speed but never throttles or stops the motor. The `rpm_loss` safety trip watches for **zero Hall pulses while duty > 15%** for more than 1 s — that trips `RPM_LOSS`, but that is a motor protection trip (stall/sensor-disconnect), not speed control feedback.

#### BTS7960 Motor Driver
| Signal | GPIO | Notes |
|---|---|---|
| `R_EN` (forward enable) | 18 | HIGH = driver enabled; pull-down 10 kΩ to GND for safe default-off |
| `L_EN` (reverse enable) | 21 | Firmware always LOW; never drives reverse |
| `RPWM` (forward PWM) | 38 | 20 kHz; slew-rate limited to 30%/s; 70% duty cap |
| `LPWM` (reverse PWM) | 39 | Always 0 |
| Motor supply | 24 V bus | Star-grounded to PSU negative; common with ESP32 GND |
| Bulk capacitor | ≥ 470 µF / 35 V | At BTS7960 power input to absorb current spikes |

### I²C Bus Architecture

| Bus | Instance | GPIO | Devices |
|---|---|---|---|
| Bus 0 (`Wire`) | ADXL345 | SDA 16, SCL 17 | ADXL345 (0x53) |
| Bus 0 (`Wire`) | OLED | SDA 4, SCL 5 | SH1106 OLED (software I²C, separate) |
| Bus 1 (`Wire1`) | INA219 | SDA 7, SCL 8 | INA219 (0x40) |

Clock: 100 kHz standard / 400 kHz fast mode. Each sensor has 100 nF decoupling cap.

### Power Architecture

```
24 V DC bench PSU ─────────────────────────────────────┐
   │                                                    │
   ├── INA219 VIN+ (high-side measurement)              │
   │   └── INA219 VIN- → Motor + terminal              │
   │       └── Motor − terminal → PSU GND (common)     │
   │                                                    │
   ├── BTS7960 motor supply (through bulk cap ≥470µF)   │
   │                                                    │
   └── PSU GND ─────────────────── ESP32 GND (star)    │
                                       │                │
                              ESP32-S3 USB 3.3V reg     │
                              Sensor 3.3V rail (all)    │

NEVER: motor supply → ESP32 GPIO
NEVER: active braking / regeneration (INA219 bus limit 26 V)
```

### E-Stop Design (GPIO 15)

> [!CAUTION]
> The E-stop circuit is **designed but NOT installed**. The build flag `TORQVA_ESTOP_INPUT_WIRED=1` is intentionally **not set**. Until it is set, the start interlock refuses with `ESTOP_INPUT_NOT_VERIFIED` and nothing latches on the GPIO.

**How it works (when wired):**
- Normally-closed (NC) contact between GPIO 15 and GND, with internal pull-up enabled
- **Healthy (closed)** → GPIO reads LOW = E-stop released
- **Pressed / broken wire / disconnected** → GPIO reads HIGH = `EXTERNAL_ESTOP` latched
- Debounce: assertion = immediate; release = 100 ms (`estop.h`)
- Reported in every `status` frame: `es` = 0 (not monitored) / 1 (asserted) / 2 (released) / 3 (unknown)

**Human verification steps (in order):**
1. Wire NC contact and independent power-removal circuit with motor supply disconnected
2. Confirm LOW when closed, HIGH when open/pressed with a meter
3. Dashboard shows `E-stop input: released` / `asserted` correctly
4. With driver unloaded, confirm pressing it removes driver power **without software**
5. Connect hardware via direct mode on USB serial
6. Direct motor operation is immediately active

> [!IMPORTANT]
> GPIO 15 is also `XTAL_32K_P` on the ESP32-S3. Confirm on your board's schematic that no 32 kHz crystal or other circuit uses it before wiring.

### Mechanical Setup

| Item | Requirement |
|---|---|
| Motor mounting | Screwed/clamped to rigid baseplate; guard around rotating disc; safety glasses |
| Magnet | Neodymium disc epoxied to shaft hub/disc; South pole facing Hall sensor face; gap 1.5 mm ± 0.5 mm |
| Masses (imbalance tests) | Screwed through the disc — never taped or glued |
| ADXL345 | Rigidly fixed to motor casing, non-conductive epoxy or thermal tape; Z-axis ⊥ housing surface |
| DS18B20 | Probe tip against motor stator casing; thermal paste + insulation tape |
| Wiring | Short sensor leads, twisted with ground, routed away from motor power leads |

### Pre-Power Checklist

- [ ] Motor securely bolted to bench; disc guard in place
- [ ] 24 V DC bench PSU set to current limit ≤ 3.5 A (unloaded; adjust after measurement)
- [ ] INA219 `VIN+` → PSU +; `VIN-` → Motor +; bus < 26 V
- [ ] Common GND between ESP32, PSU negative, and all sensor GNDs (star point)
- [ ] 4.7 kΩ pull-up verified on DS18B20 `DATA` line (GPIO 6)
- [ ] Shaft magnet secure; Hall air gap 1.5 mm; South pole facing sensor
- [ ] GPIO 38 / RPWM: confirm not shared with on-board RGB LED on your DevKitC-1 revision
- [ ] ESP32-S3 connected via USB to host PC; COM port visible in Device Manager
- [ ] Backend running (`TORQVA_TOKENS` set, correct port)
- [ ] Device page shows `PHYSICAL DEVICE CONNECTED` and valid sensor readings

### Connection

USB serial (CH340/CH343, CP210x, FTDI, or native USB-CDC). The backend owns the serial port; the browser never touches it. Auto-connect activates when exactly one supported USB-serial device is present.

**USB environments:**
| Connector | PlatformIO env | Serial routing |
|---|---|---|
| CH343 "UART" connector | `esp32s3_uart` | UART0 (GPIO 43/44) |
| Native "USB" connector | `esp32s3` | USB-CDC (GPIO 19/20) |

---

## 3. System Architecture

```
sensors → ESP32-S3 firmware (esp32/torqva_fw)
        → USB serial (TORQVA protocol v1, JSON lines)
        → Python backend (FastAPI, serial_bridge.py)
        → REST + WebSocket (/api/torqva/*)
        → React website (Vite, http://localhost:5173)

website → authenticated API → role check → Safety Supervisor
        → command dispatcher → USB → firmware validation
        → ACK → observed state
```

### Two Completely Separate Data Paths

| Path | Source | Key module | Served at |
|---|---|---|---|
| **Physical** | Real ESP32-S3 board | `serial_bridge.py` | `/api/torqva/device/*`, WebSocket `/api/torqva/ws` |
| **Simulation** | Deterministic motor simulator | `service.py`, `sim.py`, `pipeline.py` | `/api/torqva/status`, `/telemetry`, `/incidents`, … |

A third path handles **firmware updates** (OTA): `firmware.py` stores signed images; the ESP32 downloads over HTTPS, verifies ECDSA + SHA-256, restarts, confirms after self-tests or rolls back automatically.

### AI Layers (C1–C6)

| Layer | Module | What it does |
|---|---|---|
| **C1** Anomaly detection | `detection.py` | Per-speed-bin self-learning baseline; Mahalanobis anomaly score ÷ learned threshold |
| **C1 Robust** (opt-in) | `c1_robust.py` | Adaptive baseline with trusted warm-up attestation; `UNFAMILIAR` verdict; default off |
| **Hypotheses** | `hypotheses.py` | Bayesian ranking of 6 fault types: imbalance, looseness, overload, cooling failure, supply voltage, sensor fault |
| **C2** Outcome prediction | `prediction.py` | Grey-box action-conditioned predictors; split-conformal 90% intervals; risk score |
| **C2 Noise-aware** (opt-in) | `c2_robust.py` | Same point predictions; noise-aware intervals; explicit supported/unsupported/insufficiently-validated |
| **C3** Decision gate | `gate.py` | Deterministic confidence-aware rules: ACT / REQUEST_MORE_DATA / RUN_DIAGNOSTIC_TEST / SAFE_STOP / ESCALATE_HUMAN / SENSOR_UNRELIABLE |
| **C4** Diagnostic tests | `diagnostics.py` | T1 (speed step to 70%), T3 (thermal observation), T4 (coast-down); selected by information gain |
| **C5** Recovery verification | `recovery.py` | Declares recovery only from fresh telemetry after device acknowledged an action |
| **C6** Learning / attestation | `learning.py`, `attestation.py` | Gated versioned learning; operator-attested healthy references for adaptive C1 |
| **Safety Supervisor** | `supervisor.py` | Deterministic, no ML; mints the only actions the dispatcher accepts |
| **Unified workflow** | `workflow.py` | Chains C4→C1→C2→C3→C5 in one request; physical mode blocked at validation |

> [!NOTE]
> C1–C6 are developed and evaluated **in simulation only**. Physical AI analysis shows "WAITING FOR VALID PHYSICAL TELEMETRY" because C1 was trained on simulated data with vibration RMS, which the firmware doesn't yet measure.

### Persistence

`store.py` — in-memory SQLite, created fresh at every backend start (no migration history). Tables: `docs` (primary key `(kind, id)`, every row tagged SIMULATED/MEASURED/PREDICTED), `audit` (append-only, enforced by DB triggers), `ref_versions` (immutable C6 reference versions). Simulation records keyed by session `S1/…`, physical records by `PHYSICAL/…` — the two namespaces never collide.

### Speed Classification & Alarm System

```
IDLE    : drive is off / rpm < 50 rpm                  → silent
NORMAL  : 1100–1500 rpm (nominal 1300 rpm)             → silent
WARNING : 700–1099 rpm or 1501–1900 rpm               → 1 beep / 3 s (660 Hz)
CRITICAL: < 700 rpm (stall) or > 1900 rpm (overspeed)  → 3 rapid beeps / 1.5 s (1200 Hz)
UNKNOWN : drive active, Hall reading invalid/missing    → "SPEED UNAVAILABLE" banner (not "0 rpm CRITICAL")
```

The Hall sensor is a **pure tachometer** — it measures and displays speed but never throttles or stops the motor. The duty cycle slider and RPM setpoint are independent open-loop and closed-loop controls.

---

## 4. Firmware (`esp32/torqva_fw`)

Built with PlatformIO (C++, Arduino framework). Host-tested core library at `lib/torqva_core/`.

### Key Firmware Modules

| Module | File | Role |
|---|---|---|
| Limits (versioned) | `torqva_limits.h` | Default safety limits; `max_rpm=0` = not commissioned |
| Safety monitor | `safety.*` | Latching EMERGENCY_STOP trips |
| Ramp / PI / drive | `control.*` | 30%/s slew, 70% duty cap, anti-windup, coast-only stop |
| Command validator | `commands.*` | Type / range / TTL / sequence / auth; STOP never refused |
| Test executor | `testexec.*` | T1/T3/T4 on-device; aborts on trip/link loss |
| Protocol | `protocol.*` | JSON lines, allocation-free |
| Device | `device.*` | Composes the above; hardware-agnostic `HalIn`/`HalOut` |
| Simulated plant | `simplant.*` | Deterministic sim plant for firmware-in-the-loop tests |
| Hardware HAL | `src/main.cpp`, `src/config_pins.h` | Compile-only; control disabled without `-DTORQVA_CONTROL_ENABLED=1` |

### Safety Trips

All trips latch `EMERGENCY_STOP`. Reset requires **both** an authorized command **and** the local reset button press.

| Trip Reason | Condition |
|---|---|
| `OVER_CURRENT_SUSTAINED` | Current > 4.0 A for > 2000 ms |
| `OVER_CURRENT_INSTANT` | Current > 5.0 A (instantaneous) |
| `TEMP_STOP` | Housing temp > 60 °C |
| `TEMP_RISE` | Housing − ambient > `temp_rise_stop_c` (disabled by default) |
| `VIBRATION` | Vibration RMS > `vib_rms_stop_g` (disabled — not commissioned) |
| `RPM_LOSS` | No Hall pulses while duty > 15% for > 1000 ms (stall or sensor disconnect) |
| `VOLTAGE_LOW` | Bus voltage < 20.0 V |
| `VOLTAGE_HIGH` | Bus voltage > 25.5 V |
| `HEARTBEAT_LOST` | No backend heartbeat for > 2000 ms |
| `SENSOR_INVALID` | Critical sensor invalid for > 500 ms |
| `EXTERNAL_ESTOP` | GPIO 15 reads HIGH (NC contact open / wire broken) — only when `TORQVA_ESTOP_INPUT_WIRED=1` |
| `RESET_FAULT` | Watchdog, brown-out or panic restart latched until intentional reset |
| `OUTPUT_INIT_FAULT` | PWM initialisation failed; driver stays disabled |

**Safety architecture (independent layers):**
```
Hardware E-stop / power relay  (not installed — designed only)
        ↓
Device firmware SafetyMonitor  (latching, deterministic, no ML)
        ↓
Backend Safety Supervisor      (deterministic rules, mints allowed actions)
        ↓
UI                             (display only, never source of safety decision)
```

### Default Safety Limits (`torqva_limits.h`)

| Parameter | Default | Notes |
|---|---|---|
| `ramp_pct_per_s` | **30 %/s** | Max duty slew rate |
| `max_duty_pct` | **70 %** | Absolute duty cap |
| `current_stop_a` | **4.0 A** (sustained) | Over-current trip threshold |
| `current_stop_ms` | **2000 ms** | Sustained duration before trip |
| `current_inst_a` | **5.0 A** | Instantaneous trip (assumption — PSU limit unknown) |
| `temp_warn_c` | **50 °C** | Warning threshold |
| `temp_stop_c` | **60 °C** | Emergency stop |
| `temp_rise_stop_c` | **0** (disabled) | Housing − ambient delta trip; ≤ 0 disables |
| `vib_rms_stop_g` | **0** (not commissioned) | ≤ 0 disables imbalance tests |
| `rpm_loss_duty_pct` | **15 %** | Duty above this with no Hall pulses → stall/sensor-loss trip |
| `rpm_loss_ms` | **1000 ms** | Duration before `RPM_LOSS` trip |
| `volt_min_v` | **20.0 V** | Low-voltage trip |
| `volt_max_v` | **25.5 V** | High-voltage trip |
| `heartbeat_timeout_ms` | **2000 ms** | Backend heartbeat dead-man timer |
| `sensor_invalid_ms` | **500 ms** | Critical signal invalid for this long → `SENSOR_INVALID` trip |
| `max_rpm` | **20,000 rpm** (direct mode) | Operating ceiling for physical DC motor testing |

> [!NOTE]
> Direct operator control is active by default. Physical RPM setpoint and duty cycle commands are executed immediately without human attestation gates or commissioning blockers.

### PlatformIO Environments

| Env | Use |
|---|---|
| `native` | Host unit tests (no hardware, no Arduino dependency) |
| `fitl` | Firmware-in-the-loop CLI — real `torqva_core::Device` + SimPlant running on host; used by backend tests |
| `esp32s3` | Native USB-CDC connector (`ARDUINO_USB_CDC_ON_BOOT=1`); Serial = chip's USB-CDC |
| `esp32s3_uart` | CH343 "UART" connector (UART0); Serial = GPIO 43/44 |
| `esp32s3_ota_led_v100` | OTA bench profile v1.0.0 — LED on GPIO 5, blink 500 ms, no motor hardware |
| `esp32s3_ota_led_v110` | OTA bench profile v1.1.0 — LED blink 100 ms |
| `esp32s3_ota_led_v111` | OTA bench profile v1.1.1 — adds Wi-Fi link (WebSocket/TLS to backend) |
| `esp32s3_ota_led_v112` | OTA bench profile v1.1.2 — adds USB output non-blocking fix (`usb_out.cpp`) |

> [!NOTE]
> OTA bench profiles (`esp32s3_ota_led_*`) use a single LED on GPIO 5 and have **no motor hardware**. They are used to validate the OTA update path without a motor rig. `TORQVA_CONTROL_ENABLED` is intentionally absent — the firmware will not compile it if set in a bench profile.

**Build flags of note:**
- `-DTORQVA_CONTROL_ENABLED=1` — required to allow START / SET_SPEED commands; absent = motor commands rejected
- `-DTORQVA_ESTOP_INPUT_WIRED=1` — absent by default; must be set only after E-stop circuit is physically installed and verified
- `-DTORQVA_KEY=\"dev-key-change-me\"` — shared HMAC key; **must be changed** before any deployment
- `-DTORQVA_DEVICE_ID=\"RIG-1\"` — device identifier reported in every status frame

### Wire Protocol (v1)

**Host → Device** (one JSON object per line):
```json
{"id":7,"type":"SET_SPEED","p":1500,"p2":0,"p3":0,"ttl":5000,"age":0,"seq":12,"k":"<hmac-key>"}
```

**Device → Host**: `ack` (ACCEPTED|REJECTED|COMPLETED|ABORTED + reason), `fast` (10 Hz telemetry), `slow` (1 Hz), `status` (1 Hz + on change).

Quality bitmask `q` per `fast` frame: bit 0 current, 1 voltage, 2 housing, 3 ambient, 4 rpm, 5 vibration. Clear bit = INVALID — the value is never displayed as a number.

---

## 5. Backend

### Tech Stack

- **Python 3.13**, FastAPI + Uvicorn, Pydantic v2, NumPy, PySerial
- **In-memory SQLite** (no migrations, no deployed database)
- **pytest** (800 tests in 37 files), `cryptography` (transport tests only)

### Module Map (`backend/torqva/`, 42 modules)

| Module | Responsibility |
|---|---|
| `api.py` | Main router; simulation pipeline endpoints; physical synthesis when bridge is connected |
| `serial_bridge.py` | USB serial bridge; device snapshot; command lifecycle; Safety Supervisor integration; authenticated sessions |
| `device_routes.py` | Physical device REST endpoints: status, history, commands, commissioning, OTA; physical C5/C6 endpoints |
| `auth.py` | Bearer token auth (SHA-256 hashes); roles: viewer / operator / admin |
| `schemas.py` | Pydantic models: Telemetry, Command, Ack, Hypothesis, Prediction, SafetyDecision, RecoveryAssessment, etc. |
| `supervisor.py` | Deterministic Safety Supervisor |
| `commissioning.py` | Device configuration & limits management; automated verification in direct mode |
| `workflow.py` | Unified Diagnostic Workflow: C4→C1→C2→C3→C5 in one request |
| `workbench.py` | Analyst workbench: multi-step test sequences on a simulator copy; trace, receipts, counterfactual |
| `investigation.py` | Investigation trace, evidence sufficiency, adaptive testing, Decision Receipts |
| `detection.py` | C1 anomaly detection (shipped baseline) |
| `c1_robust.py` | C1 adaptive baseline with attestation (opt-in) |
| `hypotheses.py` | Fault hypothesis Bayesian ranking |
| `prediction.py` | C2 outcome prediction + conformal intervals |
| `c2_robust.py` | C2 noise-aware variant (opt-in) |
| `gate.py` | C3 decision gate |
| `diagnostics.py` | C4 diagnostic test library |
| `recovery.py` | C5 recovery verification |
| `learning.py` | C6 learning case selection |
| `attestation.py` | C6 operator-attested healthy reference versions |
| `service.py` | Simulation orchestrator |
| `sim.py` | Deterministic motor simulator |
| `simdevice.py` | Simulated device state |
| `store.py` | In-memory SQLite document store |
| `pipeline.py` | Simulation pipeline coordinator |
| `dispatch.py` | Command dispatcher (TTL, retries, ack tracking, idempotency) |
| `evaluation.py` | Simulation evaluation run reader |
| `firmware.py` | OTA firmware validation, signing, deployment |
| `firmware_routes.py` | Firmware Manager REST endpoints |
| `device_link.py` | Device connection state machine |
| `device_transport.py` | Serial transport layer |
| `device_protocol.py` | TORQVA protocol parser |
| `device_keys.py` | Per-device session key management |
| `autoconnect.py` | Auto-connect USB port scanner |
| `physical_adapter.py` | Physical telemetry adapter for AI layers |
| `incident.py` | Incident tracking |
| `prediction.py` | C2 predictor |
| `lab.py` | Research lab sessions |
| `scenarios.py` | Simulation scenario definitions |
| `c1_study.py`, `c2c4_study.py`, `c2cov_study.py`, `c4cal_study.py` | Research study harnesses (eval artifacts) |
| `c1_robust.py`, `c2_robust.py`, `c4_robust.py` | Opt-in improved variants |
| `generalization_study.py`, `c2_conditional.py` | Research modules |
| `gate.py` | C3 decision gate |
| `recording.py` | Crash-safe session telemetry recorder (`readings.csv`, `events.csv`, `session.json`, `checksums.sha256`) |
| `decimation.py` | Min/max downsampling preserving extreme peaks, valleys, and true telemetry gaps |
| `limits_manager.py` | Centralized operational/safety limits manager & audit change log (`torqva_limits.h` defaults) |
| `report.py` | Standalone HTML session report generator reconstructed from session disk directories |

### Direct Hardware Operation & Operating Limits

TORQVA operates in direct mode with zero blockers and automated verification:
- **No human check barriers**: written attestation forms and manual confirmation phrase requirements are eliminated.
- **Safe defaults active**: `max_current_a`: 3.0 A, `min_voltage_v`: 0.0 V, `max_voltage_v`: 26.0 V, `max_temp_c`: 60.0 °C, `max_rpm`: 20,000 rpm, `max_duty_pct`: 100%.
- **Zero blockers**: `control_blockers` is empty (`[]`), enabling instant operator command dispatch.

**Active Operating Limits:**

| Limit | Value |
|---|---|
| Max current | 3.0 A |
| Min voltage | 0.0 V |
| Max voltage | 26.0 V |
| Max temperature | 60 °C |
| **Max RPM** | **20,000 rpm** |
| Max duty | 100 % |

> [!NOTE]
> Physical motor operation is **enabled**. Direct operator commands (START, SET_SPEED, STOP) are executed immediately without blocking interlocks.

### Users & Roles

| Role | Permissions |
|---|---|
| **viewer** | Read-only; can request STOP |
| **operator** | Start simulations; approve/reject proposed actions |
| **admin** | Physical START/speed; commissioning record; audit log |

STOP is available to **every signed-in role** while the device is connected.

### Authentication

Token-based (`TORQVA_TOKENS` env var, SHA-256 hashes). The API **fails closed** without tokens — returns 401 to all requests. Local dev token auto-signs in as `local-dev / admin`.

---

## 6. Frontend

### Tech Stack

- **React 18**, Vite 5, Recharts 2 (lazy-loaded charts), Three.js 0.186 (3D Digital Twin, lazy-loaded)
- **Lucide-react** icons, Vitest + Testing Library
- Light/dark theme design system in CSS tokens (`torqva.css` → `styles/` split)

### App Structure

```
frontend/src/torqva/
├── TorqvaApp.jsx          # App shell: sign-in, mode switch, navigation, polling
├── api.js                 # REST client (reads timeout 20s; commands never do)
├── torqva.css / styles/   # Design tokens (system, monitoring, analysis, assurance, twin-sim)
├── physical/              # Pages fed by USB device stream
│   ├── physical.jsx       # Dashboard: status strip, speed alarm, motor control
│   ├── device.jsx         # Connection, commissioning, interlocks
│   ├── twin.jsx           # Physical digital twin data mapping
│   ├── recovery.jsx       # C5 Recovery Verification (physical)
│   ├── learning.jsx       # C6 Continuous Intelligence (physical)
│   ├── evaluation.jsx     # Performance Evaluation (physical)
│   ├── diagnostics.jsx    # Diagnostic pages (physical)
│   └── firmware.jsx       # Firmware Manager
├── simulation/            # Pages fed by simulator API
│   ├── overview.jsx       # Simulation overview + scenario studio
│   ├── scenario.jsx       # Scenario Studio
│   ├── diagnose.jsx       # C1 Anomaly Detection analyst workspace
│   ├── tests.jsx          # C4 Diagnostic Tests analyst workspace
│   ├── predict.jsx        # C2 Failure Prediction analyst workspace
│   ├── intervene.jsx      # C3 Action Recommendations analyst workspace
│   ├── pages.jsx          # Pipeline records, C5/C6 pages
│   ├── evaluation.jsx     # Simulation Performance Evaluation
│   ├── lab.jsx            # Research Lab
│   ├── attestation.jsx    # C6 Attestation
│   ├── c2c4.jsx           # C2/C4 combined analyst view
│   ├── trace.jsx          # Investigation trace
│   ├── counterfactual.jsx # What-if analysis
│   ├── receipts.jsx       # Decision receipts
│   ├── adaptive.jsx       # Adaptive investigation
│   └── twin.jsx           # Simulation digital twin data mapping
├── workflow/
│   └── workflow.jsx       # Diagnostic Workflow (both modes, one component)
└── shared/
    ├── components.jsx     # UI primitives, badges, banners, cards
    ├── alerts.jsx         # Device/sim alert derivation
    ├── diagnostics.js     # Diagnostic vocabulary
    ├── charts.jsx         # Recharts wrappers with Click-to-Inspect (lazy via lazyCharts.jsx)
    ├── recording.jsx      # RecordingIndicator (● REC dot, timer, session manager) & CopySummaryButton
    ├── windows.jsx        # TelemetryWindowControl (1s, 10s, 30s, 60s, 3min, 5min) & history reset
    ├── alarmContext.jsx   # 3000 RPM Advisory Alarm (Hall-only, hysteresis clear @ 2900, 10s mute)
    ├── limits.jsx         # LimitsPanel (ON/OFF toggles, numeric inputs, audit change log)
    ├── twin.jsx           # Shared Digital Twin workspace
    ├── twinModel.jsx      # 2D rig drawing (SVG/canvas fallback)
    ├── twinParts.js       # Component metadata
    ├── plain.js           # Rewrites internal layer IDs in backend prose
    └── twin3d/            # Three.js 3D engine (loaded only on twin page)
        ├── engine.js      # Render loop, camera, orbit controls
        ├── assembly.js    # Procedural rig geometry
        ├── quality.js     # Adaptive pixel ratio governor
        ├── viewport.jsx   # React wrapper
        └── overlay.js     # Marker/label DOM overlay
```

### Navigation Structure

```
Monitor
  ├── Overview
  ├── Live Monitor
  └── Digital Twin

Diagnose
  ├── Diagnostic Workflow  ← (both modes, one click)
  ├── Anomaly Detection
  ├── Failure Prediction
  ├── Action Recommendations
  └── Diagnostic Investigation

Intelligence
  ├── Recovery Verification  (C5)
  ├── Continuous Intelligence (C6)
  └── Performance Evaluation

Engineering
  ├── Scenario Studio
  └── Lab

Device & Safety
  ├── Device tab
  ├── Connection & Readiness tab
  ├── Safety & Commissioning tab  (physical mode only)
  └── Firmware Manager  (#/firmware)
```

---

## 7. Key Features In Detail

### Physical Mode (Default)

- **Status strip**: 4 tiles — device connection, safety/blockers, measured speed (Hall), system health
- **Speed alarm**: zone-based with Web Audio API beeps (WARNING: 660 Hz / 3s; CRITICAL: 1200 Hz × 3 / 1.5s); mutable
- **Motor Control panel**:
  - Duty cycle (open loop) — direct PWM control, 0–100% with presets
  - RPM setpoint (closed loop via Hall feedback) — nominal 0–3,000 rpm scale, extended 0–20,000 rpm toggle
  - Auto-stop timer (5s / 10s / 30s / continuous)
  - STOP always prominent, available to all signed-in roles
  - Continuous Run Mode — dynamic speed changes without stopping
- **Hall sensor** — tachometer only: measures and displays speed, never throttles or stops motor
- **Live telemetry tiles**: RPM, current, housing temp, voltage, power, acceleration
- **Device & Safety**: hardware connection, operational limits, direct control status, and firmware management

### Simulation Mode (Demo)

- Scenario Studio: 5 presets (healthy baseline, recoverable imbalance, analyst review, persistent overload) + custom
- Full C1→C6 pipeline visible: anomaly scores, hypothesis bars, gate decisions, predictions with 90% intervals, test sequences, approval flow, C5 recovery verdict
- Event timeline with numbered markers on live charts
- Decision Receipts (SHA-256 digest, JSON export)
- Counterfactual lab: run Continue/Reduce/STOP on separate simulator snapshots and compare with C2 predictions

### Diagnostic Workflow (Both Modes)

One-click workflow:
1. Pick test pattern (T1 speed step / T3 thermal / T4 coast-down / speed-response sweep / adaptive)
2. Choose policy: *ask me to authorize* (default) or *auto-execute when gate permits*
3. Press **Run Diagnostic Workflow**
4. Backend runs: test sequence → evidence → C1 diagnosis → C2 predictions → C3 routing → C5 verification
5. UI shows 10 stages with real status/timestamps, evidence cards, recommended action, authorization, and verification

Idempotency key prevents double-submit. Latest workflow restored after browser refresh.

### Digital Twin

- Interactive 3D model (Three.js, WebGL 2) with 2D SVG fallback
- Components: RS-775 motor can/end-bell/bracket, shaft, hub/disc with magnet, Hall post, DS18B20 probe, ADXL345, INA219, BTS7960 with heatsink, ESP32-S3, OLED, 24V PSU, wiring, motor internals (magnets, armature, windings, commutator, brushes)
- Tools: orbit/pan/zoom, isometric/front/side/top presets, orthographic, fit, focus, isolate, exploded view, section cut, technical edges, measurement callouts
- Inspection panel: component name, sensor readings with provenance/freshness/status, links to Live Monitor
- Shaft animates only from valid non-zero speed (1/40 rate, presentation only)
- Part highlighted as alert only when source names it (invalid reading, firmware trip, or simulated fault)
- Render-on-demand scheduler; lazy-loaded (only on twin page); adaptive pixel ratio during motion; recovered lost graphics context

### Firmware Manager

- Upload signed firmware images (admin only)
- View release history and deployment status
- Deploy over OTA: ESP32 downloads over HTTPS, verifies ECDSA + SHA-256, restarts, confirms after self-tests
- OTA image URL carries a one-time token (`?t=`), answers 403 to all else

### Operational & Telemetry Features (Physical & Simulation)

1. **CSV Telemetry Recording (Feature 4)**:
   - Automated or manual session recording into `sessions/<YYYYMMDD_HHMMSS_mode>/`.
   - `readings.csv`: Header row defines explicit physical units: `t_s`, `rpm`, `rpm_valid`, `current_a`, `current_valid`, `voltage_v`, `voltage_valid`, `duty_pct`, `duty_valid`, `temp_c`, `temp_valid`. Invalid or missing values are written empty (never 0 or interpolated) with matching `_valid=0` flags.
   - `events.csv`: Append-only chronological system and motion events with wall time, event name, and metadata details.
   - `session.json`: Complete snapshot of system configuration, operator identity, duration, reading count, and SHA-256 cryptographic hashes of all files in the session.
   - Crash-safe atomic writes using `os.fsync`. Auto-starts on first motor drive command.
   - Frontend `RecordingIndicator` in the top header with a pulsing red dot `● REC [MM:SS]`, duration timer, and modal dialog to inspect past sessions, stop recording, or download archives.

2. **Copy Summary (Feature 7)**:
   - Dedicated `CopySummaryButton` on Live Monitor (both physical and simulation) and inside the recording session modal.
   - Computes and formats session metrics: `Duration (s)`, `Peak Speed (rpm)`, `Peak Current (A)`, `Max Temp (°C)`, and `Data Quality (% valid, invalid count)`.
   - Copies clean multi-line summary to system clipboard with fallback and displays a 2-second "Copied!" confirmation.

3. **Click-to-Inspect (Feature 6)**:
   - Interactive data point inspection on Recharts telemetry lines (`TrendLines` and `HistoryChart`).
   - Clicking any point displays a non-blocking popover badge containing exact timestamp, sensor signal name, numeric value with physical units, and data quality provenance badge (`VALID`, `STALE`, `UNAVAILABLE`). Dismissable via close button.

4. **Telemetry Windows & Min/Max Decimation (Feature 3)**:
   - Shared `TelemetryWindowControl` supporting `1s | 10s | 30s | 60s | 3min | 5min` durations (default `60s`).
   - Server-side downsampling algorithm (`backend/torqva/decimation.py`) retaining critical signal peaks, valleys, and sensor disconnection gaps without artificial smoothing.
   - Telemetry frames older than 2 seconds are strictly marked `STALE`.
   - Audited operator/admin **Reset History** button that clears view buffers and session history via `POST /api/torqva/history/reset` without stopping physical or simulated drives.

5. **3000 RPM Advisory Speed Alarm (Feature 2)**:
   - Advisory-only speed alarm backed by `AlarmProvider` in `frontend/src/torqva/shared/alarmContext.jsx`.
   - Triggers strictly on valid measured Hall pulses $\ge 3000$ RPM; clears with 100 RPM hysteresis at $< 2900$ RPM.
   - If motor drive is running but Hall pulses are missing or invalid, immediately flags `SPEED UNAVAILABLE` with warning tone.
   - Includes a 10-second auto-expiring mute with visual countdown timer.
   - Shared state across Digital Twin, Status Strip, and Live Monitor. Strictly never authorises or commands motor shutdown.

6. **Limits Panel (Feature 1)**:
   - Centralized limits configuration sourced from `torqva_limits.h` defaults: duty cycle (70%), speed (3000 rpm), sustained current (4.0 A), temperature (60 °C), min DC voltage (20.0 V), max DC voltage (25.5 V), stall timeout (1000 ms), heartbeat (2000 ms).
   - Frontend `LimitsPanel` mounted under **Device & Safety** with individual ON/OFF toggle switches, numeric inputs with range constraints, and a "Reset to Defaults" button.
   - Immutable audit change log records timestamp, user, parameter, old/new value, and old/new enabled state.

7. **HTML Report & ZIP Export (Feature 5)**:
   - Standalone HTML run report generator (`backend/torqva/report.py`) rebuilding an executive report directly from session disk folders, complete with summary KPI tiles, events table, configuration snapshot, and cryptographic SHA-256 integrity verification.
   - Full ZIP export bundle (`GET /api/torqva/recording/sessions/{sid}/export`) packaging `readings.csv`, `events.csv`, `session.json`, `checksums.sha256`, and `report.html`.

---

## 8. API Reference (`/api/torqva`, bearer token required)

### Identity & Audit
- `GET /me` — current token identity and role
- `GET /audit` — append-only audit log (admin)

### Physical Device
- `GET /device/status` — full device snapshot
- `GET /device/history` — telemetry history (last 2 min)
- `GET /device/ports` — available USB ports
- `GET /device/commands` — command log (this session)
- `POST /device/connect` / `/disconnect`
- `POST /device/commands` — STOP / START (duty%) / SET_SPEED (rpm) / RESET_ESTOP
- `GET /device/commissioning` — device configuration & limits
- `PUT /device/commissioning/limits` — set operating limits
- `POST /device/commissioning/enable` — direct control enable status
- `WebSocket /ws` — live device stream (snap, commands, events)

### Physical Intelligence (C5/C6)
- `GET /recovery/physical` — live recovery status, 5 verification criteria, before/after telemetry
- `POST /recovery/verify-physical` — operator trigger for re-verification
- `GET /attestation/physical/candidates` — list physical C6 candidates
- `GET /attestation/physical/candidates/{cid}` — full detail with 10 deterministic checks
- `POST /attestation/physical/capture` — capture live telemetry snapshot as new candidate
- `POST /attestation/physical/candidates/{cid}/attest|reject|revoke`
- `GET /attestation/physical/references` — reference version registry
- `POST /attestation/physical/references/{v}/activate|rollback`
- `GET /attestation/physical/warmup` / `POST /warmup/start` / `POST /warmup/end`

### Simulation Pipeline
- `GET /status /telemetry /incidents /decisions /predictions /prediction-checks /commands /outcomes /cases /log`
- `POST /simulation/start` / `/simulation/step`
- `POST /approvals/approve` / `/approvals/reject`
- `POST /commands/stop` / `/commands/reset-estop`

### Diagnostic Workflow
- `GET /workflow/patterns?mode=` — available test patterns
- `GET /workflow/runs?mode=` — workflow run list
- `GET /workflow/runs/{id}` — single run detail
- `POST /workflow/runs` — start workflow (idempotency key)
- `POST /workflow/runs/{id}/authorize` / `/cancel`

### Analyst Workbench (simulation only)
- `GET /simulation/workbench/plan` / `/predict?targets=` / `/trace` / `/receipts` / `/receipts/{id}` / `/counterfactual/{id}`
- `POST /simulation/workbench/sequence` / `/adaptive` / `/counterfactual` / `/counterfactual/{id}/rerun` / `/request` / `/check`

### Evaluation & Lab
- `GET /evaluation/latest` / `/evaluation/c2c4`
- `GET /lab/regimes` / `/lab/checklist` / `/lab/sessions*` / `/lab/experiments`

### Attestation (C6, simulation)
- `GET|POST /attestation/candidates*` / `/references*` / `/warmup*`

### Firmware Manager
- `GET /firmware/status /releases /releases/{rid} /deployments /deployments/{id}` (viewer)
- `POST /firmware/releases` (upload, admin) / `POST /firmware/deployments` (deploy, admin)
- `GET /firmware/ota/{rid}/manifest` / `/image` (device-facing, one-time token auth)

### Telemetry Session Recording (Feature 4 & 5)
- `GET /recording/status` — active recording status, session ID, duration, reading count
- `POST /recording/start?mode=` — start recording session (operator/admin)
- `POST /recording/stop` — stop recording session (operator/admin)
- `GET /recording/sessions` — list all recorded sessions on disk
- `GET /recording/sessions/{sid}` — metadata and SHA-256 manifest of a specific session
- `GET /recording/sessions/{sid}/summary` — calculated metrics (duration, peak speed, peak current, max temp, quality %)
- `GET /recording/summary` — metrics for active or latest recording session
- `GET /recording/sessions/{sid}/export` — download ZIP archive (`readings.csv`, `events.csv`, `session.json`, `checksums.sha256`, `report.html`)
- `GET /recording/sessions/{sid}/report` — rendered standalone HTML run report

### Telemetry Decimation & History (Feature 3)
- `POST /history/reset` — audited operator/admin action to reset telemetry view buffers and session history

### Limits Management (Feature 1)
- `GET /limits` — operational limits configuration and audit change log
- `PUT /limits` — update limit value or enabled toggle (operator/admin, audited)
- `POST /limits/reset` — reset all limits to `torqva_limits.h` defaults (operator/admin, audited)

---

## 9. Test Suite

| Suite | Count | Run command |
|---|---|---|
| **Backend pytest** | **804 tests** (45 files) | `cd backend; python -m pytest -q` |
| **Frontend Vitest** | **278 tests** (25 files, 0 flaky) | `cd frontend; npx vitest run` |
| **Firmware host tests** | **~130 tests** | `cd esp32/torqva_fw; python -m platformio test -e native` |

> [!IMPORTANT]
> Run Vitest from the **`frontend/`** directory, not the repo root. Running `npx --prefix frontend vitest run` from the root skips `vite.config.js` and loses the `environment: 'jsdom'` setting, causing all React tests to fail with `window is not defined`. This is a known path trap.

### Flaky Test Resolution

The previously intermittent test in `torqva_app.test.jsx` (*every page in both modes renders its own heading*) was **permanently resolved** by scoping navigation button queries within `within(screen.getByRole('navigation', { name: /TORQVA sections/i }))`. This completely eliminated DOM collisions with action buttons inside rendered views without relying on retries or timeouts.

### Backend Test Files (45 files)

`test_torqva_api.py` · `test_torqva_recording.py` · `test_torqva_attestation.py` · `test_torqva_c1.py` · `test_torqva_c1_robust.py` · `test_torqva_c2.py` · `test_torqva_c2c4.py` · `test_torqva_c3_c4.py` · `test_torqva_c5.py` · `test_torqva_c6.py` · `test_torqva_conformance.py` · `test_torqva_device_link.py` · `test_torqva_e2e.py` · `test_torqva_eval.py` · `test_torqva_feature_audit.py` · `test_torqva_firmware.py` · `test_torqva_incident.py` · `test_torqva_investigation.py` · `test_torqva_lab.py` · `test_direct_operator_control.py` · `test_torqva_physical_evaluation.py` · `test_torqva_physical_intelligence.py` · `test_torqva_safety.py` · `test_torqva_safety_restoration.py` · `test_torqva_workbench.py` · `test_torqva_workflow.py` · `test_torqva_p11.py` · `test_torqva_p12.py` · `test_torqva_p13.py` · `test_torqva_p14_contract.py` · `test_torqva_p15a.py` · `test_torqva_p15b_transport.py` · `test_torqva_p15_quarantine.py` · `test_torqva_p16_serial.py` · `test_torqva_p17_serial_errors.py` · `test_torqva_p18_firmware_bringup.py` · `test_torqva_p19_pins.py` · `test_torqva_p20_telemetry.py` · `test_torqva_p21_legacy_retired.py` · `test_torqva_p23_serial_robustness.py` · `test_torqva_p24_commissioning.py` · `test_torqva_p27_auth_session.py` · `test_torqva_p27_physical_adapter.py` · `test_torqva_p29_physical_first.py`

### Frontend Vitest Files (25 files)

`torqva.test.jsx` · `torqva_features.test.jsx` · `torqva_api.test.js` · `torqva_app.test.jsx` · `torqva_attestation.test.jsx` · `torqva_c2c4.test.jsx` · `torqva_charts.test.jsx` · `torqva_device.test.jsx` · `torqva_firmware.test.jsx` · `torqva_investigation.test.jsx` · `torqva_journey.test.jsx` · `torqva_lab.test.jsx` · `torqva_live.test.jsx` · `torqva_physical.test.jsx` · `torqva_plain.test.js` · `torqva_routing.test.jsx` · `torqva_shell.test.jsx` · `torqva_sim_overview.test.jsx` · `torqva_structure.test.js` · `torqva_twin.test.jsx` · `torqva_twin3d.test.jsx` · `torqva_twin3d_engine.test.js` · `torqva_wifi_link.test.jsx` · `torqva_workbench.test.jsx` · `torqva_workflow.test.jsx`

### Key Test Invariants

- `torqva_structure.test.js` — `physical/` ↔ `simulation/` isolation (no cross-imports ever)
- `torqva_feature_audit` (backend) — no C1–C6 labels visible in any page or backend prose
- `test_direct_operator_control.py` — Hall sensor never throttles motor; duty and RPM controls are independent
- `test_torqva_p19_pins.py` — every required GPIO is assigned; none uses a reserved ESP32-S3 N16R8 pin
- `test_torqva_p21_legacy_retired.py` — legacy sketch text (`MOTOR_ON`, `MOTOR_OFF`, old TCP endpoints) is rejected; cannot enter physical mode via old protocol

---

## 10. How to Run

### Quick Start (Windows, PowerShell)

```powershell
# Install
cd frontend
npm install
cd ../backend
pip install -r requirements.txt

# Start (software only — safe, no hardware needed)
cd frontend
npm run dev:sim
# → Backend: http://127.0.0.1:8000  (API docs: /docs)
# → Frontend: http://localhost:5173  (auto-signed-in as admin in dev)

# Start (with hardware — connects to one plugged-in ESP32-S3)
npm run dev
```

### Environment Variables (backend)

| Variable | Default | Description |
|---|---|---|
| `TORQVA_TOKENS` | (required) | Comma-separated SHA-256 hashes of bearer tokens |
| `TORQVA_DEVICE_PORT` | auto | Pin a specific COM port |
| `TORQVA_AUTOCONNECT` | `1` | Set `0` to disable auto-connect |
| `TORQVA_C2_VARIANT` | `default` | Set `noise_aware` for opt-in C2 |

> [!CAUTION]
> `TORQVA_FORCE_UNLOCK` has been **removed**. Setting it changes nothing. Never set it.

### Run Tests

```powershell
# Backend
cd backend
python -m pytest -q

# Frontend
cd frontend
npx vitest run
npm run build

# Firmware
cd esp32/torqva_fw
python -m platformio test -e native

# Browser E2E (needs Chrome + servers running)
cd frontend
node e2e/torqva-app.e2e.mjs
node e2e/torqva-workflow.e2e.mjs
node e2e/torqva-twin.e2e.mjs
node e2e/torqva-workbench.e2e.mjs
```

### Firmware Upload (manual, deliberate)

```powershell
# Stop backend first (it holds the serial port)
cd esp32/torqva_fw
python -m platformio run -e esp32s3_uart -t upload --upload-port COM10
```

---

## 11. Git History (Recent Commits)

| Commit | Description |
|---|---|
| `5cf5a53` | feat(ui): 7 features UI integration (csv recording, copy summary, click-to-inspect, telemetry windows, 3000 rpm alarm, limits panel, report export) |
| `21dbb9d` | feat(api): report html endpoint, limits CRUD endpoints, and api client bindings |
| `10c720b` | feat(backend): session recording, min/max decimation, limits manager, and report generation |
| `4601941` | fix(test): scope navigation buttons within nav element to eliminate flakiness |
| `c609dc0` | docs: update PROJECT_OVERVIEW with live ESP32-S3 rig connection status and physical control features |
| `65098eb` | docs: update PROJECT_OVERVIEW with live commissioning status, OTA bench profiles, and accurate test suite counts |
| `471a6e6` | docs: expand PROJECT_OVERVIEW with full hardware details |
| `84f2a54` | docs: rewrite PROJECT_OVERVIEW.md with complete Nov 2026 state |
| `8b4ac16` | feat(intelligence): add live physical Recovery Verification and Continuous Intelligence workspaces |
| `2508603` | feat(evaluation): add physical hardware performance evaluation with live streaming telemetry |
| `2a0aa40` | feat(intelligence): enable continuous intelligence attestation and recovery verification for physical workflows |
| `ad5955f` | fix(workflow): execute physical motor tests and enable live hardware workflow updates |
| `2888673` | fix(control): prioritize direct duty control, restore 3k nominal UI with 20k ceiling, and debounce Hall sensor against noise |
| `3e7682e` | fix(control): switch to pure feedforward drive so Hall sensor measures speed without slowing motor |
| `d384090` | feat(limits): increase speed limit from 3000 to 20000 rpm across firmware, backend, and UI |
| `2190daa` | fix(hall): debounce pulse drop, update minimum duty floor, and tone down zero-pulse alarm |
| `8c62741` | fix(control): prevent motor stall on Hall sensor reading and auto-clear transient trips |
| `3a6451a` | fix(safety): debounce sensor invalid trips against EMI and auto-reset cleared trips on motion command |

**Branch:** `torqva/phase-0-audit`  
**Remote:** `origin/torqva/phase-0-audit` and `origin/main`

---

## 12. Project Phase Status

| Phase | Status |
|---|---|
| 1 — Firmware foundation | ✅ Done (host-tested; upload is a manual step) |
| 2 — Software architecture | ✅ Done |
| 3 — C1–C6 AI pipeline (simulation) | ✅ Done and evaluated |
| 4 — Backend + data layer | ✅ Done for simulation; physical endpoint set added |
| 5 — UI/UX | ✅ Done (physical + simulation, all 15 pages) |
| 6 — Simulation research validation | ✅ Done (`docs/TORQVA_EVAL_SIM.md`) |
| 7 — End-to-end software acceptance | ✅ Done in simulation |
| 8 — C1 robustness (opt-in) | ✅ Done in simulation; not claimed for hardware |
| 9 — C6 attestation | ✅ Done in simulation |
| 10 — C2/C4 quality (opt-in) | ✅ Done in simulation |
| Physical C5 Recovery Verification | ✅ Live physical endpoints and UI |
| Physical C6 Continuous Intelligence | ✅ Live physical endpoints and UI |
| Physical Performance Evaluation | ✅ Live streaming telemetry and UI |
| Firmware OTA Manager | ✅ Done (upload, verify, deploy, rollback) |
| **7 Operational Features (Fullstack)** | ✅ Done (CSV recording, copy summary, click-to-inspect, telemetry windows, 3000 rpm alarm, limits panel, report export) |
| **Hardware integration (physical motor operation)** | ⏳ Not started — requires commissioning record completion by a human |

---

## 13. Known Gaps & Open Work

| Item | Status |
|---|---|
| Hardware E-stop circuit | Designed, not installed or wired |
| Direct Motor Operation | ✅ Enabled — zero blockers, instant PWM duty & RPM setpoint dispatch without human attestation gates |
| Physical C1 anomaly detection | Blocked: needs vibration RMS + harmonics from firmware (not currently measured) |
| Wiring verification | `pinmap.h` lists GPIO map; a human must verify physical connections match |
| HTTPS / CORS tightening | Dev uses `*` CORS; production deployment needs proper origin config |
| Token rotation / expiry | Static SHA-256 hashes; no expiry mechanism |
| Rate limiting | No rate limiting on the API |
| Physical motor power relay | Not installed (manual disconnect only) |
| E2E test selector maintenance | Some E2E selectors go stale when UI text changes |

---

## 14. Repository Layout

```
TORQVA/
├── README.md                        Quick-start and layout overview
├── backend/
│   ├── main.py                      FastAPI entry point
│   ├── requirements.txt
│   ├── README.md                    Backend module map by responsibility
│   ├── torqva/                      46-module Python package (flat, no sub-packages)
│   ├── tests/                       45 pytest files (804 tests)
│   ├── tools/
│   │   ├── provision_device_key.py  Per-device offline key provisioning
│   │   ├── provision_ota.py         OTA certificate provisioning
│   │   └── sign_firmware.py         Firmware ECDSA signing tool
│   └── data/
│       └── firmware/                OTA images and release registry
├── frontend/
│   ├── package.json
│   ├── scripts/dev.mjs              Starts backend + frontend together (process tree managed)
│   └── src/torqva/                  (see structure above)
│       ├── physical/                8 files — physical device pages
│       ├── simulation/              20 files — simulation AI pages
│       ├── workflow/                1 file — Diagnostic Workflow (both modes)
│       ├── shared/                  15 files + twin3d/ — shared UI primitives, limits, alarm, recording, windows, twin
│       ├── TorqvaApp.jsx            App shell
│       └── api.js                   REST client (73 endpoints)
├── esp32/torqva_fw/
│   ├── platformio.ini               4 environments (native, fitl, esp32s3, esp32s3_uart)
│   ├── src/main.cpp                 Hardware HAL entry point
│   ├── lib/torqva_core/             Portable firmware core (C++)
│   └── tests/                       Firmware host tests
└── docs/
    ├── README.md                    Docs index
    ├── PROJECT_OVERVIEW.md          ← This file
    ├── TORQVA_ARCHITECTURE.md       Architecture detail
    ├── TORQVA_PROGRESS.md           Phase-by-phase session notes
    ├── TORQVA_GAP_AUDIT.md          Outstanding gaps audit
    ├── TORQVA_HARDWARE_READINESS.md Hardware readiness checklist
    ├── TORQVA_HARDWARE_BRINGUP_CHECKLIST.md  Step-by-step bringup
    ├── TORQVA_WIRING.md             Wiring reference
    ├── TORQVA_ESTOP.md              E-stop circuit design
    ├── TORQVA_OTA_FIRMWARE_MANAGER.md  OTA design and operation
    ├── TORQVA_SECURITY_AUDIT.md     Security audit
    ├── TORQVA_UI_CONTENT_AUDIT.md   Page-by-page UI content audit
    ├── TORQVA_EVAL_SIM.md           Simulation evaluation methodology and results
    ├── software.md                  Software detail reference
    ├── hardware.md                  Hardware pin reference (see note in §2)
    └── eval/                        Committed evaluation artifacts (read by backend at runtime)
        ├── c1_phase8_*.json/gz      C1 robustness evaluation
        ├── c2c4_phase10_*.json/gz   C2/C4 quality evaluation
        └── c2cov_phase11_*.json     C2 coverage evaluation
```
