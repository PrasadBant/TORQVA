# Unreleased wireless engineering changes (25 Nov 2026)

- Added a production ESP32-S3 Wi-Fi build profile using the existing TLS WebSocket device link and HTTPS OTA receiver.
- Removed raw USB text motor control and software reset bypasses. Production firmware now loads its per-device authentication key from NVS, retains default motor limits, and keeps its existing fault and session checks active.
- Removed backend direct/universal mode activation and synthetic connection reporting. Connection and firmware pages now use actual transport state.
- Simplified OTA deployment to one admin action after backend and device eligibility checks. The duplicated checkbox, typed phrase and second confirmation were removed.
- Streamed OTA images through FastAPI and the TLS gateway, and persisted a secret-free deployment snapshot for backend restart recovery.
- Added wireless setup, upload, recovery, architecture, API, security, performance, defect and test documentation.

The website still accepts signed compiled `.bin` releases only. Source compilation, network switching, a wireless log console, manual rollback and physical ESP32 verification remain open. No commit or push was made for this release note.
