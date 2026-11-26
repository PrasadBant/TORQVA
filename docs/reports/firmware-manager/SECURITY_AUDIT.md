# Security audit

Preserved controls: ECDSA P-256 verification, SHA-256 integrity, image/chip/profile/partition validation, authenticated device identity, one-time deployment downloads, HTTPS requirement, rate limits, motor-idle/device readiness checks and append-only activity history.

Duplicate reuse does not bypass any eligibility check. Unknown drive state now fails closed for OTA and USB; only an authoritative `IDLE` report is accepted. Secrets are not returned by firmware APIs. USB flashing remains opt-in and physically unverified. External AI source transmission remains disabled without provider configuration and explicit consent.

The separate device-level motor start-interlock regression from commit `8daee70` is documented in `FINAL_ACCEPTANCE_AUDIT.md`. It predates and is not bypassed or repaired by Firmware Manager deployment checks.
