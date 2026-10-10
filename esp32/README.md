# ESP32-S3 firmware

`esp32/torqva_fw/` (PlatformIO, Arduino-ESP32) is the **sole supported firmware**. The earlier `smart_motor_monitor` Arduino sketch was **retired from the current tree**: it accepted an unauthenticated TCP `MOTOR_ON` and had no interlocks or watchdog. It remains in Git history only. Do not recover it, build it or upload it.

> **The hardware is not ready for physical motor operation.** Physical START and speed commands are refused by the firmware interlocks and by the backend. Remaining requirements are listed in `docs/TORQVA_HARDWARE_READINESS.md` (independent hardware E-stop, default-off driver circuitry across reset, approved limits, approved watchdog timeout with an on-target test, secured device transport, board confirmation).

## What the firmware speaks

The device protocol is TORQVA wire protocol 1: JSON lines over USB serial (`fast`, `slow`, `accel`, `status`, `ack`). See `docs/software.md` and `docs/TORQVA_HARDWARE_READINESS.md`.

Human-readable text such as `STATUS: MOTOR OFF`, `OVERALL CONDITION`, or `[TCP ...]` lines is **not** TORQVA telemetry. The backend parser rejects it, counts it as malformed, and shows `HANDSHAKE INVALID`; it never enters physical-device mode on such text. The supported firmware must implement the current protocol, so a board that still prints old text is not a valid TORQVA device.

## Environments (`esp32/torqva_fw/platformio.ini`)

| Environment | Purpose |
|---|---|
| `native` | Host unit tests of `lib/torqva_core` (`python -m platformio test -e native`). No hardware. |
| `fitl` | Firmware-in-the-loop CLI used by the backend contract tests (`python -m platformio run -e fitl`). No hardware. |
| `esp32s3_uart` | Device build whose `Serial` is **UART0**, reached through the board's USB-to-serial bridge (for example the CH343 "UART" port). Choose this when the cable is plugged into the UART/COM connector. |
| `esp32s3` | Device build whose `Serial` is the **native USB CDC** port. Choose this when the cable is plugged into the native USB connector. |

The two device environments differ only in `-DARDUINO_USB_CDC_ON_BOOT`. They are deliberately not merged: with the wrong one, frames go to a port nobody is listening to and the other port stays silent. Which connector your board uses is a hardware fact to confirm before any upload.

## Build and test (no upload)

```powershell
cd esp32/torqva_fw
python -m platformio test -e native
python -m platformio run -e esp32s3_uart
python -m platformio run -e esp32s3
python -m platformio run -e fitl
```

Building does not touch the board. **Uploading is a separate, explicitly authorised step** and requires the pre-flash checks in `docs/TORQVA_HARDWARE_READINESS.md` (board identity, GPIO 38 / board revision, wiring confirmation, motor-driver power isolated, serial port free).

## Pins

`esp32/torqva_fw/lib/torqva_core/pinmap.h` is the single authoritative GPIO map; `docs/hardware.md` and `docs/HARDWARE_WIRING.md` mirror it. The wiring is unverified (`W1-LEGACYMAP-UNVERIFIED`): the pins were carried over from the retired sketch's documented wiring and are not an approved wiring contract. The relay, local reset button and E-stop input are unconfigured; no pin was invented for them.

## Safety

* Motor control is compiled out of the default build (`TORQVA_CONTROL_ENABLED` is not defined).
* The 24 V motor supply must never connect to an ESP32 GPIO (3.3 V logic).
* USB serial is unauthenticated and is treated as inside the host's physical trust boundary.
