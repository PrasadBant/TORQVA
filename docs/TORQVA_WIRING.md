# TORQVA — Wiring & Hardware (DRAFT, wiring ID `W0-legacy` → target `W1`)

Status: **draft for human confirmation.** Nothing here has been wired, measured or flashed by the agent. Where this file disagrees with `docs/HARDWARE_WIRING.md` (old, stale), this file wins; see Audit finding R-2.

## 1. Parts & roles
See the master prompt §2.1. Summary of what changes from the legacy build:

| Item | Legacy (firmware 2.0.0, `W0-legacy`) | Target (`W1`) |
|---|---|---|
| Motor driver | BTS7960, EN lines driven by firmware only | Same driver; R_EN/L_EN 10 kΩ **pull-down** to GND; PWM 20 kHz |
| Power cut | none | Relay in series with motor +24 V, coil fed **through latching E-stop** |
| ADXL345 | I2C GPIO 4/5 (shared with OLED) | SPI (see §4) |
| Temperature | one DS18B20 (GPIO 6) | two DS18B20 on one bus: housing + ambient |
| INA219 | separate I2C bus (GPIO 7/8), default 0.1 Ω shunt (±3.2 A) | 0.05 Ω shunt (≈ ±6.4 A), recalibrated; placed after bulk cap |
| BTS7960 IS | not connected | R_IS/L_IS to ADC1 (≤ 3.3 V verified) |
| Hall A3144 | 3.3 V supply (per old doc) | 5 V supply, 10 kΩ pull-up to 3.3 V, small RC filter |
| Status LEDs ×4, buzzer | GPIO 10–14 | Keep only if pins are free in the final map (see §4) |

## 2. Shopping list
Second DS18B20 · 0.05 Ω ≥ 1 W shunt for INA219 · latching E-stop switch rated for the relay-coil circuit · bulk electrolytic ≥ 470 µF / ≥ 35 V · clear guard for the rotating disc · *later:* 24 V→5 V buck (LM2596) · small bolts/nuts/washers for fault masses and shims · 2× 10 kΩ (EN pull-downs), 4.7 kΩ (1-wire), 10 kΩ (Hall), 1 kΩ + 1 nF (Hall filter), 100 nF decoupling caps.

## 3. Power & wiring rules
1. ESP32 on USB from the laptop for P0. 5 V pin feeds A3144 and relay module.
2. Motor and logic supplies separate, **common ground** at the PSU negative (star).
3. SS34 reverse-polarity protection on 24 V input; bulk cap ≥ 470 µF/35 V at BTS7960 input.
4. INA219 bus limit is **26 V**: never brake actively or regenerate. Stop = disable driver and coast.
5. Short sensor leads, twisted with ground, away from motor leads; 100 nF decoupling per sensor.
6. **Breadboard for bench tests only**; final build soldered.

## 4. Pin map

### 4.1 Legacy map (as found in firmware 2.0.0, `W0-legacy`)
| Function | GPIO |
|---|---|
| ADXL345 + OLED I2C SDA/SCL | 4 / 5 |
| DS18B20 | 6 |
| INA219 I2C SDA/SCL (second bus) | 7 / 8 |
| A3144 Hall | 9 |
| LEDs ADXL/TEMP/INA/HALL | 10 / 11 / 12 / 13 |
| Buzzer | 14 |
| BTS7960 RPWM / LPWM / R_EN / L_EN | 15 / 16 / 17 / 18 |

All legacy pins are valid on ESP32-S3 N16R8 (none in 35–37, none strapping 0/3/45/46, none USB 19/20).

### 4.2 Proposed `W1` map — **choose one, human confirms**
| Function | Option A: master-prompt map (rewire) | Option B: minimal change (keep legacy where possible) |
|---|---|---|
| ADXL345 | SPI SCK 12 / MOSI 11 / MISO 13 / CS 10 / INT1 14 | SPI needs 5 pins; free GPIO 1, 2, 3✗(strapping), 21, 38–42, 47, 48 are candidates; proposal: SCK 12, MOSI 11, MISO 13, CS 10, INT1 14 (frees LEDs 10–13 and buzzer 14, i.e. **drop the LEDs/buzzer**; OLED shows status instead) |
| I2C (INA219 + OLED) | SDA 8 / SCL 18 | one shared bus SDA 8 / SCL 18 (legacy 7/8 bus needs one-pin change) |
| DS18B20 ×2 | 4 | 6 (unchanged) |
| Hall | 5 | 9 (unchanged) |
| RPWM / LPWM | 6 / 7 | 15 / 16 (unchanged) |
| R_EN + L_EN (tied, pull-down) | 15 | 17 (+18 tied to same net, unchanged) |
| R_IS / L_IS (ADC1) | 1 / 2 | 1 / 2 |
| Relay control | 16 | 21 |
| Push button | 17 | 38 |
| Heartbeat to optional Mega | 21 | 39 |

Recommendation: **Option B** keeps the working sensors and PWM wiring in place and changes only what the safety design requires. Option A is cleaner but forces a full rewire right before the riskiest phase. (Decision pending, D-03.)

All final assignments will live in one firmware header `config_pins.h` mirrored here, with the wiring ID reported in every `status` frame.

## 5. Mechanical rig & lab safety
- Motor screwed to a rigid base (plywood/MDF/metal), base clamped to the bench; **guard around the disc**; safety glasses.
- Magnet set in the disc/pulley hub with **epoxy** (not hot glue), gap 2–5 mm. (Old doc said 1–3 mm / 1.5 ± 0.5 mm; recommend settling on the A3144 datasheet range once measured.)
- Masses are screwed through the disc, never taped or glued.
- Speed cap: **70 % max PWM duty** (50 % with masses) until RPM vs duty is measured and you approve a higher figure.
- E-stop tested at the start of every lab day (logged in the Lab screen once it exists).

## 6. Wiring ID
`W0-legacy` = firmware 2.0.0 as found. `W1` will be assigned only after you confirm the Phase 1 hardware changes are physically done and verified.
