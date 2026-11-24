# Performance measurements (25 Nov 2026)

| Measurement | Observed result | Method |
|---|---:|---|
| ESP32-S3 wireless application flash use | 989,497 / 3,342,336 bytes (29.6%) | PlatformIO build output for `esp32s3_wireless` |
| Static RAM use | 54,984 / 327,680 bytes (16.8%) | PlatformIO build output |
| Clean local wireless build | 49.46 s | PlatformIO elapsed time on this Windows host after security corrections |
| Frontend production build | 5.52 s | Final Vite build output on this host |
| Frontend tests | 282 passed in 21.13 s | Vitest output on this host |

The OTA backend now verifies files with a 256 KiB read buffer and streams responses. The TLS gateway forwards at most 64 KiB per read. These are code buffer sizes, not measured end-to-end throughput. No ESP32 Wi-Fi latency, telemetry rate, flash-write rate, reconnect time, PSRAM use or physical motor performance was measured in this work. No before/after hardware benchmark is claimed.
