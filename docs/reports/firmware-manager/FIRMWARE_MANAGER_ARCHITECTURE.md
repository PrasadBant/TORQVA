# Firmware Manager architecture

Artifacts are immutable SHA-256-addressed binaries. Releases reference artifacts and retain signed metadata. Deployment records are independent attempts tied to a release, device, operator and transport. Existing legacy release IDs migrate without alteration; `artifacts.json` is generated atomically from stored release checksums.

Deployment authority remains backend- and device-enforced. A transfer is not success: only the expected device-reported firmware identity after restart and self-test reaches `CONFIRMED`.
