# Test report

Test date: 2026-11-26. No physical flashing, OTA installation or motor operation was performed.

| Check | Actual result |
|---|---|
| Frontend production build | PASS — Vite, 2,939 modules, 28.69 s |
| Complete frontend suite | PASS — 285/285 tests across 29 files, 18.72 s isolated run |
| Focused firmware frontend suite | PASS — 18/18 |
| Focused firmware/backend/security suites | PASS — 78/78 after unknown-drive regression coverage, 40.25 s |
| Complete backend suite after firmware builds | 750 passed, 5 failed in 213.70 s |
| Firmware-native tests | PASS — 143/143, 8.45 s |
| PlatformIO compile: fitl | PASS — 2.06 s |
| PlatformIO compile: esp32s3 | PASS — 59.08 s; RAM 54,208 B (16.5%), flash 960,737 B (28.7%) |
| PlatformIO compile: esp32s3_uart | PASS — 59.25 s; RAM 54,400 B (16.6%), flash 974,597 B (29.2%) |
| PlatformIO compile: esp32s3_wireless | PASS — 56.35 s; RAM 57,280 B (17.5%), flash 1,022,577 B (30.6%) |
| Isolated Docker editor build | PASS — valid TORQVA workspace succeeded in 62.2 s; RAM 54,200 B, flash 960,249 B; artifact upload disabled |
| Isolated invalid editor build | PASS — compiled sketch rejected with actionable `NO_FIRMWARE_ID` in 37.72 s |
| Responsive browser audit | PASS — 48 workspace/viewport checks, zero horizontal overflow failures |
| Firmware Manager interaction audit | PASS — 33/33 checks across all eight workspaces |
| Physical USB/OTA | NOT RUN — explicit authorization and hardware required |
| Live AI provider | NOT RUN — provider infrastructure not configured |

The five complete-backend failures are classified individually in `FINAL_ACCEPTANCE_AUDIT.md`. Commit `8daee70` removed device start-interlock logic and native coverage while current product documentation still requires those protections. They remain unresolved safety/defense-in-depth regressions, not passing or blindly obsolete tests. Firmware Manager changes did not alter the normal motor command path.

