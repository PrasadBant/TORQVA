# Wireless implementation test report (25 Nov 2026)

| Check | Result |
|---|---|
| `python -m platformio run -e esp32s3_wireless` | Passed after authentication and limit corrections; 989,497 / 3,342,336 flash bytes, 54,984 / 327,680 static RAM bytes; 49.46 s build on this host. |
| `python -m platformio test -e native` | Passed; 166 / 166 cases. |
| `cd frontend && npm run build` | Passed. |
| `cd frontend && npm test` | Passed; 282 / 282 tests in 28 files. |
| Focused backend device link, OTA, route, persistence and bypass tests | Passed; 79 / 79. |
| Complete backend suite | Passed after correcting outdated environment, key and readiness assertions: 758 passed, 30 skipped in 186.47 s. |
| Physical LED-only wireless OTA | Not run in this work. |
| Production firmware with motor power disconnected | Not run in this work. |
| Powered motor operation over Wi-Fi | Not run. |

Authorized motor control is not currently available through the backend because the previous direct-mode bypass was removed and no replacement device-specific limits configuration is installed. This is an open functional gap, not a test pass.

The build time and image sizes are host tool outputs, not measured Wi-Fi latency, transfer throughput or motor performance. No real ESP32 was connected during this work. Simulation and in-memory transport tests are not physical hardware verification.
