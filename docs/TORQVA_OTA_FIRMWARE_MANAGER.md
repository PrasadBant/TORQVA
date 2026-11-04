# TORQVA — Firmware Manager: ESP32-S3 OTA upload, transfer and verification

> **Status (4 Nov 2026).** Implemented end to end in source and tested on the host:
> - firmware state machine and device authorisation (host tests);
> - backend validation, storage, deployments and device downloads (pytest, including a software test device that downloads and verifies through the real HTTP routes);
> - the page (unit and browser tests, including an upload of the real compiled image).
>
> **Not yet validated on a board:** nothing was flashed. The ESP32-S3 platform layer (`src/ota_esp32.cpp`: Wi-Fi, TLS, `Update`, mbedTLS, rollback) is compiled for the target but has never run. The first bench run follows section 14. **OTA readiness and motor-operation readiness are separate:** this feature never enables, starts or commissions the motor, and physical operation remains blocked (`PROJECT_OVERVIEW.md` section 10, item 2).

## 1. Architecture

```text
Firmware Manager page ──upload .bin + signature──▶ FastAPI /firmware/releases
                                                     │ ESP image structure, chip id 9, version from TORQVA_FW_ID, size vs. partition,
                                                     │ SHA-256, ECDSA P-256 signature (TORQVA_OTA_PUBLIC_KEY)
                                                     ▼
                                            backend/data/firmware (images/<sha256>.bin, releases.json, history.jsonl)
Admin: Update Firmware ──▶ /firmware/deployments ──▶ eligibility (device, session, ota_info, version, attestation)
                                                     │ one-time download token
                                                     ▼
                          serial bridge ──{"t":"ota",rel,ver,tok,seq,sid,m}──▶ ESP32-S3 Device (MAC with the live session key)
                                                                               │ own eligibility (stopped, measured, no motor supply, no trip)
                                                                               ▼  OTA task (core 0, own stack)
                                     Wi-Fi from NVS ─▶ HTTPS GET <base>/api/torqva/firmware/ota/<rel>/manifest?t=…   (CA from NVS)
                                                        verify ECDSA signature with the compiled-in public key
                                                     ─▶ HTTPS GET …/image?t=…  → stream into the INACTIVE OTA partition + SHA-256
                                                        size, hash, header (0xE9, chip 9) → select next boot → record attempt → restart
                                     next boot: PENDING_VERIFY → self-tests → confirm  |  fail / crash / reset → bootloader rollback
device ──{"t":"ota",st,…} / {"t":"ota_info",…}──▶ bridge ──▶ FirmwareManager state ──▶ page (polled)
```

The serial link carries only the short authenticated request and the device's own reports; the image travels over HTTPS. The device builds every URL from the base URL provisioned in its own NVS, so the backend cannot point it at another server.

## 2. Build

PlatformIO environments come from `esp32/torqva_fw/platformio.ini`: `esp32s3` (native USB, `Serial` = USB CDC) and `esp32s3_uart` (the CH343 UART port). Both are `board = esp32-s3-devkitc-1`, `framework = arduino` (arduino-esp32 2.0.17 / IDF 4.4.7, platform espressif32 7.1.3).

1. Set the release version in `src/config_pins.h` (`TORQVA_FW_VERSION`). OTA installs only a version newer than the running one (`MAJOR.MINOR.PATCH[-suffix]`; a suffixed build sorts before its release).
2. Generate the public-key header once per deployment: `python backend/tools/sign_firmware.py export-header --pub <release_public_key.pem>` (writes `src/ota_pubkey.h`, git-ignored). Without it the build reports `NO_SIGNING_KEY` and is not OTA-capable.
3. `python -m platformio run -e esp32s3` (or `-e esp32s3_uart`). Nothing is uploaded.

## 3. Artifact

