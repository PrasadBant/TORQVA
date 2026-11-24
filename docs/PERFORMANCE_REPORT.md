# Performance measurements (25 Nov 2026)

| Measurement | Observed result | Method |
|---|---:|---|
| ESP32-S3 wireless image flash use (`esp32s3_wireless`) | `1,021,221 / 3,342,336` bytes (`30.6%`) | PlatformIO ELF/BIN size check (`firmware.bin`: `1,021,584 B`) |
| ESP32-S3 wireless static RAM use | `57,048 / 327,680` bytes (`17.4%`) | PlatformIO size check |
| ESP32-S3 UART clean build (`esp32s3_uart`) | `65.52 s` | `pio run -e esp32s3_uart` elapsed time on host |
| Isolated Docker `--network none` `.ino` build (`torqva-pio:latest`) | `79.0 s` (`pio run`: `77.34 s`) | `FirmwareCompiler` end-to-end compile inside 2 vCPU / 2 GiB RAM container |
| Frontend production bundle (`vite build`) | `11.10 s` | Vite build output (`firmware-D2wO51ce.js`: `21.33 kB` / `7.51 kB` gzip) |
| Frontend Vitest suite | `49.84 s` | `285` tests in `29` files (`npx vitest run`) |
| Firmware native test suite | `13.134 s` | `166` cases across `4` native suites (`pio test -e native`) |
| Complete backend pytest suite | `209.78 s` | `794 passed, 0 skipped` (`pytest backend/tests/ -rs -q`) |

## Performance & responsiveness optimizations applied

- **`FirmwareStore` deployment indexing (`backend/torqva/firmware.py`)**: `save_current()` limits full `deployments.json` atomic writes to deployment creation (`REQUESTED`) and terminal/stage transitions rather than re-reading and fsyncing full deployment history on every byte-progress frame during `DOWNLOADING`.
- **HTTP Range resumable OTA downloads (`backend/torqva/firmware_routes.py`, `esp32/torqva_fw/src/ota_esp32.cpp`)**: `GET /firmware/ota/{rid}/image` supports `Range: bytes=<start>-<end>` with `206 Partial Content` and `Accept-Ranges: bytes` so interrupted TLS downloads resume from the received byte offset.
- **Bounded chunks**: Image integrity verification uses 256 KiB buffers and TLS gateway streaming forwards bounded chunks.

No physical ESP32 Wi-Fi throughput, OTA flash write speed, reconnect time, or powered motor performance has been measured yet; those await physical verification on `COM7`.
