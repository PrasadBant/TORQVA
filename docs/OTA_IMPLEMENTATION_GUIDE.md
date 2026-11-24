# OTA implementation guide

TORQVA's OTA system spans `esp32/torqva_fw/src/ota_esp32.cpp`, `esp32/torqva_fw/lib/torqva_core/ota.cpp`, `backend/torqva/firmware.py`, `backend/torqva/firmware_routes.py`, and `backend/torqva/compiler.py`.

## Build & Compilation Pipeline

- **Isolated Docker Engine (`torqva-pio:latest`)**: Uploaded `.ino`, `.cpp`, `.c`, `.h`, `.hpp`, and `.zip` projects are staged in a per-job directory (zip-slip & symlink protected), compiled offline inside an ephemeral container (`--network none --read-only --cap-drop ALL --memory 2g --cpus 2`), checked for `TORQVA_FW_ID`, Wi-Fi link, and OTA partition retention, and optionally signed on the host via `TORQVA_OTA_SIGNING_KEY`.
- **Resumable HTTPS Transfer (`206 Partial Content`)**: `ota_esp32.cpp` tracks received bytes across transient chunk failures and issues HTTP `Range: bytes=<offset>-` requests against `/api/torqva/firmware/ota/{rid}/image?t=...` so interrupted transfers do not restart from zero or corrupt flash.
- **Persistent State (`deployments.json`)**: `FirmwareStore` persists deployment history and active snapshots without leaking ephemeral tokens across backend restarts.

## Boot Validation & Rollback

- **Automatic Rollback**: `verifyRollbackLater()` prevents automatic confirmation on first boot until TORQVA's self-test confirms initialization, sensors (or bench profile), identity/key, host link, stopped outputs, watchdog, and OTA state. Failed boots automatically revert to the prior slot (`ROLLED_BACK`).
- **Manual Rollback**: `POST /api/torqva/firmware/rollback` supports both re-deploying a stored prior compatible release (`rollback=True` / `rb=1`) and triggering on-device `ota_rollback` (`sys` HMAC-signed command).

## Pre-requisites for Physical ESP32 Verification

Initial USB provisioning on `COM7` (with motor power disconnected) installs the pinned `default_8MB.csv` partition table, `esp32s3_wireless` base image, NVS Wi-Fi/CA/URL config, and per-device 32-byte key before cable-free wireless OTA begins.
