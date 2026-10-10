# TORQVA hardware bring-up checklist (operator)

Status: **nothing below has been verified.** Software checks (pin-map tests, protocol tests, target builds) are not evidence of wiring or electrical behaviour. Do not upload until every box in sections 1-5 is ticked and you have given a separate, explicit upload authorisation. The motor stays disabled throughout: physical START and speed are blocked by firmware interlocks and by the backend.

## 1. Board identity
- [ ] Photo of the module shield (for example `ESP32-S3-WROOM-1-N16R8`) and of the board silkscreen/revision.
- [ ] Read-only identification, with the Arduino IDE and TORQVA disconnected: `python -m esptool --port COMx chip_id` and `flash_id` (reads only). Flash must be 16 MB and PSRAM octal 8 MB to match `qio_opi` / 16 MB in `platformio.ini`; any mismatch must be resolved before flashing.
- [ ] **GPIO 38:** on some ESP32-S3-DevKitC-1 revisions (v1.1) the on-board RGB LED data line is GPIO 38, which this firmware uses for BTS7960 RPWM. Check the schematic for your revision; if shared, RPWM would drive the LED net. (Unverified assumption.)
- [ ] GPIO 39 is also JTAG TCK; irrelevant unless JTAG is used.

## 2. USB path and environment
- [ ] Which connector is the cable on? CH343 "UART" port -> use `esp32s3_uart` (Serial = UART0). Native "USB" port -> use `esp32s3` (Serial = USB CDC). The wrong one leaves the port silent.
- [ ] COM port number confirmed in Device Manager; no other program holds it (quit Arduino IDE, serial monitors).

## 3. Wiring (a person confirms each; intended map from `esp32/torqva_fw/lib/torqva_core/pinmap.h`)
- [ ] OLED SH1106 SDA 4 / SCL 5 (software I2C)
- [ ] DS18B20 data 6 with 4.7 kOhm pull-up to 3.3 V
- [ ] INA219 SDA 7 / SCL 8 (own bus); shunt and range suit the motor current (check the actual board)
- [ ] Hall sensor 9, pulse per revolution count confirmed (firmware assumes 1)
- [ ] Status LEDs 10-13 (motor, temperature, accelerometer, INA219); buzzer 14
- [ ] ADXL345 SDA 16 / SCL 17; address 0x53 (SDO low)
- [ ] BTS7960/IBT-2: R_EN 18, L_EN 21, RPWM 38, LPWM 39
- [ ] Common ground; all signals 3.3 V logic; the motor supply never touches a GPIO

## 4. Motor safety (blockers to physical operation)
- [ ] Motor-driver power (BTS7960 and motor supply) physically isolated for all bring-up; ideally the driver unplugged from GPIO 18/21/38/39.
- [ ] Independent hardware emergency stop that cuts motor power without software; wiring contract written down. (None exists; the E-stop input is unconfigured.)
- [ ] Driver-enable and PWM lines pulled to the OFF state in hardware across reset and brown-out (default-off circuit); verified by measurement.
- [ ] Approved current, voltage, temperature and overspeed limits entered by a responsible person.
- [ ] Watchdog timeout approved (2 s is an assumption) and tested on the target.
- [ ] Secured device transport (device TLS client and key provisioning) or an accepted written risk decision for USB.

## 5. Firmware artifact
- [ ] Artifact path and SHA-256 recorded (see `docs/TORQVA_HARDWARE_READINESS.md`, Phase 22) and equal to the file you are about to upload.
- [ ] Upload command reviewed: `python -m platformio run -e esp32s3_uart -t upload --upload-port COMx` (only after explicit authorisation).

## 6. After an authorised upload (still no motor commands)
- [ ] Device page: `PHYSICAL DEVICE CONNECTED` only after a valid handshake; firmware 3.0.1-dev, protocol 1.
- [ ] Sensor table shows real readings; unplug a sensor and see it become invalid/unavailable, never zero.
- [ ] Motor Control page: interlocks still show BLOCKED / NOT VERIFIED; START and speed stay disabled.
