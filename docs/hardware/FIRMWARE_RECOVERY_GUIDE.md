# Firmware recovery

## Wireless update failure

Firmware Manager shows device-reported OTA stages. A refused update leaves the running image in place. An interrupted download aborts the inactive-slot write; the previous slot remains bootable. A new image that fails its startup checks triggers rollback to the previous image. If the device has not reconnected, the backend reports verification pending rather than success.

Check the actual device status, firmware version and `ota_info.last` after reconnection. Do not infer a successful update from the HTTP upload, transferred byte count or browser page alone. A backend restart recovers the last deployment record, but its old download token cannot be reused; start a new deployment only after confirming the board's current firmware and OTA state.

## USB recovery

If Wi-Fi provisioning, the CA, or both OTA slots fail, use the board's USB data connection and the documented PlatformIO/`esptool` procedure. Keep the motor power stage disconnected during recovery. The firmware build must retain the TORQVA protocol, OTA receiver and matching signing public key. If the partition table or full flash is rewritten, regenerate and write the combined NVS image with the per-device authentication key and Wi-Fi settings at `0x9000` for the pinned table. The backend must hold the matching device key.

The present UI does not offer manual rollback to an older release; ordinary deployments require a newer compatible version. A physical recovery run has not been performed in this work.
