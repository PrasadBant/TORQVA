# Modified files

## Backend

- `backend/torqva/device/firmware/firmware.py` — metadata, reinstall intent, last-known-good derivation and runtime provenance.
- `backend/torqva/device/firmware/compiler.py` — safe cancellation and cancellation race guard.
- `backend/torqva/device/firmware/assistant.py` — consent-gated, redacted contextual AI provider integration.
- `backend/torqva/device/firmware/usb_flasher.py` — opt-in, safety-gated USB worker and reconnect verification.
- `backend/torqva/api/firmware_routes.py` — lifecycle, assistant, USB and cancellation APIs.
- `backend/tests/test_torqva_firmware.py`, `backend/tests/test_torqva_feature_audit.py`, `backend/tests/test_torqva_wireless_workspace.py` — lifecycle, authorization and build tests.

## Frontend

- `frontend/src/device/firmware.jsx` — library metadata, reinstall/LKG, USB, diagnostics and assistant integration.
- `frontend/src/device/wirelessWorkspace.jsx` — multi-file development workspace, build diagnostics and cancellation.
- `frontend/src/device/MonacoEditorLocal.jsx` — locally bundled lazy Monaco editor.
- `frontend/src/shared/api.js` — new Firmware Manager API calls.
- `frontend/package.json`, `frontend/package-lock.json` — Monaco and JSZip runtime dependencies.
- `frontend/src/tests/torqva_firmware.test.jsx`, `frontend/src/tests/torqva_wireless_workspace.test.jsx` — workspace regression coverage.
- `frontend/e2e/firmware-workstation-review.mjs` and `frontend/quality-review/firmware-workstation/*` — responsive audit and screenshots.

## Firmware and reports

- `firmware/src/main.cpp` — removed one stale include left after the referenced header was deleted; no safety/control logic changed.
- `docs/reports/firmware-manager/*` — updated architecture, testing, security and handover evidence.

No Digital Twin file was modified.

