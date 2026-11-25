# TORQVA repository reorganization

## Before

```text
backend/torqva/          Flat package for API, control, data, roles and studies
backend/tools/           Board setup, gateway and signing scripts
frontend/src/torqva/     App, physical and simulated pages, mixed shared code
frontend/scripts/        Development launcher and source-text check
esp32/torqva_fw/         PlatformIO project and flat firmware core
docs/                    Mixed current documentation, reports and historical material
```

## After

```text
frontend/src/            app, access, control, device, telemetry, safety, pages, components, shared
backend/torqva/          api, control, device, telemetry, safety, access, models, shared, legacy,
                         analysis, research, simulation
firmware/                ESP32 board source, domain-based reusable C++ core, tests and FITL
config/                  Defaults and control, safety and device configuration ownership
scripts/                 setup, build, development, test
tests/                   System verification index and hardware acceptance
docs/                    architecture, hardware, testing, reports, eval, history
```

[Repository structure](docs/architecture/REPOSITORY_STRUCTURE.md)
[Control and telemetry trace](docs/architecture/CONTROL_ARCHITECTURE.md)
[Safety and access inventory](docs/SAFETY_INVENTORY.md)

## Changes and cleanup

- Moved **196 files** using in-place renames. The backend router also changed basename from `api.py` to `routes.py`. The path map below records each move.
- Removed **0 source files**. Ownership splits placed extracted functions and classes in their owning domains. Removed two unused legacy attestation helpers from the bridge after checking callers.
- Removed the duplicate Python defaults table. The tracked JSON in `config/defaults/` seeds local runtime limits. Existing runtime settings and firmware-local hardware limits retain their separate roles.
- Compared hashes of Python, C++, JavaScript and JSX across the runtime domains. The audit found no byte-identical source groups to delete. The retained older secure gateway and simulator have distinct contracts and tests.
- Removed **1,455 generated PlatformIO files** from the retired firmware tree and two bytecode caches from retired source folders. Also cleared 349 verification artifacts and Python cache files. The active build tree, local dependencies and running service logs remain ignored.
- Repaired Python imports and fixture targets, frontend relative imports and static guards, PlatformIO includes and library discovery, firmware editor scaffold paths, CLI entry points and Markdown links. `TORQVA_VITE_PROXY_TARGET` lets browser tests isolate their backend from the active rig.
- Kept pytest, Vitest, Playwright and PlatformIO tests in the locations matched to their toolchains. Removed no suites. Added the system and hardware verification index under `tests/`.

## Safety, direct control and legacy systems

Normal commands use `frontend/src/control/` and `backend/torqva/control/`. The physical bridge owns transport and correlation. `firmware/lib/torqva_core/control/` owns command validation and drive output logic. The board's pin writes, startup and sensor acquisition run in `firmware/src/main.cpp`.

The protection code remains in `firmware/lib/torqva_core/safety/`. Backend readiness, input limits and roles use `backend/torqva/safety/` and `access/`. The firmware E-stop, driver shutdown, watchdog and heartbeat behavior are preserved. Proposal workflows and the older transport are in `legacy/`. Direct Manual Control still uses operator authorization and live device prerequisites.

## Verification

| Verification | Before the migration | After the migration |
| --- | --- | --- |
| Backend and integration | 795 passed | 795 passed |
| Frontend | 285 passed | 285 passed |
| Native firmware | 168 passed | 168 passed |
| Browser E2E | Prior report recorded ten scripts | 10 scripts, 342 checks passed on isolated software-only servers |
| Frontend production build | Passed | Passed |
| ESP32 and FITL profiles | Prior report recorded successful builds | All eight built, including USB CDC, UART, Wi-Fi, FITL and four LED bench profiles |

The manual sign-in browser group passed using the production preview after the development server exited on the first attempt. The Vite build reports the existing large 3D viewport chunk. Native firmware reports an existing member initialization-order warning. Arduino's OneWire dependency reports preprocessor warnings. Test infrastructure reports React act and Starlette TestClient deprecation warnings. The source audit resolved all internal Python module paths and found that the firmware safety files differ from their original versions only in header include paths.

## Physical verification

The restructuring verification uses source inspection, automated tests, compiled images and firmware-in-the-loop execution. COM7's physical ESP32 handshake, authenticated UART telemetry and configuration confirmation were verified on the previously flashed image before the migration. Verification of a freshly built image on the board, physical Wi-Fi, the independent E-stop and powered motor motion remains pending. A read-only check after moving the source confirmed that the existing deployment still reports RIG-1 connected on COM7, fresh telemetry, IDLE, and the unverified E-stop condition.

