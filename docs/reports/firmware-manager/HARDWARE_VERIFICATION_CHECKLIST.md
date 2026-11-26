# Physical hardware acceptance checklist

Status: **NOT EXECUTED / NOT ACCEPTED**. Requires a named operator, safety reviewer and separate explicit authorization. Stop immediately on any unexpected result.

## Bench and electrical prerequisites

- [ ] Record ESP32-S3 board model, MAC/device identity, flash/PSRAM capacity and actual partition table.
- [ ] Verify wiring against the authoritative pin map; inspect for shorts, shared pins and incorrect voltage levels.
- [ ] Disconnect motor power and mechanically secure the motor/fixture before any firmware operation.
- [ ] Verify an independent, rated emergency power-removal circuit; software STOP is not a substitute.
- [ ] Verify driver EN default-low behavior during reset, boot, cable insertion and ESP32 power loss.
- [ ] Confirm supply, driver, shunt and sensor ratings against approved operating limits.
- [ ] Confirm watchdog configuration and reset behavior on the actual target.
- [ ] Resolve the `8daee70` start-interlock acceptance defect before authorizing motor operation.

## Identity, transport and ownership

- [ ] Connect exactly one supported board and confirm TORQVA reports the expected authenticated device ID.
- [ ] Confirm USB port ownership and that a second process/session cannot control or flash the port.
- [ ] Confirm Wi-Fi discovery does not establish trust until authenticated identity succeeds.
- [ ] Verify TLS CA, endpoint hostname/IP, session expiry and replay rejection without exposing secrets.
- [ ] Exercise USB ↔ Wi-Fi handover with the motor supply disconnected; confirm no conflicting session survives.

## Firmware library and compatibility

- [ ] Upload signed A and B releases; record release/artifact IDs and SHA-256 values.
- [ ] Re-upload A and confirm no second artifact is stored and no deployment starts automatically.
- [ ] Upload different bytes with the same filename and confirm independent binary identity.
- [ ] Confirm wrong chip, profile, partition size, signature, checksum and anti-rollback cases are refused.
- [ ] Confirm metadata edits survive a backend restart without altering signed artifact identity.

## USB flashing — motor power disconnected

- [ ] Explicitly enable the USB flasher only for the acceptance session and record operator authorization.
- [ ] Confirm unknown/non-idle drive state, mismatched device, wrong port and unsigned release all block before esptool.
- [ ] Flash a compatible signed release; confirm transfer completion is not displayed as VERIFIED.
- [ ] Reconnect through TORQVA authentication and confirm only the expected device/version reaches VERIFIED.
- [ ] Disconnect during transfer and verify failure/recovery guidance without false success.
- [ ] Perform USB recovery from an intentionally unavailable wireless path; preserve audit records.

## OTA and lifecycle — motor power disconnected

- [ ] Execute A → B → A → C → B → A using saved releases; verify one artifact per checksum and an independent deployment record per attempt.
- [ ] At each attempt verify SELECTED → VALIDATING → READY → TRANSFERRING → VERIFYING → RESTARTING → RECONNECTING → SELF-TEST → VERIFIED against device reports.
- [ ] Interrupt manifest/image transfer and confirm the running partition remains usable.
- [ ] Cause a controlled self-test failure and verify device-native/bootloader rollback reporting.
- [ ] Verify manual previous-release redeployment, current-version reinstall and last-known-good restoration as distinct mechanisms.
- [ ] Restart the backend between attempts and confirm release/deployment history persists and stale tokens cannot be reused.
- [ ] Confirm active firmware changes only after authenticated reconnect reports the expected identity.

## Diagnostics and operational isolation

- [ ] Verify USB and wireless logs remain ordered, bounded and free of keys/tokens/passwords.
- [ ] Generate a controlled restart/watchdog/crash record and verify accurate reason/provenance.
- [ ] Compare heap, minimum heap, PSRAM, flash, uptime and latency with device-native readings; unsupported values must remain UNAVAILABLE.
- [ ] Measure telemetry/control-loop timing with diagnostics off and on; confirm no material interference.
- [ ] Disconnect during log streaming and confirm UI/backend recovery without affecting motor ownership.

## Final authorization record

- [ ] Export firmware, deployment and security audit records and attach hashes/screenshots.
- [ ] Record every unresolved item, test operator, reviewer, device ID, release IDs and timestamps.
- [ ] Disable temporary USB-flash infrastructure after the session.
- [ ] Safety reviewer signs hardware acceptance separately from Firmware Manager software acceptance.
