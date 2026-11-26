# Final Firmware Manager acceptance audit

Date: 2026-11-26. Scope: software and simulated/mock verification only. No port was opened, firmware flashed, OTA installed or motor command issued.

## Acceptance verdict

The Firmware Manager lifecycle is accepted for the verified software scope, with physical deployment remaining unaccepted until the hardware checklist is completed. One deployment-safety defect found during this audit was fixed: a connected device whose drive state is absent/unknown is now ineligible for both OTA and USB flashing. Only an authoritative `drive == IDLE` report permits deployment.

The complete repository is not at a zero-failure acceptance state. Five backend tests expose one unresolved device-level motor start-interlock defect introduced by commit `8daee70`. The Firmware Manager did not introduce it and did not add restrictions to the normal motor command path.

## Five failing tests

| Test | Observation | Classification |
|---|---|---|
| `test_strict_firmware_refuses_motor_commands_until_both_commissioning_decisions_are_declared` | START is accepted without confirmed runtime limits; SET_SPEED is not stopped by the removed E-stop wiring gate. `8daee70` replaced `start_blocked_reason` with `nullptr` and removed corresponding native tests. | **Unresolved safety defect / genuine regression against current documented requirements.** The exact historical E-stop-wired prerequisite may require owner review, but accepting START without confirmed limits contradicts current security/control documentation. |
| `test_strict_firmware_start_requires_an_active_watchdog_and_then_runs_with_every_interlock_verified` | A strict device accepts START with `--no-wdt`. | **Unresolved safety defect / genuine regression.** Current hardware-readiness and OTA self-test documents still require an active watchdog. |
| `test_strict_firmware_refuses_motion_without_a_live_authenticated_session_even_when_everything_else_is_declared` | The no-session case is still rejected by session binding, but a session with transport not declared secure is accepted. | **Partially obsolete wording, but genuine defense-in-depth regression.** Live-session authentication survives; the separate compile-time transport declaration removed by `8daee70` no longer does. Current architecture still requires authenticated transport. |
| `test_every_frame_the_firmware_emits_passes_the_real_backend_validator_and_the_handshake_fields_are_present` | Frames remain valid and gapless, but status `blk` is empty instead of `LIMITS_NOT_APPROVED`. | **Genuine observability regression caused by the same safety defect.** An exact blocker string is not merely cosmetic because backend/UI readiness relies on device provenance. |
| `test_built_artifact_is_torqva_firmware_not_the_legacy_sketch` | The artifact is TORQVA and contains `NO_SECURE_SESSION`, but no longer contains `LIMITS_NOT_APPROVED`. | **Mixed assertion:** legacy-image identity checks pass; the missing blocker marker accurately detects the removed interlock. The assertion must not be weakened until the safety contract is resolved. |

`8daee70` explicitly removed `safety/interlock.*`, E-stop modules, `start_blocked_reason` logic and many native tests. It did not remove these higher-level FITL/bring-up contracts. Later/current README, control architecture, security audit and firmware-update documents continue to say device protections are independently enforced. Therefore the five failures are retained and reported, not deleted or relabelled as successful.

## Motor-control and deployment separation

- Firmware Manager changes do not modify `CommandValidator`, `SafetyMonitor`, `DriveController`, backend `SafetySupervisor`, motor APIs or command authorization.
- The only firmware source adjustment in this work removes a stale include for a header already deleted by `8daee70`; it adds no restriction.
- Normal motor operation and firmware deployment use separate gates. Deployment requires admin authority, signed/compatible artifact, authenticated device identity/session, fresh OTA capability, confirmed idle drive, compatible partition/profile and no active deployment.
- OTA itself independently refuses motion and holds outputs off while active; transfer completion is not deployment success.
- USB transfer completion remains `RECONNECTION_REQUIRED`; only authenticated reconnect with the expected firmware identity becomes `VERIFIED`.
- No Firmware Manager control commissions, starts, stops or changes motor limits.

## Workflow evidence

- Artifact SHA-256 deduplication and duplicate lookup: verified.
- A → B → A → C → B mocked deployments: verified, five independent records.
- Metadata, tags, favorites and archive persistence: verified across manager restart.
- Redeploy, reinstall and last-known-good selection: verified in software; physical result requires device confirmation.
- OTA state machine, signature/integrity/profile/partition checks and rollback reporting: covered by backend and native tests.
- USB architecture: fail-closed by default; software gates verified, physical esptool/reconnect not run.
- Isolated Docker compile: valid project succeeded; non-TORQVA identity rejected; cancellation covered.
- Diagnostics: bounded log controls and explicit UNAVAILABLE metrics verified.
- UI: 33/33 interaction checks and 48/48 workspace/viewport checks pass.

## Actual regression results

- Frontend: 285/285 pass.
- Focused Firmware Manager/backend/security: 78/78 pass.
- Firmware-native: 143/143 pass.
- Complete backend: 750 pass, five failures listed above.
- Production frontend build: pass.
- Supported target builds and isolated Docker build: pass from the recorded build audit.

## Remaining acceptance blockers

1. A safety owner must reconcile `8daee70` with the current documented motor-control contract. The device-level start gate and its native tests should be restored or the product requirements/docs explicitly revised through a safety review. Do not resolve this by weakening the five tests.
2. Complete the physical checklist before enabling USB flashing or OTA on a motor controller.
3. Verify device-native rollback, bootloader rollback, reconnect identity and resource metrics on the target ESP32-S3.

