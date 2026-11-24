# TORQVA wireless architecture and current limits

## Implemented path

`esp32s3_wireless` builds the production ESP32-S3 firmware with `TORQVA_WIFI_LINK=1`. The board reads Wi-Fi credentials, the backend HTTPS URL and a CA certificate from NVS. It connects outward to `/api/torqva/device/link` using a TLS WebSocket. FastAPI feeds that connection into the existing `DeviceBridge`, which carries the same protocol frames as USB. The bridge uses one authoritative transport. A per-device key and mutual challenge response establish the session; commands retain their HMAC, sequence and expiration checks. The device sends real sensor and OTA frames; disconnected or invalid readings remain unavailable.

The existing OTA receiver downloads a signed application image by HTTPS, checks its SHA-256 digest and ECDSA signature, writes the inactive OTA slot, restarts, and confirms or rolls back after its self-test. The backend and TLS gateway stream the image in bounded chunks after checking the short-lived deployment token and the stored checksum. It persists a secret-free current deployment snapshot; after a backend restart it waits for the device's actual outcome and does not reuse the expired download token. The firmware never accepts ordinary OTA writes to the bootloader or partition table.

The production USB link remains authoritative while attached. Disconnecting the USB data cable lets the outbound Wi-Fi link become authoritative. The LED-only bench profile may hand over from USB to Wi-Fi. A production handover before authenticating the incoming socket would let an unauthenticated network client disrupt an active USB session, so it is not enabled.

## Setup and recovery

1. Set up a device key and OTA signing keys using [TORQVA_OTA_FIRMWARE_MANAGER.md](TORQVA_OTA_FIRMWARE_MANAGER.md). Never use the checked-in development key for a deployed controller.
2. Provision NVS using `backend/tools/provision_device_key.py` and `backend/tools/provision_ota.py`, combining their output into one NVS image as those tools instruct. The HTTPS address must be reachable from the board and match the provisioned CA.
3. Build `esp32s3_wireless` with `python -m platformio run -e esp32s3_wireless` in `esp32/torqva_fw`. Install the first compatible image and NVS over USB with the motor power stage disconnected. This work has not performed that physical step.
4. Set `TORQVA_DEVICE_LINK=1`, `TORQVA_OTA_PUBLIC_BASE_URL` and `TORQVA_OTA_PUBLIC_KEY` on the backend, then run `backend/tools/ota_https_gateway.py` for device-facing TLS, or use the documented HTTPS reverse proxy. Run the website with `cd frontend && npm run dev`.
5. Power the board, disconnect its USB data cable, and wait for an authenticated Wi-Fi device link. Upload a signed compatible `.bin` in Firmware Manager and deploy while the motor power stage is isolated. The UI reports device-sent progress and confirmation.

USB recovery remains necessary if the board loses Wi-Fi provisioning or both OTA slots fail. Changing the partition table requires USB flashing and reprovisioning NVS.

## Not yet implemented

Automatic mDNS discovery, static IP configuration, Wi-Fi network switching from the website, website source upload and secure compilation, an embedded code editor, remote restart, wireless log search/download, resuming an interrupted image download after backend restart, manual downgrade, and physical hardware validation. No performance measurements from a real device are available.

The backend's old commissioning module is absent. With the unsafe direct-mode bypass removed, its current policy defaults to physical control disabled and does not send an approved limits configuration to the board. This preserves a fail-closed state but does not yet satisfy the required authorized wireless motor-control workflow. A real device-specific limits workflow must be integrated before claiming that feature works.
