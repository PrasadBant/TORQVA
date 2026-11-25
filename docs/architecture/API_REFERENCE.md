# Wireless and Firmware Manager API reference

All paths below use the `/api/torqva` prefix. Website routes enforce bearer-token RBAC (`viewer` / `operator` / `admin`) audited by `test_torqva_feature_audit.py`. A command record being `SENT` means transport delivery occurred; only a device acknowledgement establishes execution.

| Method and path | Minimum role | Actual behavior |
|---|---|---|
| `GET /device/status` | Viewer | Real bridge connection, transport, device handshake, session, interlocks, and telemetry validity. |
| `GET /device/history` | Viewer | Physical signal history with null gaps for unavailable readings. |
| `POST /device/connect` | Admin | Open a named USB serial port (`CONNECTING` until a real `status` frame arrives). |
| `POST /device/disconnect` | Admin | Disconnect the active bridge transport. |
| `POST /device/commands` | Admin (`STOP`: Viewer) | Dispatch authenticated HMAC commands through `SafetySupervisor`, `OperatingConfigManager`, and `DeviceBridge`. |
| `GET /device/discover` | Viewer | Query mDNS (`_torqva._tcp.local` on `224.0.0.251:5353`) plus active bridge link status. |
| `POST /device/connect-ip` | Admin | Manual IP/port fallback probe with reachability & HTTP/TCP banner inspection. |
| `GET /device/wifi` | Viewer | Device-reported `net_info` (IP, SSID, RSSI, MAC, heap, uptime) and Wi-Fi WebSocket state. |
| `POST /device/wifi` | Admin | Update SSID/password/`https://` backend URL on the ESP32 over HMAC-signed `wifi_cfg` frame. |
| `POST /device/restart` | Admin | Send HMAC-signed `sys` `restart` command when motor drive is `IDLE`. |
| `GET /device/logs` | Viewer | Searchable/filterable wireless & serial log ring buffer (`log`, `ack`, system events). |
| `GET /device/logs/download` | Viewer | Download wireless/serial logs as `.txt` or `.jsonl`. |
| `GET /firmware/status` | Viewer | Device OTA capability, current deployment state, and eligibility checks. |
| `GET /firmware/releases` | Viewer | Stored validated firmware releases. |
| `GET /firmware/releases/{rid}` | Viewer | Detailed release checks, memory/compatibility report, and per-device eligibility. |
| `POST /firmware/releases` | Admin | Upload a signed `.bin` release image. |
| `GET /firmware/docker` | Viewer | Live Docker daemon availability (`ServerVersion`) and `torqva-pio:latest` image readiness. |
| `GET /firmware/workspace/templates` | Viewer | Built-in project templates (`torqva_wireless`, `arduino_sketch_ota`, `ota_led_bench`). |
| `GET /firmware/workspace/files` | Viewer | Current public ESP32 firmware source tree (`src/*`) without secrets. |
| `POST /firmware/compile/editor` | Admin | Compile multi-file workspace inside isolated Docker container with optional auto-upload/deploy. |
| `POST /firmware/compile/upload` | Admin | Upload `.ino`/`.cpp`/`.c`/`.h`/`.hpp`/`.zip`/`.bin`, compile/validate, and register release. |
| `GET /firmware/compile` | Viewer | List recent compilation jobs. |
| `GET /firmware/compile/{job_id}` | Viewer | Live build logs, diagnostics (`line`, `col`, `severity`), RAM/Flash stats, compatibility, and release ID. |
| `POST /firmware/deployments` | Admin | Deploy a compatible release wirelessly (`{release_id, device_id}`). |
| `GET /firmware/deployments` | Viewer | Current deployment snapshot and persisted deployment history (`deployments.json` + `history.jsonl`). |
| `GET /firmware/deployments/{dep_id}` | Viewer | Real device-reported OTA stage, bytes transferred, and timeline events. |
| `POST /firmware/rollback` | Admin | Roll back to a stored compatible release (`rb=1`) or request partition `ota_rollback` on device. |
| `GET /firmware/ota/{rid}/manifest?t=…` | Device token | Short-lived release manifest over HTTPS. |
| `GET /firmware/ota/{rid}/image?t=…` | Device token | Resumable image download over HTTPS supporting `Range: bytes=…` (`206 Partial Content`). |
| WebSocket `/device/link` | Device protocol | Outbound ESP32 TLS WebSocket carrying TORQVA frames. |
