# TORQVA wireless architecture and current limits

## Implemented path

`esp32s3_wireless` builds the production ESP32-S3 firmware with `TORQVA_WIFI_LINK=1`. The board reads Wi-Fi credentials, backend HTTPS URL, CA certificate, and per-device authentication key from NVS, advertises itself on LAN via `ESPmDNS` (`_torqva._tcp.local`), and maintains an outbound TLS WebSocket link to `/api/torqva/device/link` carrying the unified TORQVA JSON protocol frames.

Authenticated motor control (`START`, `SET_SPEED`, `STOP`, `RESET_ESTOP`) flows exclusively through `DeviceBridge`, `SafetySupervisor`, `OperatingConfigManager` (auto-loaded and synced with `PUT /limits`), and HMAC-signed session frames (`cmd`, `cfg`). No raw unauthenticated USB command path or synthetic readiness state exists.

Firmware Manager now supports both:
1. Uploading pre-compiled signed `.bin` images, and
2. Editing or uploading `.ino` / `.cpp` / `.c` / `.h` / `.hpp` / PlatformIO `.zip` source code in the integrated workspace (`#/firmware`), compiling in an ephemeral isolated `--network none --read-only --cap-drop ALL` Docker container (`torqva-pio:latest`), validating ESP32-S3 compatibility (`TORQVA_FW_ID`, Wi-Fi link, OTA retention, partition fit), host-side ECDSA signing when configured, one-click wireless OTA deployment with HTTP `Range` transfer resumption, persistent deployment state (`deployments.json`), and both automatic first-boot self-test rollback and manual release/slot rollback.

## Setup and recovery

1. Set up a device key and OTA signing keys using [TORQVA_OTA_FIRMWARE_MANAGER.md](TORQVA_OTA_FIRMWARE_MANAGER.md). Never use development keys in deployment.
2. Build `esp32s3_wireless` (`pio run -e esp32s3_wireless`) and install the base OTA-capable image + NVS credentials over USB once with motor power disconnected.
3. Build `torqva-pio:latest` (`docker build -t torqva-pio:latest docker/torqva-pio`) for isolated web source compilation.
4. Run TORQVA backend (`TORQVA_DEVICE_LINK=1`, `TORQVA_OTA_PUBLIC_BASE_URL`, `TORQVA_OTA_PUBLIC_KEY`) + HTTPS gateway + frontend.
5. Disconnect the USB data cable and operate, compile, deploy OTA updates, inspect wireless logs, configure Wi-Fi, restart, and trigger rollbacks from `#/device` and `#/firmware`.

USB recovery (`esptool.py` / `pio run -t upload`) remains available whenever Wi-Fi NVS configuration is lost or both OTA slots fail.

## Current verification status

Software compilation (including isolated Docker `.ino` builds), backend (`794` tests), frontend (`285` tests + production bundle), native firmware (`166` tests), and hardware target builds (`esp32s3_wireless`, `esp32s3_uart`, `fitl`) all pass. Physical verification on the connected `COM7` CH343 board (with motor power disconnected) awaits explicit user confirmation before flashing.
