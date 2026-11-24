# Wireless audit: defects and fixes (25 Nov 2026)

| Defect found | Change | Verification |
|---|---|---|
| Production firmware forbade `TORQVA_WIFI_LINK` at compile time. | Added `esp32s3_wireless` and removed the compile guard. | PlatformIO production wireless build succeeds. |
| Raw USB `START` and speed strings directly set PWM, bypassing authenticated commands and the device's fault checks. Raw `RESET_ESTOP` text toggled a reset flag. | Removed that path; USB lines now enter `Device::on_line`, as Wi-Fi lines do. | Code audit and firmware build; physical motor test pending. |
| Production firmware set `auth_enabled=false`, `relaxed_interlocks=true`, and widened the motor limits to 20,000 RPM / 100% duty. | Load the 32-byte per-device authentication key from NVS, enable authentication only when present, restore the configured control and limit flags, disable relaxed interlocks, and retain the normal motor limits. | Corrected production wireless build succeeds; physical verification pending. |
| Backend startup flags and a viewer API route could enable direct/universal mode and fabricate a connection. | Removed the route and startup flags; attempts to enable either mode now raise. | Backend regression tests check refusal and disconnected state. |
| Serial connect returned a synthetic connected status. | Removed the synthetic frame. | Backend tests; device handshake remains required. |
| Firmware image route and TLS gateway loaded the whole binary into memory. | Checksum is read in bounded chunks, then `FileResponse` and the gateway stream the image. | Firmware route tests and Python compilation pass; physical throughput pending. |
| Deployment status disappeared after backend restart. | Persist a secret-free current deployment snapshot and recover it as awaiting device result; old download tokens cannot be reused. | Backend restart regression test passes. |
| Firmware Manager said Wi-Fi was only used during an update. | Display the bridge's actual current transport and remote address. | Frontend build and tests pass. |

Open defects and missing features are listed in [WIRELESS_ARCHITECTURE.md](WIRELESS_ARCHITECTURE.md). These fixes have not been physically flashed or tested on the target board.