`esp32/torqva_fw/.pio/build/<env>/firmware.bin`: the application image only, with the build's appended SHA-256. `bootloader.bin` and `partitions.bin` from the same folder are needed only for the initial USB installation (section 4) and are refused by the Firmware Manager. The version is read from the `TORQVA_FW_ID:ver=…;chip=esp32s3;proto=1;` string compiled into the image (the image's own `esp_app_desc` version is the framework's, `esp-idf: v4.4.7`, and is not used).

## 4. Initial USB installation (one time, by hand)

A board running firmware built before this feature is **not OTA-capable**: the page shows `OTA NOT CONFIGURED` and no Update action. The first OTA-capable image must be installed over USB, by a person, with the motor power stage disconnected:

1. Build as in section 2.
2. Provision the authentication key (`backend/tools/provision_device_key.py`) and the OTA settings (`backend/tools/provision_ota.py`), merge the two CSV files and generate one NVS image (both tools print the commands; neither runs them).
3. Write bootloader, partition table, application and NVS with esptool (`pio run -e esp32s3 -t upload` writes the first three; the NVS image goes to 0x9000).

The partition table is the board's default `default_8MB.csv`, now pinned explicitly in `platformio.ini` (no layout change). If a board was ever flashed with a different table, writing this one changes the layout: that needs `esptool erase_flash` first, which **erases NVS (keys, Wi-Fi, stored limits)**. Re-provision afterwards. The website never flashes over USB.

## 5. Partitions

`default_8MB.csv`: nvs 20 KB at 0x9000, otadata 8 KB at 0xE000, app0/ota_0 3264 KB at 0x10000, app1/ota_1 3264 KB at 0x340000, spiffs 1536 KB, coredump 64 KB. That uses 8 of the 16 MB on the N16R8. The device reports its inactive slot size in `ota_info.psz`, and the backend refuses an image that does not fit it.

**Verified from the build output (4 Nov):**
- `gen_esp32part.py .pio/build/esp32s3/partitions.bin` decodes exactly the table above: `otadata` (data/ota), `app0` (ota_0) and `app1` (ota_1), each 3,342,336 bytes.
- `esp32-s3-devkitc-1.json` names `default_8MB.csv` as the board default, and the committed `platformio.ini` had no `board_build.partitions`. Pinning it therefore changes nothing on a board flashed by earlier builds. `esp32s3_uart` inherits it.
- Image sizes against one slot: `esp32s3` without a key 955,280 bytes (28.6 %), `esp32s3` with a public key 955,817 bytes (28.6 %), `esp32s3_uart` 968,961 bytes (29.0 %).

Bootloader rollback is enabled in this framework's precompiled configuration (`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE 1` in `framework-arduinoespressif32/tools/sdk/esp32s3/qio_opi/include/sdkconfig.h`, the `memory_type = qio_opi` variant this board builds with). Anti-rollback (`CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK`) and Secure Boot are **not** enabled, and nothing here burns eFuses. Downgrade protection is therefore enforced in software, by the backend and by the firmware, not by hardware.

## 6. Signing

- `python backend/tools/sign_firmware.py keygen --out-dir <private folder outside the repository>` creates an ECDSA P-256 key pair. The private key is passphrase-encrypted; an empty passphrase is allowed for a development key and labelled as such. The tool refuses a folder inside the repository.
- `… sign --key <release_signing_key.pem> --bin firmware.bin` signs `torqva-fw|1|<version>|<size>|<sha256>|esp32s3`, prints the base64 signature and writes `firmware.bin.sig`.
- Backend: `TORQVA_OTA_PUBLIC_KEY=<release_public_key.pem>`. Device: the same public key compiled in (section 2).
- The private key is never in the repository, the frontend, an API response or the backend's configuration. `*.pem`, `src/ota_pubkey.h` and `backend/data/firmware/` are git-ignored. Tests generate their keys at run time.
- SHA-256 is integrity only. Authenticity is the signature, checked twice: by the backend at upload and by the device against its compiled-in key before it downloads the image.
- **Without a key** the firmware build reports `ota_info.cap = 0, why = NO_SIGNING_KEY` and refuses every OTA request; the backend without `TORQVA_OTA_PUBLIC_KEY` stores uploads with signature `UNAVAILABLE` and never as deployable. Neither half can be mistaken for production-approved. The page shows "Update capability: not configured: NO_SIGNING_KEY" and the release's signature check as UNAVAILABLE.

