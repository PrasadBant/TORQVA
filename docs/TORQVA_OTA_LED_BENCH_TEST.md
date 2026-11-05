# TORQVA — OTA LED bench test (ESP32-S3, one LED, no motor hardware)

> **Status (5 Nov 2026):** USB install of 1.0.0 and the OTA update 1.0.0 → 1.1.0 **performed on the real board** (section 9). The wireless device link
> (section 10, firmware 1.1.1) is implemented and software-tested; its hardware steps are **not performed yet**. This bench demonstrates the update and
> device-link paths only; it says nothing about motor control, which this firmware cannot perform.

## 1. What the bench device is

An ESP32-S3 N16R8 with **one LED on GPIO 5** (220–330 Ω to GND) on USB, running the **OTA LED bench profile** of the real TORQVA firmware:

| | Production firmware (`esp32s3`, `esp32s3_uart`) | OTA LED bench (`esp32s3_ota_led_v100`, `esp32s3_ota_led_v110`) |
|---|---|---|
| Motor control | `TORQVA_CONTROL_ENABLED=1` | **compiled out**; START / SET_SPEED / RUN_TEST rejected by the firmware (`NOT_IN_HARDWARE_CONTROL`); a bench build with control enabled does not compile |
| Motor driver PWM | set up on GPIO 38 | **never set up**: no `ledc*` function is linked; driver pins held LOW |
| Sensors (INA219, DS18B20, ADXL345, Hall) | read | **not initialised**; every reading is reported *invalid* (speed included: never "0 rpm") |
| OLED (GPIO 4/5) | on | **off** (`TORQVA_OLED=0`), so GPIO 5 is the LED |
| OTA eligibility | needs measured standstill (valid Hall 0 rpm) and motor supply < 1 V | same checks **minus** speed and supply, which do not exist on this board; motor control must be compiled out (`BENCH_PROFILE_INVALID` otherwise) |
| First-boot self-test | outputs off, safety, watchdog, E-stop input, INA219 + DS18B20, identity + key, OTA config, host session | same **minus** sensors and E-stop input, **plus** "motion unavailable" (`ota_selftest_bench`) |
| `ota_info` | unchanged | adds `"prof":"ota_led_bench"` |
| Image identity | `TORQVA_FW_ID:ver=…;chip=esp32s3;proto=1;` | `…;proto=1;prof=ota_led_bench;` |

Everything else is the production code path: authenticated session (per-device key), HMAC-authenticated `ota` request, HTTPS with a provisioned CA,
ECDSA P-256 manifest signature, streamed SHA-256, inactive-slot write, restart, `PENDING_VERIFY`, self-test, confirm or bootloader rollback.

**Backend isolation:** a device reporting `prof=ota_led_bench` gets the blocker "OTA LED BENCH DEVICE …" and every START / SET_SPEED request is rejected before the
Safety Supervisor (STOP is never blocked). A release carries its profile from the image; it is deployed only to a device reporting the **same** profile
("profile mismatch" otherwise), so a bench image never reaches a motor controller and a production image never reaches the bench board. The Firmware
Manager shows *Firmware profile* and *Release profile*; on a bench board the safety line says nothing is measured.

LED: `TORQVA_BENCH_BLINK_MS` is the half-period. 1.0.0 = 500 ms (one blink per second), 1.1.0 = 100 ms (five blinks per second). GPIO 5 is not a
strapping pin on the ESP32-S3 (those are 0, 3, 45, 46) and starts LOW; 3.3 V through 220–330 Ω is about 4–6 mA.

## 2. USB console (COM10)

COM10 is the chip's own USB-Serial/JTAG controller (`VID 303A PID 1001`). The board definition sets `ARDUINO_USB_MODE=1` and the bench profiles
`ARDUINO_USB_CDC_ON_BOOT=1`: `Serial` is that controller, so the JSON-lines protocol (with `seq` / `ts`) appears on COM10. The board's previous firmware
(`esp32s3_uart`, `CDC_ON_BOOT=0`) wrote to UART0 / the CH343 port instead, which is why COM10 was silent before.

## 3. Board facts (read 4 Nov, read-only)

