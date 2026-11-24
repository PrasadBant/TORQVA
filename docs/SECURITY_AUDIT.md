# Wireless security audit (25 Nov 2026)

## Verified in source and host tests

- The production ESP32 build no longer embeds a development command key. It reads a 32-byte per-device key from NVS and enables authentication only when the key is present.
- Both USB and Wi-Fi input enter the device protocol. The raw USB path that directly set PWM or reset a trip was removed. The backend's environment and API paths that enabled direct/universal mode were removed or made fail closed.
- The backend admits one authoritative device transport. A production USB link cannot be displaced by an unauthenticated incoming Wi-Fi socket. Disconnecting USB permits a Wi-Fi connection; the latter must finish the authenticated handshake.
- The Wi-Fi socket uses TLS with the provisioned CA. Device commands retain session HMACs, sequence numbers and expiry; OTA downloads use a short-lived token. The token is not logged or persisted in the recovered deployment snapshot.
- OTA validates an ECDSA signature, SHA-256 digest, target chip, application image and available partition. The device rechecks stopped outputs, zero speed and absent motor supply before writing the inactive slot. STOP remains available.
- The backend and TLS gateway stream image bytes in bounded chunks. Failed/truncated transfers are rejected by the device.

## Limits

- The current build is not physically verified. No claim is made about the deployed board's secure boot, flash encryption, TLS performance or motor behavior.
- The website has no isolated source build service. Docker's daemon was unavailable during this work, so accepting and executing uploaded PlatformIO projects on the host would expose the host to arbitrary build scripts. Source compilation remains unavailable rather than silently running unsafe builds.
- A backend restart can recover deployment metadata but cannot resume an interrupted image download because the one-time token is deliberately invalidated. The last known state awaits the device's actual report.
- The pinned 8 MB partition table uses only part of the N16R8's flash. Changing it requires USB recovery and reprovisioning.
