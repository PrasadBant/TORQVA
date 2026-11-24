# Firmware upload workflow available today

The current Firmware Manager accepts signed ESP32-S3 application `.bin` images. Website upload of `.ino`, `.cpp`, headers and PlatformIO ZIP projects, compilation, and an embedded source editor are not yet implemented. Those files must be built in a trusted development environment. An arbitrary sketch must not be deployed as normal TORQVA firmware because it can remove the OTA receiver, device protocol or motor protections.

## Build and sign a compatible application

1. Run `python backend/tools/sign_firmware.py keygen --out-dir <private_directory_outside_repo>` once to create the release-signing key pair. Keep the private key outside the repository.
2. Run `python backend/tools/sign_firmware.py export-header --pub <private_dir>/release_public_key.pem` to generate the ignored device public-key header.
3. From `esp32/torqva_fw`, run `python -m platformio run -e esp32s3_wireless`. The application image is `.pio/build/esp32s3_wireless/firmware.bin` and must fit the board's inactive OTA slot.
4. Run `python backend/tools/sign_firmware.py sign --key <private_dir>/release_signing_key.pem --bin esp32/torqva_fw/.pio/build/esp32s3_wireless/firmware.bin`. The tool writes a `.sig` alongside the binary. The key passphrase is prompted for securely.

## Upload and deploy

1. Start the TORQVA backend, the device-facing TLS gateway and the website. The board must report a connected, authenticated Wi-Fi link and OTA capability.
2. Open `#/firmware`, choose the `.bin` and its `.sig`, then select **Upload and validate**. The backend checks image structure, ESP32-S3 chip ID, embedded firmware identity, size, SHA-256 and ECDSA signature. An upload alone never flashes the device.
3. Select the release and choose **Upload wirelessly**. The backend requires the admin role and a compatible, authenticated, idle device. The device independently requires zero speed, outputs off and measured motor supply below 1 V before downloading and writing flash. It refuses motion during OTA.
4. Watch the device-reported bytes and lifecycle. Success is shown only after the new image reboots, reconnects and reports its self-test confirmation. A failed self-test triggers the existing rollback path.

No production hardware upload, LED-only bench upload, physical rollback or powered motor operation was performed in the 25 Nov 2026 implementation work. See [TEST_REPORT.md](TEST_REPORT.md) for software verification and [TORQVA_OTA_FIRMWARE_MANAGER.md](TORQVA_OTA_FIRMWARE_MANAGER.md) for the existing OTA protocol.
