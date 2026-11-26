# Known limitations

- Untrusted PlatformIO builds require Docker and the configured TORQVA build image. Host compilation is deliberately not used as a fallback.
- Monaco provides local C/C++ language support, but no external semantic C++ language server is bundled.
- ZIP projects are safely accepted by the compiler; expanding every imported ZIP file into the browser explorer is not yet implemented.
- USB flashing is disabled unless `TORQVA_USB_FLASH_ENABLED=1` and esptool are available. Hardware, partition offset and reconnect verification still require a supported ESP32-S3.
- Physical OTA, device-native rollback and automatic bootloader rollback remain hardware-verification items.
- Runtime min-heap, PSRAM, CPU utilization, packet loss and reset/watchdog details are shown as UNAVAILABLE unless the installed device protocol reports them.
- AI analysis requires an explicitly configured provider and operator consent to transmit the bounded, redacted context. No live provider was available for verification.
- Build history remains process-local; firmware releases and deployment history are persistent.
- Five legacy strict-interlock backend tests conflict with the repository's prior removal of those interlocks; see TEST_REPORT.md.

