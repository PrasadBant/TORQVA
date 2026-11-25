# TORQVA documentation

Start with the repository [`README.md`](../README.md) for running, testing and the code layout. [`PROJECT_OVERVIEW.md`](architecture/PROJECT_OVERVIEW.md) is a one-file summary of the whole project (purpose, hardware, architecture, status, open issues), written to be shared as context.

## Current architecture

- [Repository structure](architecture/REPOSITORY_STRUCTURE.md)
- [Direct motor control](architecture/CONTROL_ARCHITECTURE.md)
- [Safety and access inventory](SAFETY_INVENTORY.md)

## Status and readiness
| Document | Contents |
|---|---|
| [`TORQVA_GAP_AUDIT.md`](reports/TORQVA_GAP_AUDIT.md) | Evidence-based status of every requirement (DONE / PARTIAL / OPEN) |
| [`TORQVA_HARDWARE_READINESS.md`](hardware/TORQVA_HARDWARE_READINESS.md) | Firmware and integration readiness; what still blocks physical operation |
| [`TORQVA_PROGRESS.md`](reports/TORQVA_PROGRESS.md) | Phase-by-phase progress log |
| [`TORQVA_SECURITY_AUDIT.md`](reports/TORQVA_SECURITY_AUDIT.md) | Security, reliability and safety audit of the software |

## Architecture and software
| Document | Contents |
|---|---|
| [`TORQVA_ARCHITECTURE.md`](architecture/TORQVA_ARCHITECTURE.md) | Architecture: firmware, backend layers C1–C6, API, UI |
| [`software.md`](architecture/software.md) | Software overview and firmware build guide |
| [`TORQVA_EVAL_SIM.md`](testing/TORQVA_EVAL_SIM.md) | Simulation evaluation method and results (simulation only, not hardware evidence) |
| [`TORQVA_UI_CONTENT_AUDIT.md`](reports/TORQVA_UI_CONTENT_AUDIT.md) | Page-by-page UI content audit: what was removed, consolidated and kept, and why |
| [`TORQVA_OTA_FIRMWARE_MANAGER.md`](hardware/TORQVA_OTA_FIRMWARE_MANAGER.md) | Firmware Manager: signed ESP32-S3 OTA updates, partitions, signing, lifecycle, rollback, bench test procedure (not yet performed on hardware) |
| [`TORQVA_OTA_LED_BENCH_TEST.md`](testing/TORQVA_OTA_LED_BENCH_TEST.md) | LED-only OTA bench test on a real ESP32-S3 (no motor hardware): bench firmware profile, approval gates, results (1.0.0 → 1.1.0 → 1.1.1 performed), the 1.1.1 USB-serial regression and its 1.1.2 fix (hardware tests pending) |
| [`TORQVA_FIRMWARE_SAFETY_RESTORATION.md`](reports/TORQVA_FIRMWARE_SAFETY_RESTORATION.md) | Firmware safety protections restored from the `319fb7b` relaxation: evidence, tests, and why physical operation is still blocked |
| [`eval/`](eval) | Committed evaluation artifacts. **Read at runtime** by `backend/torqva/api/routes.py` and written by the `*_study.py` modules, so the folder must stay at `docs/eval/` |

## Hardware
| Document | Contents |
|---|---|
| [`hardware.md`](hardware/hardware.md) | Hardware specification and pin-out |
| [`HARDWARE_WIRING.md`](hardware/HARDWARE_WIRING.md) | Wiring and bench safety specification |
| [`TORQVA_WIRING.md`](hardware/TORQVA_WIRING.md) | Wiring draft awaiting human confirmation |
| [`TORQVA_ESTOP.md`](hardware/TORQVA_ESTOP.md) | E-stop design (not installed, not verified) |
| [`TORQVA_HARDWARE_BRINGUP_CHECKLIST.md`](hardware/TORQVA_HARDWARE_BRINGUP_CHECKLIST.md) | Operator bring-up checklist |

## History
[`history/`](history) holds retired documents from the earlier `smart-motor-monitor` prototype. They are kept as a record and do not describe the current system.