ESP32-S3 (QFN56) rev v0.2, 8 MB embedded PSRAM, 16 MB flash, MAC 44:b1:76:ce:48:a8. Full flash backup
`C:\Users\vishu\torqva-keys\backup\flash_full_16MB_before_ota.bin`, SHA-256 `426f0500f6ea7dddf91f4b3f4af5f3ed62ed3e23d810ac2a49361e5e2f39e218` (contains the device key:
private). Contents: TORQVA 3.0.1-dev (`RIG-1`) in `ota_0`, `ota_1` empty, NVS holds only `torqva/authkey`, which equals the backend's RIG-1 key.
The partition table (`default_8MB.csv`: nvs 0x9000 20 KB, otadata 0xE000 8 KB, ota_0 0x10000 3264 KB, ota_1 0x340000 3264 KB) and the bootloader on the
board are **byte-for-byte identical** to this build's, so neither is rewritten. Images: 917,936 bytes each (27.5 % of a slot).

## 4. Signing

Key pair `C:\Users\vishu\torqva-keys\dev` (private key encrypted; public fingerprint `ce5ae449c638dcac`, compiled into both images and set as
`TORQVA_OTA_PUBLIC_KEY`). Release files `C:\Users\vishu\torqva-releases\bench\torqva-ota-led-1.0.0.bin` / `-1.1.0.bin` with `.sig`
(`sign_firmware.py sign`). Checked: each signature verifies for its own image only; a modified image is refused by checksum and signature.

## 5. HTTPS for the device

`backend/tools/ota_https_gateway.py`: `make-cert` creates a bench CA and a certificate for the PC's address (IP as DNS and IP name, for mbedTLS 2.x);
`serve` listens on that address (port 8443) with TLS 1.2+ and forwards only `GET /api/torqva/firmware/ota/<rel>/manifest|image?t=<token>` to the backend on
127.0.0.1; everything else is 404, and the token is never logged. Checked locally: TLS succeeds with the bench CA, fails without it.

**Open (4 Nov):** the PC was on the open "New Horizon College" network (172.51.149.160/19, Windows category *Public*), not on the bench Wi-Fi. The device
and the PC must share a private network the owner controls; the certificate and `TORQVA_OTA_PUBLIC_BASE_URL` must then be re-issued for the PC's address there.

## 6. Provisioning (NVS)

One NVS image (20 KB at 0x9000) with `torqva/authkey` = the **existing** key from the backend store (no rotation) and `torqva_ota` = `ssid`, `pass` (typed
into a hidden prompt), `base`, `ca`. Generated with `esp_idf_nvs_partition_gen`, parsed back before writing, kept outside the repository and deleted after use.

## 7. Approval gates

A. generate the NVS image (local) · B. write NVS at 0x9000 · C. write `torqva-ota-led-1.0.0.bin` at 0x10000 · D. deploy 1.1.0 through the Firmware Manager.
Each needs its own explicit approval. Recovery from any state: `esptool write_flash 0x0 <backup>` restores the board exactly as it was.

## 8. Tests (host)

Firmware host 157/157 (6 new bench tests: eligibility without sensor readings, production still refused with the same inputs, bench + control refused,
session still required and motion refused, `prof` only in bench frames, bench self-test). Backend 775/775 (5 new: strict `prof` parsing, unknown profile
refused, profile mismatch both ways, bench deploy, bench motor-command refusal). Frontend 259/259 (2 new). Builds: both bench profiles, `esp32s3`, `esp32s3_uart`.

## 9. Hardware procedure and results

| # | Step | Result |
|---|---|---|
| 1 | NVS written at 0x9000 (existing key kept), read back identical; 1.0.0 written to **ota_1** (0x340000) and otadata sector 1 (seq 2, `ESP_OTA_IMG_NEW`) | **done** 4 Nov 23:17 (ota_0 kept 3.0.1-dev) |
| 2 | First boot `PENDING_VERIFY` → self-test → `CONFIRMED`; backend on COM10 (DTR/RTS low): RIG-1, 1.0.0, `run: ota_1`, `prof: ota_led_bench` | **done** |
| 3 | LED on GPIO 5: one blink per second | **done** (observed by the operator) |
| 4 | Backend physical mode + gateway on 10.177.25.194:8443 (Private network, firewall rule TCP 8443 local subnet only) | **done** |
| 5 | Upload 1.1.0 + `.sig` through the Firmware Manager: every check VERIFIED | **done** (release `0f3433640fb9`) |
| 6 | Deploy 1.1.0: WIFI → MANIFEST → DOWNLOADING 917,936 B → VERIFYING → READY → REBOOTING → WAITING_FOR_RECONNECTION → SELF_TEST → CONFIRMED | **done** 4 Nov 23:23:48–23:24:01; the ESP32 (10.177.25.41) fetched manifest and image over HTTPS |
| 7 | LED five blinks per second; device reports 1.1.0, `run: ota_0`, `pend: 0` | **done** |
| 8 | Failure cases: wrong-key release, modified image, Wi-Fi off during download, self-test failure → rollback | **not performed** |

