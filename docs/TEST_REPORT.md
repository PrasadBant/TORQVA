# Wireless implementation test report (25 Nov 2026)

| Check | Result |
|---|---|
| `docker info` & `torqva-pio:latest` image build | Passed; Docker Engine `29.6.1`, offline ESP32-S3 PlatformIO `6.1.16` + `espressif32@7.1.3` image built. |
| Isolated Docker container `.ino` compilation (`--network none --read-only --cap-drop ALL`) | Passed; standalone `.ino` sketch wrapped with TORQVA Wi-Fi + OTA bridge compiled to `1,021,584` byte ESP32-S3 `.bin` in `79.0 s` (`RAM 17.4%`, `Flash 30.6%`), passing chip, `TORQVA_FW_ID`, partition, Wi-Fi and OTA compatibility checks. |
| `pio run -e esp32s3_wireless` | Passed; `RAM 57,048 / 327,680 B (17.4%)`, `Flash 1,021,221 / 3,342,336 B (30.6%)`. |
| `pio run -e esp32s3_uart` | Passed in `65.52 s`; `RAM 54,200 / 327,680 B (16.5%)`, `Flash 974,121 / 3,342,336 B (29.1%)`. |
| `pio test -e native` | Passed; `166 / 166` cases in `13.134 s` (`test_core`, `test_device`, `test_line_out`, `test_ota`). |
| `cd frontend && npm run build` | Passed in `11.10 s` (2,335 modules). |
| `cd frontend && npx vitest run` | Passed; `285 / 285` tests across `29` files in `49.84 s`. |
| Complete backend suite (`pytest backend/tests/ -rs -q`) | Passed; `794 passed, 0 failed, 0 skipped` in `209.78 s`. |
| Physical LED-only / production ESP32-S3 (`COM7` CH343) flashing & OTA verification | Pending explicit user confirmation with motor power disconnected (`COM7`, `USB VID:PID=1A86:55D3` detected, untouched). |

## Baseline 30 skipped backend tests investigation

Before building the host PlatformIO targets, `30` backend tests skipped dynamically via `@pytest.mark.skipif(...)` because two compiled artifacts were not present on disk:
1. `esp32/torqva_fw/.pio/build/fitl/program.exe` (`skipif(not FITL.exists(), reason="fitl CLI not built (pio run -e fitl)")`) in `test_torqva_conformance.py`, `test_torqva_p14_contract.py`, `test_torqva_p16_serial.py`, `test_torqva_p18_firmware_bringup.py`, `test_torqva_p20_telemetry.py`, `test_torqva_p23_serial_robustness.py`, `test_torqva_p27_auth_session.py`, `test_torqva_p27_physical_adapter.py`, and `test_torqva_p29_physical_first.py`.
2. `esp32/torqva_fw/.pio/build/esp32s3_uart/firmware.elf` (`skipif(..., reason="esp32s3_uart not built")`) in `test_torqva_p18_firmware_bringup.py`.

After running `pio run -e fitl` and `pio run -e esp32s3_uart`, all 30 tests executed and passed (`794 passed, 0 skipped`).

## Motor-control integration restoration

Authorized motor control (`START`, `SET_SPEED`, `STOP`, `RESET_ESTOP`) has been restored without any unauthenticated USB bypass or manual commissioning forms via [device_config.py](file:///c:/Users/vishu/Downloads/Torqva/backend/torqva/device_config.py) (`OperatingConfigManager`). On backend startup (non-test environments), it automatically loads validated hardware-safe operating limits (`3.0 A`, `10.0–25.5 V`, `60.0 °C`, `3000.0 rpm`, `70.0 %` duty), keeps them synchronized with `LimitsManager` (`PUT /limits`, `POST /limits/reset`), and pushes versioned `{"t":"cfg",...}` frames over the HMAC-authenticated device session before unlocking `SafetySupervisor`.

No physical hardware flashing, wireless RF throughput measurement, or powered motor testing has been performed yet; physical verification requires confirmation on `COM7` with motor power isolated.
