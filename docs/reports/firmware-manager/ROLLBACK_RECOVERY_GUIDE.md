# Rollback and recovery guide

- **Redeploy saved release:** downloads a previously stored, still-trusted release through the normal validation path.
- **Previous OTA slot:** device-native partition switch, only where reported supported.
- **Automatic rollback:** bootloader/device response to a failed first-boot self-test.
- **USB recovery:** manual physical recovery when OTA is unavailable.

Last known good means a device-confirmed deployment, never the latest upload.