## 10. Wireless device link (firmware 1.1.1) — software done, hardware pending

**What depended on USB (audit, 1.1.0):** every runtime message (status, telemetry, `ota_info`, OTA progress), the authenticated session (and therefore HOST_LINK
in the first-boot self-test), heartbeats and the OTA request itself. Only the image download used Wi-Fi.

**Design: the same protocol, another transport.**
- **Device:** `src/wifi_link.cpp` (only with `TORQVA_WIFI_LINK=1`, bench profile only; production motor firmware does not compile it). It connects out to
  `wss://<base host:port>/api/torqva/device/link` with ESP-IDF's `esp_websocket_client`, verifying the server against the provisioned CA with the host name
  checked. Every device line goes to USB **and** the link; lines received over the link go to the same `Device::on_line`. Reconnect: exponential backoff
  1 s → 30 s with jitter, reset after a link lasted 30 s. Wi-Fi stays on (the OTA path reuses it). The device listens on nothing.
- **Authentication:** unchanged. The backend runs the existing mutual challenge-response with the per-device key (`dev|cn|dn|id` / `cli|dn|cn|id|ttl`, session
  key derived on both sides; the key never travels), then HMAC-authenticated, replay-protected commands. HOST_LINK is `Device::secure_session()`, so a
  Wi-Fi link passes it only after the backend proved the key; Wi-Fi association alone never does.
- **Backend:** `torqva/device_link.py` + route `/api/torqva/device/link` (on only with `TORQVA_DEVICE_LINK=1`; `npm run dev:sim` strips it). The bridge runs
  on a `WsTransport` exactly as on USB (one transport = one command route). A link without a session after 20 s is closed; attempts are rate-limited per
  address; messages > 1 KB close the link. A bench device on USB hands over to Wi-Fi; a production device on USB is never displaced (`LINK_BUSY`).
- **Gateway:** `ota_https_gateway.py` relays exactly `GET /api/torqva/device/link` with a WebSocket upgrade (raw bytes, one connection) besides the two
  download routes; everything else is 404.
- **UI:** *Connected — Wi-Fi* / *— USB* / *Wi-Fi (authenticating)* / *Disconnected* from the backend's `transport` and `session`; link events under
  *Advanced details: Wi-Fi device link*.
- **USB serial:** unchanged as the flashing, recovery and diagnostic path; ports with Espressif USB VID 0x303A are now opened with DTR/RTS low (no reset;
  confirmed on the board: uptime unchanged across an open).

**Software results (5 Nov):** backend 786/786 (9 device-link tests: off unless enabled, mutual handshake over the link, key never sent, wrong key → no session
and closed, second link refused, rate limit, oversize, USB → Wi-Fi handover for bench only, duplicate/gap counting); firmware host 157/157; frontend 264/264
(5 link UI tests); ten browser suites 342 checks; end to end through the real gateway with TLS 1.2 + the bench CA: upgrade, mutual handshake, refusal
without the CA, other routes 404. **Not host-testable:** the ESP32 WebSocket client itself (TLS, reconnect) — first exercised on the board.

**Limitations:** one device link per backend process (the bridge holds one device; a second device is refused, not multiplexed). The certificate is for
10.177.25.194: if the hotspot assigns another address, re-issue it (`make-cert --ca-dir`) and update `TORQVA_OTA_PUBLIC_BASE_URL` + NVS `base`. Production
motor firmware is not migrated.

| # | Hardware step (1.1.1) | Result |
|---|---|---|
| 1 | Deploy 1.1.1 (release `403754570efe`) over USB-coordinated OTA (1.1.0 has no Wi-Fi link) into ota_1; 1.1.0 stays in ota_0 | not performed |
| 2 | First boot over Wi-Fi only (USB auto-connect off): WSS + handshake → HOST_LINK → CONFIRMED | not performed |
| 3 | LED five blinks per second; page *Connected — Wi-Fi* | not performed |
| 4 | Unplug laptop USB, power from a 5 V USB supply on the board's USB connector; link returns | not performed |
| 5 | Hotspot restart and backend restart: reconnect | not performed |
