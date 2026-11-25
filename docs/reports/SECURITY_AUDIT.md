# Wireless security audit (25 Nov 2026)

## Verified in source, container isolation tests, and backend/firmware suites

- The production ESP32 build loads its 32-byte per-device key from NVS and enables authentication when provisioned.
- Both USB and Wi-Fi enter the unified `Device::on_line` protocol. Unauthenticated raw USB PWM/reset bypasses, `direct_mode`, `universal_mode`, and synthetic readiness reporting are removed (`ValueError` / `404`).
- Authorized motor control (`START`, `SET_SPEED`, `STOP`, `RESET_ESTOP`) uses `OperatingConfigManager` (`device_config.py`), `LimitsManager`, `SafetySupervisor`, and authenticated HMAC session commands (`cmd`, `cfg`, `sys`, `wifi_cfg`), keeping all firmware watchdogs, limits, interlocks, and hardware fault masks active.
- Remote system actions (`POST /device/restart`, `POST /device/wifi`, manual slot/release OTA rollback) require `ADMIN` role authentication over the API AND an active per-device HMAC-SHA256 session (`sid`, monotonic `seq`, `m`). Control characters and non-HTTPS URLs are rejected in Wi-Fi provisioning requests.
- Source compilation runs in an isolated container (`torqva-pio:latest`) with `--network none`, `--read-only` root filesystem, writable scratch `tmpfs` `/tmp`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--memory 2g`, `--cpus 2`, and `--pids-limit 256`. Host secrets, NVS data, and ECDSA release signing keys are never mounted or exposed inside containers; signing happens strictly on the host after build completion when `TORQVA_OTA_SIGNING_KEY` is set.
- Archive uploads enforce extension whitelisting (`.ino`, `.cpp`, `.c`, `.h`, `.hpp`, `.zip`, `.bin`), zip-slip path traversal rejection, symlink rejection, and extraction byte caps (`20 MB`).
- OTA downloads use short-lived deployment tokens, ECDSA P-256 verification, SHA-256 digest checks, ESP32-S3 header/identity checks, motor-stopped verification, and HTTP `Range` byte resumption without persisting tokens.

## Physical verification boundary

The build and security controls are verified across host unit/integration suites (`794` backend, `285` frontend, `166` native firmware) and live `--network none` Docker `.ino` compilation. Physical ESP32-S3 flashing and hardware verification on `COM7` remain pending explicit user confirmation with motor power disconnected.
