# Firmware upload and wireless compilation workflow

Firmware Manager (`#/firmware`) now supports two unified workflows:

## 1. Edit or upload source code and Compile & Upload Wirelessly

1. Open `#/firmware` and select a project template (`TORQVA Wireless Firmware`, `Custom Arduino (.ino) + TORQVA OTA Bridge`, or `TORQVA OTA LED Bench`), edit multi-file source directly in the embedded editor, or drag-and-drop `.ino`, `.cpp`, `.c`, `.h`, `.hpp`, `.zip`, or `.bin` files.
2. Click **Compile** or **Compile & Upload Wirelessly**.
3. The backend runs an isolated `--network none --read-only --cap-drop ALL` Docker (`torqva-pio:latest`) build, streams live build logs, reports compiler diagnostics and RAM/Flash utilization, validates ESP32-S3 image headers and TORQVA Wi-Fi/OTA retention, signs on the host when configured, registers the release, and deploys via HTTPS OTA to the connected device.
4. Track real-time OTA progress, persistent deployment history, and manual rollback from `#/firmware` and live wireless serial logs from `#/device`.

## 2. Upload pre-compiled signed `.bin` images

You may also sign externally with `scripts/build/sign_firmware.py sign` and upload `.bin` + `.sig` directly through the same **Compile / Upload** interface or `POST /api/torqva/firmware/releases`.