**Checked on the real compiled image (4 Nov, backend verifier, development key outside the repository):** correct key accepted; a fresh wrong P-256 key rejected; one flipped byte rejected by the image checksum and by the signature; no configured key = verification unavailable, nothing accepted. A scan of git (index and tree), `frontend/dist` and the backend found no private-key material. The only match is `provision_ota.py` refusing a CA file that contains one. The device-side mbedTLS check has **not** run on hardware.

## 7. Wi-Fi and HTTPS provisioning

`backend/tools/provision_ota.py --ssid … --base-url https://<host the device can reach> --ca <ca.pem> --out-dir …` (the password is prompted) writes NVS namespace `torqva_ota`: `ssid`, `pass`, `base`, `ca`. The firmware refuses a base URL that is not `https://`, or that is `localhost` / `127.x` / `::1` (`NO_HTTPS_BASE_URL`), and refuses a missing CA (`NO_CA_CERT`). TLS is verified with that CA (`WiFiClientSecure::setCACert`); verification is never disabled. Wi-Fi is switched on only during an update.

Backend side: `TORQVA_OTA_PUBLIC_BASE_URL` must name the same HTTPS address, and the two device-facing routes must be served over TLS there (a TLS-terminating reverse proxy, or uvicorn with `--ssl-keyfile/--ssl-certfile`). The backend refuses deployments while that URL is missing, plain HTTP or localhost.

## 8. Backend storage