## File move register

| Previous path | Current path |
| --- | --- |
| `DIRECT_CONTROL_REPORT.md` | `docs/reports/DIRECT_CONTROL_REPORT.md` |
| `backend/data/device_config.json` | `config/defaults/device_config.json` |
| `backend/tools/ota_https_gateway.py` | `scripts/development/ota_https_gateway.py` |
| `backend/tools/provision_device_key.py` | `scripts/setup/provision_device_key.py` |
| `backend/tools/provision_ota.py` | `scripts/setup/provision_ota.py` |
| `backend/tools/provision_wireless.py` | `scripts/setup/provision_wireless.py` |
| `backend/tools/sign_firmware.py` | `scripts/build/sign_firmware.py` |
| `backend/torqva/api.py` | `backend/torqva/api/routes.py` |
| `backend/torqva/attestation.py` | `backend/torqva/analysis/attestation.py` |
| `backend/torqva/auth.py` | `backend/torqva/access/auth.py` |
| `backend/torqva/autoconnect.py` | `backend/torqva/device/autoconnect.py` |
| `backend/torqva/c1_robust.py` | `backend/torqva/research/c1_robust.py` |
| `backend/torqva/c1_study.py` | `backend/torqva/research/c1_study.py` |
| `backend/torqva/c2_conditional.py` | `backend/torqva/research/c2_conditional.py` |
| `backend/torqva/c2_robust.py` | `backend/torqva/research/c2_robust.py` |
| `backend/torqva/c2c4_study.py` | `backend/torqva/research/c2c4_study.py` |
| `backend/torqva/c2cov_study.py` | `backend/torqva/research/c2cov_study.py` |
| `backend/torqva/c4_robust.py` | `backend/torqva/research/c4_robust.py` |
| `backend/torqva/c4cal_study.py` | `backend/torqva/research/c4cal_study.py` |
| `backend/torqva/compiler.py` | `backend/torqva/device/firmware/compiler.py` |
| `backend/torqva/decimation.py` | `backend/torqva/telemetry/decimation.py` |
| `backend/torqva/detection.py` | `backend/torqva/analysis/detection.py` |
| `backend/torqva/device_config.py` | `backend/torqva/safety/device_config.py` |
| `backend/torqva/device_keys.py` | `backend/torqva/access/device_keys.py` |
| `backend/torqva/device_link.py` | `backend/torqva/device/device_link.py` |
| `backend/torqva/device_protocol.py` | `backend/torqva/legacy/device_protocol.py` |
| `backend/torqva/device_routes.py` | `backend/torqva/api/device_routes.py` |
| `backend/torqva/device_transport.py` | `backend/torqva/legacy/device_transport.py` |
| `backend/torqva/diagnostics.py` | `backend/torqva/analysis/diagnostics.py` |
| `backend/torqva/discovery.py` | `backend/torqva/device/discovery.py` |
| `backend/torqva/dispatch.py` | `backend/torqva/legacy/dispatch.py` |
| `backend/torqva/evaluation.py` | `backend/torqva/analysis/evaluation.py` |
| `backend/torqva/firmware.py` | `backend/torqva/device/firmware/firmware.py` |
| `backend/torqva/firmware_routes.py` | `backend/torqva/api/firmware_routes.py` |
| `backend/torqva/gate.py` | `backend/torqva/legacy/gate.py` |
| `backend/torqva/generalization_study.py` | `backend/torqva/research/generalization_study.py` |
| `backend/torqva/hypotheses.py` | `backend/torqva/analysis/hypotheses.py` |
| `backend/torqva/incident.py` | `backend/torqva/analysis/incident.py` |
| `backend/torqva/investigation.py` | `backend/torqva/analysis/investigation.py` |
| `backend/torqva/lab.py` | `backend/torqva/analysis/lab.py` |
| `backend/torqva/learning.py` | `backend/torqva/analysis/learning.py` |
| `backend/torqva/limits_manager.py` | `backend/torqva/safety/limits_manager.py` |
| `backend/torqva/physical_adapter.py` | `backend/torqva/analysis/physical_adapter.py` |
| `backend/torqva/pipeline.py` | `backend/torqva/analysis/pipeline.py` |
| `backend/torqva/prediction.py` | `backend/torqva/analysis/prediction.py` |
| `backend/torqva/recording.py` | `backend/torqva/telemetry/recording.py` |
| `backend/torqva/recovery.py` | `backend/torqva/analysis/recovery.py` |
| `backend/torqva/report.py` | `backend/torqva/analysis/report.py` |
| `backend/torqva/scenarios.py` | `backend/torqva/simulation/scenarios.py` |
| `backend/torqva/schemas.py` | `backend/torqva/models/schemas.py` |
| `backend/torqva/serial_bridge.py` | `backend/torqva/device/serial_bridge.py` |
| `backend/torqva/sim.py` | `backend/torqva/simulation/sim.py` |
| `backend/torqva/simdevice.py` | `backend/torqva/simulation/simdevice.py` |
| `backend/torqva/store.py` | `backend/torqva/shared/store.py` |
| `backend/torqva/supervisor.py` | `backend/torqva/legacy/supervisor.py` |
| `backend/torqva/workbench.py` | `backend/torqva/analysis/workbench.py` |
| `backend/torqva/workflow.py` | `backend/torqva/legacy/workflow.py` |
| `docs/API_REFERENCE.md` | `docs/architecture/API_REFERENCE.md` |
| `docs/DEFECTS_AND_FIXES.md` | `docs/reports/DEFECTS_AND_FIXES.md` |
| `docs/FIRMWARE_RECOVERY_GUIDE.md` | `docs/hardware/FIRMWARE_RECOVERY_GUIDE.md` |
| `docs/FIRMWARE_UPLOAD_GUIDE.md` | `docs/hardware/FIRMWARE_UPLOAD_GUIDE.md` |
| `docs/HARDWARE_WIRING.md` | `docs/hardware/HARDWARE_WIRING.md` |
| `docs/OTA_IMPLEMENTATION_GUIDE.md` | `docs/hardware/OTA_IMPLEMENTATION_GUIDE.md` |
| `docs/PERFORMANCE_REPORT.md` | `docs/reports/PERFORMANCE_REPORT.md` |
| `docs/PROJECT_OVERVIEW.md` | `docs/architecture/PROJECT_OVERVIEW.md` |
| `docs/RELEASE_NOTES.md` | `docs/reports/RELEASE_NOTES.md` |
| `docs/SECURITY_AUDIT.md` | `docs/reports/SECURITY_AUDIT.md` |
| `docs/TEST_REPORT.md` | `docs/testing/TEST_REPORT.md` |
| `docs/TORQVA_ARCHITECTURE.md` | `docs/architecture/TORQVA_ARCHITECTURE.md` |
| `docs/TORQVA_ESTOP.md` | `docs/hardware/TORQVA_ESTOP.md` |
| `docs/TORQVA_EVAL_SIM.md` | `docs/testing/TORQVA_EVAL_SIM.md` |
| `docs/TORQVA_FIRMWARE_SAFETY_RESTORATION.md` | `docs/reports/TORQVA_FIRMWARE_SAFETY_RESTORATION.md` |
| `docs/TORQVA_GAP_AUDIT.md` | `docs/reports/TORQVA_GAP_AUDIT.md` |
| `docs/TORQVA_HARDWARE_BRINGUP_CHECKLIST.md` | `docs/hardware/TORQVA_HARDWARE_BRINGUP_CHECKLIST.md` |
| `docs/TORQVA_HARDWARE_READINESS.md` | `docs/hardware/TORQVA_HARDWARE_READINESS.md` |
| `docs/TORQVA_OTA_FIRMWARE_MANAGER.md` | `docs/hardware/TORQVA_OTA_FIRMWARE_MANAGER.md` |
| `docs/TORQVA_OTA_LED_BENCH_TEST.md` | `docs/testing/TORQVA_OTA_LED_BENCH_TEST.md` |
| `docs/TORQVA_PROGRESS.md` | `docs/reports/TORQVA_PROGRESS.md` |
| `docs/TORQVA_SECURITY_AUDIT.md` | `docs/reports/TORQVA_SECURITY_AUDIT.md` |
| `docs/TORQVA_UI_CONTENT_AUDIT.md` | `docs/reports/TORQVA_UI_CONTENT_AUDIT.md` |
| `docs/TORQVA_WIRING.md` | `docs/hardware/TORQVA_WIRING.md` |
| `docs/WIFI_SETUP_GUIDE.md` | `docs/hardware/WIFI_SETUP_GUIDE.md` |
| `docs/WIRELESS_ARCHITECTURE.md` | `docs/architecture/WIRELESS_ARCHITECTURE.md` |
| `docs/hardware.md` | `docs/hardware/hardware.md` |
| `docs/software.md` | `docs/architecture/software.md` |
| `esp32/README.md` | `firmware/README.md` |
| `esp32/torqva_fw/.gitignore` | `firmware/.gitignore` |
| `esp32/torqva_fw/lib/torqva_core/adxl345.cpp` | `firmware/lib/torqva_core/drivers/adxl345.cpp` |
| `esp32/torqva_fw/lib/torqva_core/adxl345.h` | `firmware/lib/torqva_core/drivers/adxl345.h` |
| `esp32/torqva_fw/lib/torqva_core/auth.cpp` | `firmware/lib/torqva_core/communication/auth.cpp` |
| `esp32/torqva_fw/lib/torqva_core/auth.h` | `firmware/lib/torqva_core/communication/auth.h` |
| `esp32/torqva_fw/lib/torqva_core/commands.cpp` | `firmware/lib/torqva_core/control/commands.cpp` |
| `esp32/torqva_fw/lib/torqva_core/commands.h` | `firmware/lib/torqva_core/control/commands.h` |
| `esp32/torqva_fw/lib/torqva_core/control.cpp` | `firmware/lib/torqva_core/control/control.cpp` |
| `esp32/torqva_fw/lib/torqva_core/control.h` | `firmware/lib/torqva_core/control/control.h` |
| `esp32/torqva_fw/lib/torqva_core/device.cpp` | `firmware/lib/torqva_core/shared/device.cpp` |
| `esp32/torqva_fw/lib/torqva_core/device.h` | `firmware/lib/torqva_core/shared/device.h` |
| `esp32/torqva_fw/lib/torqva_core/estop.cpp` | `firmware/lib/torqva_core/safety/estop.cpp` |
| `esp32/torqva_fw/lib/torqva_core/estop.h` | `firmware/lib/torqva_core/safety/estop.h` |
| `esp32/torqva_fw/lib/torqva_core/interlock.cpp` | `firmware/lib/torqva_core/safety/interlock.cpp` |
| `esp32/torqva_fw/lib/torqva_core/interlock.h` | `firmware/lib/torqva_core/safety/interlock.h` |
| `esp32/torqva_fw/lib/torqva_core/line_out.h` | `firmware/lib/torqva_core/communication/line_out.h` |
| `esp32/torqva_fw/lib/torqva_core/ota.cpp` | `firmware/lib/torqva_core/communication/ota.cpp` |
| `esp32/torqva_fw/lib/torqva_core/ota.h` | `firmware/lib/torqva_core/communication/ota.h` |
| `esp32/torqva_fw/lib/torqva_core/pinmap.h` | `firmware/lib/torqva_core/drivers/pinmap.h` |
| `esp32/torqva_fw/lib/torqva_core/protocol.cpp` | `firmware/lib/torqva_core/communication/protocol.cpp` |
| `esp32/torqva_fw/lib/torqva_core/protocol.h` | `firmware/lib/torqva_core/communication/protocol.h` |
| `esp32/torqva_fw/lib/torqva_core/runtime_config.cpp` | `firmware/lib/torqva_core/safety/runtime_config.cpp` |
| `esp32/torqva_fw/lib/torqva_core/runtime_config.h` | `firmware/lib/torqva_core/safety/runtime_config.h` |
| `esp32/torqva_fw/lib/torqva_core/safety.cpp` | `firmware/lib/torqva_core/safety/safety.cpp` |
| `esp32/torqva_fw/lib/torqva_core/safety.h` | `firmware/lib/torqva_core/safety/safety.h` |
| `esp32/torqva_fw/lib/torqva_core/sha256.cpp` | `firmware/lib/torqva_core/shared/sha256.cpp` |
| `esp32/torqva_fw/lib/torqva_core/sha256.h` | `firmware/lib/torqva_core/shared/sha256.h` |
| `esp32/torqva_fw/lib/torqva_core/simplant.cpp` | `firmware/lib/torqva_core/testing/simplant.cpp` |
| `esp32/torqva_fw/lib/torqva_core/simplant.h` | `firmware/lib/torqva_core/testing/simplant.h` |
| `esp32/torqva_fw/lib/torqva_core/testexec.cpp` | `firmware/lib/torqva_core/control/testexec.cpp` |
| `esp32/torqva_fw/lib/torqva_core/testexec.h` | `firmware/lib/torqva_core/control/testexec.h` |
| `esp32/torqva_fw/lib/torqva_core/torqva_limits.h` | `firmware/lib/torqva_core/safety/torqva_limits.h` |
| `esp32/torqva_fw/platformio.ini` | `firmware/platformio.ini` |
| `esp32/torqva_fw/src/config_pins.h` | `firmware/src/drivers/config_pins.h` |
| `esp32/torqva_fw/src/main.cpp` | `firmware/src/main.cpp` |
| `esp32/torqva_fw/src/ota_esp32.cpp` | `firmware/src/communication/ota_esp32.cpp` |
| `esp32/torqva_fw/src/ota_esp32.h` | `firmware/src/communication/ota_esp32.h` |
| `esp32/torqva_fw/src/ota_pubkey.h` | `firmware/src/ota_pubkey.h` |
| `esp32/torqva_fw/src/usb_out.cpp` | `firmware/src/communication/usb_out.cpp` |
| `esp32/torqva_fw/src/usb_out.h` | `firmware/src/communication/usb_out.h` |
| `esp32/torqva_fw/src/wifi_link.cpp` | `firmware/src/communication/wifi_link.cpp` |
| `esp32/torqva_fw/src/wifi_link.h` | `firmware/src/communication/wifi_link.h` |
| `esp32/torqva_fw/test/test_core/test_main.cpp` | `firmware/test/test_core/test_main.cpp` |
| `esp32/torqva_fw/test/test_device/test_main.cpp` | `firmware/test/test_device/test_main.cpp` |
| `esp32/torqva_fw/test/test_line_out/test_main.cpp` | `firmware/test/test_line_out/test_main.cpp` |
| `esp32/torqva_fw/test/test_ota/test_main.cpp` | `firmware/test/test_ota/test_main.cpp` |
| `esp32/torqva_fw/tools/fitl_cli.cpp` | `firmware/tools/fitl_cli.cpp` |
| `frontend/scripts/check-layer-ids.mjs` | `scripts/test/check-layer-ids.mjs` |
| `frontend/scripts/dev.mjs` | `scripts/development/dev.mjs` |
| `frontend/src/torqva/TorqvaApp.jsx` | `frontend/src/app/TorqvaApp.jsx` |
| `frontend/src/torqva/api.js` | `frontend/src/shared/api.js` |
| `frontend/src/torqva/physical/device.jsx` | `frontend/src/device/device.jsx` |
| `frontend/src/torqva/physical/diagnostics.jsx` | `frontend/src/pages/physical/diagnostics.jsx` |
| `frontend/src/torqva/physical/evaluation.jsx` | `frontend/src/pages/physical/evaluation.jsx` |
| `frontend/src/torqva/physical/firmware.jsx` | `frontend/src/device/firmware.jsx` |
| `frontend/src/torqva/physical/learning.jsx` | `frontend/src/pages/physical/learning.jsx` |
| `frontend/src/torqva/physical/physical.jsx` | `frontend/src/pages/physical/physical.jsx` |
| `frontend/src/torqva/physical/recovery.jsx` | `frontend/src/pages/physical/recovery.jsx` |
| `frontend/src/torqva/physical/twin.jsx` | `frontend/src/pages/physical/twin.jsx` |
| `frontend/src/torqva/physical/wirelessWorkspace.jsx` | `frontend/src/device/wirelessWorkspace.jsx` |
| `frontend/src/torqva/shared/alarmContext.jsx` | `frontend/src/safety/alarmContext.jsx` |
| `frontend/src/torqva/shared/alerts.jsx` | `frontend/src/safety/alerts.jsx` |
| `frontend/src/torqva/shared/charts.jsx` | `frontend/src/shared/charts.jsx` |
| `frontend/src/torqva/shared/components.jsx` | `frontend/src/components/components.jsx` |
| `frontend/src/torqva/shared/diagnostics.js` | `frontend/src/shared/diagnostics.js` |
| `frontend/src/torqva/shared/lazyCharts.jsx` | `frontend/src/shared/lazyCharts.jsx` |
| `frontend/src/torqva/shared/limits.jsx` | `frontend/src/safety/limits.jsx` |
| `frontend/src/torqva/shared/plain.js` | `frontend/src/shared/plain.js` |
| `frontend/src/torqva/shared/recording.jsx` | `frontend/src/shared/recording.jsx` |
| `frontend/src/torqva/shared/twin.jsx` | `frontend/src/shared/twin.jsx` |
| `frontend/src/torqva/shared/twin3d/assembly.js` | `frontend/src/shared/twin3d/assembly.js` |
| `frontend/src/torqva/shared/twin3d/engine.js` | `frontend/src/shared/twin3d/engine.js` |
| `frontend/src/torqva/shared/twin3d/overlay.js` | `frontend/src/shared/twin3d/overlay.js` |
| `frontend/src/torqva/shared/twin3d/quality.js` | `frontend/src/shared/twin3d/quality.js` |
| `frontend/src/torqva/shared/twin3d/support.js` | `frontend/src/shared/twin3d/support.js` |
| `frontend/src/torqva/shared/twin3d/viewport.jsx` | `frontend/src/shared/twin3d/viewport.jsx` |
| `frontend/src/torqva/shared/twinModel.jsx` | `frontend/src/shared/twinModel.jsx` |
| `frontend/src/torqva/shared/twinParts.js` | `frontend/src/shared/twinParts.js` |
| `frontend/src/torqva/shared/windows.jsx` | `frontend/src/shared/windows.jsx` |
| `frontend/src/torqva/simulation/adaptive.jsx` | `frontend/src/pages/simulation/adaptive.jsx` |
| `frontend/src/torqva/simulation/analysis.jsx` | `frontend/src/pages/simulation/analysis.jsx` |
| `frontend/src/torqva/simulation/assurance.jsx` | `frontend/src/pages/simulation/assurance.jsx` |
| `frontend/src/torqva/simulation/attestation.jsx` | `frontend/src/pages/simulation/attestation.jsx` |
| `frontend/src/torqva/simulation/c2c4.jsx` | `frontend/src/pages/simulation/c2c4.jsx` |
| `frontend/src/torqva/simulation/counterfactual.jsx` | `frontend/src/pages/simulation/counterfactual.jsx` |
| `frontend/src/torqva/simulation/diagnose.jsx` | `frontend/src/pages/simulation/diagnose.jsx` |
| `frontend/src/torqva/simulation/evaluation.jsx` | `frontend/src/pages/simulation/evaluation.jsx` |
| `frontend/src/torqva/simulation/events.jsx` | `frontend/src/pages/simulation/events.jsx` |
| `frontend/src/torqva/simulation/intervene.jsx` | `frontend/src/pages/simulation/intervene.jsx` |
| `frontend/src/torqva/simulation/journey.jsx` | `frontend/src/pages/simulation/journey.jsx` |
| `frontend/src/torqva/simulation/lab.jsx` | `frontend/src/pages/simulation/lab.jsx` |
| `frontend/src/torqva/simulation/overview.jsx` | `frontend/src/pages/simulation/overview.jsx` |
| `frontend/src/torqva/simulation/pages.jsx` | `frontend/src/pages/simulation/pages.jsx` |
| `frontend/src/torqva/simulation/pipeline.js` | `frontend/src/pages/simulation/pipeline.js` |
| `frontend/src/torqva/simulation/predict.jsx` | `frontend/src/pages/simulation/predict.jsx` |
| `frontend/src/torqva/simulation/receipts.jsx` | `frontend/src/pages/simulation/receipts.jsx` |
| `frontend/src/torqva/simulation/scenario.jsx` | `frontend/src/pages/simulation/scenario.jsx` |
| `frontend/src/torqva/simulation/simdata.js` | `frontend/src/pages/simulation/simdata.js` |
| `frontend/src/torqva/simulation/story.jsx` | `frontend/src/pages/simulation/story.jsx` |
| `frontend/src/torqva/simulation/tests.jsx` | `frontend/src/pages/simulation/tests.jsx` |
| `frontend/src/torqva/simulation/trace.jsx` | `frontend/src/pages/simulation/trace.jsx` |
| `frontend/src/torqva/simulation/twin.jsx` | `frontend/src/pages/simulation/twin.jsx` |
| `frontend/src/torqva/simulation/workbench.js` | `frontend/src/pages/simulation/workbench.js` |
| `frontend/src/torqva/styles/analysis.css` | `frontend/src/app/styles/analysis.css` |
| `frontend/src/torqva/styles/assurance.css` | `frontend/src/app/styles/assurance.css` |
| `frontend/src/torqva/styles/monitoring.css` | `frontend/src/app/styles/monitoring.css` |
| `frontend/src/torqva/styles/system.css` | `frontend/src/app/styles/system.css` |
| `frontend/src/torqva/styles/twin-sim.css` | `frontend/src/app/styles/twin-sim.css` |
| `frontend/src/torqva/torqva.css` | `frontend/src/app/torqva.css` |
| `frontend/src/torqva/workflow/workflow.jsx` | `frontend/src/pages/workflow/workflow.jsx` |
