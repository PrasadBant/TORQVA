# TORQVA documentation

Start with the repository [`README.md`](../README.md) for running, testing and the code layout. [`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md) is a one-file summary of the whole project (purpose, hardware, architecture, status, open issues), written to be shared as context.

## Status and readiness
| Document | Contents |
|---|---|
| [`TORQVA_GAP_AUDIT.md`](TORQVA_GAP_AUDIT.md) | Evidence-based status of every requirement (DONE / PARTIAL / OPEN) |
| [`TORQVA_HARDWARE_READINESS.md`](TORQVA_HARDWARE_READINESS.md) | Firmware and integration readiness; what still blocks physical operation |
| [`TORQVA_PROGRESS.md`](TORQVA_PROGRESS.md) | Phase-by-phase progress log |
| [`TORQVA_SECURITY_AUDIT.md`](TORQVA_SECURITY_AUDIT.md) | Security, reliability and safety audit of the software |

## Architecture and software
| Document | Contents |
|---|---|
| [`TORQVA_ARCHITECTURE.md`](TORQVA_ARCHITECTURE.md) | Architecture: firmware, backend layers C1–C6, API, UI |
| [`software.md`](software.md) | Software overview and firmware build guide |
| [`TORQVA_EVAL_SIM.md`](TORQVA_EVAL_SIM.md) | Simulation evaluation method and results (simulation only, not hardware evidence) |
| [`eval/`](eval) | Committed evaluation artifacts. **Read at runtime** by `backend/torqva/api.py` and written by the `*_study.py` modules, so the folder must stay at `docs/eval/` |

## Hardware
| Document | Contents |
|---|---|
| [`hardware.md`](hardware.md) | Hardware specification and pin-out |
| [`HARDWARE_WIRING.md`](HARDWARE_WIRING.md) | Wiring and bench safety specification |
| [`TORQVA_WIRING.md`](TORQVA_WIRING.md) | Wiring draft awaiting human confirmation |
| [`TORQVA_ESTOP.md`](TORQVA_ESTOP.md) | E-stop design (not installed, not verified) |
| [`TORQVA_HARDWARE_BRINGUP_CHECKLIST.md`](TORQVA_HARDWARE_BRINGUP_CHECKLIST.md) | Operator bring-up checklist |

## History
[`history/`](history) holds retired documents from the earlier `smart-motor-monitor` prototype. They are kept as a record and do not describe the current system.