`TORQVA_FIRMWARE_DIR` (default `backend/data/firmware`): `images/<sha256>.bin` (atomic write, checked against its hash on every read), `releases.json` (atomic write; an unreadable index blocks uploads and deployments and is never overwritten), `history.jsonl` (append-only, fsync'd). Release records are immutable. **Retention:** the application deletes nothing; an administrator removes a release by hand (stop the backend, delete the image and its index entry). Deployments in progress and download tokens live in memory: a backend restart forgets an in-flight deployment (its history lines remain) and invalidates its token.

## 9. Upload

Admin only. Drag a `.bin` (or browse). The page checks the extension, size and the first header bytes for an early answer. The backend then checks, each with its own status:
- image structure (magic, segments, checksum byte, appended SHA-256);
- ESP32-S3 chip id;
- partition fit;
- SHA-256;
- signature.

Wrong-chip and badly signed images are stored as **NOT DEPLOYABLE**. Empty, oversized, non-image, truncated, corrupt, unidentifiable, version-mismatched and duplicate uploads are refused. Uploads are rate-limited (10 per minute) and audited.

## 10. Deployment

Admin only, one at a time, at most one per device per minute, audited. **Update Firmware** stays disabled until every check passes:

- **Backend checks:**
  - storage OK;
  - HTTPS device URL set;
  - signature verification available;
  - device connected with an authenticated session (proves identity with the per-device key) and the expected id;
  - device reports OTA capability and no blocker;
  - no latched trip, drive idle;
  - release deployable, fits the device's slot and is newer than the installed version.
- **Then the administrator:**
  - ticks "the motor power stage is physically disconnected";
  - types `INSTALL <version> ON <device>`;
  - confirms a second time.
- **The device re-checks on its own, in `Device::ota_block_reason`:**
  - OTA-capable, not busy, not unconfirmed;
  - fresh telemetry;
  - no latched trip, no test running;
  - drive idle with zero duty and outputs off;
  - Hall speed **valid** and zero with no recent pulse (an unavailable speed is never taken as zero);
  - motor supply voltage **valid** and below 1 V.

While an update runs the device refuses START, SET_SPEED and RUN_TEST (`OTA_IN_PROGRESS`; STOP always works) and holds the outputs off. A new image refuses motion until its self-test confirms it (`OTA_PENDING_VERIFY`). The OTA code never writes a motor output.

The page shows the stages from the device's own reports: preparing, Wi-Fi, downloading (bytes actually written), verifying, installing, rebooting, reconnecting, self-tests, confirming. When the USB link drops for the restart, the page shows **WAITING FOR DEVICE RECONNECTION**, not a failure.

## 11. Rollback

The new image boots `PENDING_VERIFY`; `verifyRollbackLater()` stops the Arduino core from confirming it by itself. The self-test confirms only if every check passes:
- the device initialised;
- the outputs read as off;
- no latched trip;
- the task watchdog is registered;
- the E-stop input has been read;
- the INA219 and a DS18B20 answered;
- the device id and authentication key are provisioned;
- OTA is still configured;
- the backend re-established the authenticated session within 120 s.

A failure reports `ROLLBACK <reason>`, then `esp_ota_mark_app_invalid_rollback_and_reboot()`. A crash or reset before confirmation also returns to the previous image (bootloader). The previous image then reports `ota_info.last = ROLLED_BACK`, and the page shows **Update rolled back**. Only a device `CONFIRMED` report for the target version is shown as **Update successful**, and only once the deployment has reached its restart (`READY` or later). A boot report seen earlier, whether a stale frame or a board already running that version, is ignored.

**Protocol.** `ota` and `ota_info` frames carry `seq` and `ts` like every other device frame, and they count in the device's one gapless sequence. The bridge drops duplicates before the Firmware Manager sees them and counts gaps as usual. They are a type of their own, so they can never be read as a command `ack`. Progress frames must also name the active release.

## 12. Failure recovery

| Situation | What happens |
|---|---|
| Failure before the new image is selected (Wi-Fi, server, signature, interrupted download, checksum, wrong chip, size, flash write) | Device reports `FAILED <reason>`. The partition write is aborted and the running image stays. |
| Device refuses the request | Device reports `REFUSED <reason>` (for example `MOTOR_TURNING`, `MOTOR_POWER_CONNECTED`, `BAD_MAC`). |
| No progress for 5 minutes before the restart | Backend marks the deployment `FAILED`. |
| No report within 15 minutes after the restart | Backend marks it `VERIFICATION PENDING` (never failed or successful). Check the device over USB. |
| A board left without a bootable image | Not expected: the running image is never erased. The initial USB installation (section 4) recovers any board. |

## 13. Security limitations

- **USB link:** not encrypted. It is authenticated with HMAC and replay protection, and valid only for a direct link to a controlled PC.
- **No hardware root of trust:** no Secure Boot and no flash encryption. Anyone with physical USB access can flash anything; the signature protects only the OTA path.
- **Downgrade protection** is software only (backend and firmware), not eFuse anti-rollback.
- **Download token:** sent in the URL query, over TLS. It is valid only for the active deployment's release, for 30 minutes, for up to 12 requests.
- **Wi-Fi password:** stored in NVS without NVS encryption.

## 14. Bench test procedure (real ESP32-S3, by a qualified person) — NOT YET PERFORMED

Nothing in this repository runs these steps, and none of them has been carried out. Record each result (pass/fail, the device's own report, time) in a bench log. Only that log counts as hardware validation.

**Preconditions, kept for the whole session:** the motor power stage is **physically disconnected** (motor supply unplugged at the connector, not just switched off), so the motor cannot turn. The board is on the bench PC's USB port. The backend runs with `TORQVA_OTA_PUBLIC_KEY`, `TORQVA_OTA_PUBLIC_BASE_URL` (HTTPS) and a TLS endpoint the board can reach. The private signing key stays on the signing machine.

| # | Step | How | Pass when |
|---|---|---|---|
| 1 | Initial USB installation of OTA-capable version N | Section 4: build with `src/ota_pubkey.h`, provision key + OTA NVS, `pio run -e esp32s3 -t upload` by hand, write NVS at 0x9000 | Board boots; serial shows `hello` with version N; page shows **OTA capable** |
| 2 | OTA partition verification | `esptool.py read_flash 0x8000 0xC00 pt.bin`, then `gen_esp32part.py pt.bin`; compare with section 5. Check `ota_info.run` and `psz` on the page | Table identical to section 5; running `ota_0`; inactive slot 3264 KB |
| 3 | Wi-Fi connection | Start a deployment of N+1 (step 5); watch the `WIFI` stage. Also try once with the access point off | Reaches `MANIFEST`. With the access point off: `FAILED WIFI_UNAVAILABLE`, N keeps running |
| 4 | HTTPS connectivity | Same run reaches `MANIFEST`. Repeat once with a wrong CA in NVS, and once with an `http://` base URL | Wrong CA: `FAILED SERVER_UNAVAILABLE`. `http://`: refused (`NO_HTTPS_BASE_URL`). TLS verification never disabled |
| 5 | Firmware release retrieval | Build N+1, sign, upload on the page; deploy with the confirmations | Upload: every check VERIFIED. Backend log shows one manifest and one image download with the deployment token |
| 6 | Device-side signature verification | Observed in the same run: `MANIFEST`, then `DOWNLOADING` | The device proceeds only after its own ECDSA check (a refusal would show `FAILED SIGNATURE_INVALID`) |
| 7 | Download and installation | Watch `DOWNLOADING` (bytes), `VERIFYING`, `READY` | Byte count reaches the image size; no `CHECKSUM_MISMATCH` |
| 8 | Reboot and reconnection | `REBOOTING`; the USB link drops and comes back | The page shows **WAITING FOR DEVICE RECONNECTION**, not a failure, then the authenticated session again |
| 9 | Version confirmation | `SELF_TEST`, then `CONFIRMED` | The page shows **Update successful** with N+1 from the device's own report; `ota_info.pend = 0`; START is still refused by the usual blockers (nothing was enabled) |
| 10 | Failed signature test | Upload a release signed with a different key: the backend stores it NOT DEPLOYABLE. For the device check, serve a manifest whose signature does not verify against the compiled-in key (test server only) | Backend: no Update action. Device: `FAILED SIGNATURE_INVALID`; the running image is unchanged |
| 11 | Interrupted download test | During `DOWNLOADING`, switch off the access point (or the server). Separately, cut board power during the download | `FAILED` with a reason, partition write aborted, N running. After the power cut, N boots and nothing is pending |
| 12 | Failed first-boot self-test and rollback | Deploy N+2 with one self-test input missing (for example the DS18B20 unplugged) | `ROLLBACK <reason>`, a restart, N+1 running again with `ota_info.last = ROLLED_BACK`; the page shows **Update rolled back** |

After every step: the outputs read as off, the motor power stage is still disconnected, and nothing in Device & Safety (commissioning, limits, enable state) changed. Stop the session at the first unexpected result.

## 15. Known limitations

- No board validation yet. The platform layer has only been compiled; mbedTLS signature checks, TLS and rollback have not run on hardware.
- `MOTOR_POWER_CONNECTED` assumes the INA219 measures the motor supply bus (as the firmware's supply interlock already does). A bench where it does not needs that assumption checked.
- The self-test needs the INA219 and a temperature sensor, so a bench without them rolls every update back by design.
- Only an application image is updated. Bootloader and partition table changes always need USB.
- One active deployment per backend process, and in-flight state is in memory.
- Upload progress is the browser's bytes sent; validation time on the backend is not shown as a percentage.
