# The five failing firmware-contract tests: investigation (not changed, not weakened)

Tests: `backend/tests/test_torqva_p14_contract.py` (3) and `backend/tests/test_torqva_p18_firmware_bringup.py` (2).

## Cause
They assert the old **strict interlock contract**: the firmware must refuse `START` with `LIMITS_NOT_APPROVED`, `ESTOP_NOT_DECLARED`, `WATCHDOG_NOT_ACTIVE`, `TRANSPORT_NOT_SECURED` or `NO_SECURE_SESSION`, report `blk == LIMITS_NOT_APPROVED`, and contain those strings in the built ELF. Commit `8daee70` ("Remove estop, interlocks, safety/blocker reports…") deleted `interlock.cpp/.h` and `estop.cpp/.h`, so `LIMITS_NOT_APPROVED` no longer exists anywhere in the source, and the firmware now answers `OK` to `START`. That commit removed the matching **native** tests (`test_core`, `test_device`) but not these backend tests.

## Evidence (clean checkouts built in throwaway worktrees)
| Checkout | Result |
|---|---|
| `cc74e3d` (before the removal) | 5 passed |
| `8daee70` (the removal, clean) | 4 failed, 1 skipped (`esp32s3_uart` cannot build) |
| working tree incl. the Wi-Fi work | 5 failed |

Not caused by the Wi-Fi provisioning work: the failures reproduce at a clean `8daee70`.

## Related finding
At committed `HEAD`, `esp32s3_uart` does not compile: `src/main.cpp` still includes the deleted `safety/estop.h`. The uncommitted working-tree change to `main.cpp` (one line removed) fixes it, so that change must be committed with the removal.

## Decision needed (not taken here)
Either (a) the direct-control direction is final: retire or rewrite these five tests to the new contract with the owner's sign-off; or (b) the interlocks should return. Neither is done here: deleting or loosening these tests, or re-adding restrictions, is out of scope.
