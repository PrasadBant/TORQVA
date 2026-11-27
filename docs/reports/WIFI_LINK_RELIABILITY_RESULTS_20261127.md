# Wi-Fi link reliability: physical acceptance results, RIG-1, 27 Nov 2026

**Firmware accepted: 3.2.6** (signed with the dev-local release key the board already trusted; Firmware Manager release `21f38c57665e`, all 5 checks VERIFIED; flashed with the guarded USB flasher; identity verified over an authenticated session).

Conditions for every test:
- **Motor power was physically disconnected** throughout.
- **No motor command was sent.**
- Network: OnePlus 12 hotspot, 2.4 GHz. Laptop at 10.71.51.194; gateway certificate verified to cover it.

The design is in `WIFI_LINK_RELIABILITY.md`; the motor-safety items are in `MOTOR_SAFETY_OPEN_ITEMS.md`.

## 1. Confirmed root causes (each measured on the board)

| # | Defect | Evidence | Fix |
|---|---|---|---|
| 1 | **Wi-Fi driver panic when the saved network is absent.** The Arduino-ESP32 2.0.17 / ESP-IDF 4.4.7 driver faults inside its connect command (`cnx_sta_connect_cmd` → `scan_build_chan_list` / `clear_bss_queue`, `LoadStoreError`, bad pointer 0x40000000 / 0x40000008) on about the **8th consecutive connect that finds no AP**. | Panics captured and decoded on 3.2.0, 3.2.1, 3.2.2 and 3.2.3. Ruled out: power save (3.2.2), two callers racing (3.2.1), state carried across a full driver de-init (3.2.3), and gradual heap corruption (3.2.4 diagnostic: heap intact, watched object held valid pointers until the crash). | 3.2.5: no connect command is ever given for an absent network. A targeted scan comes first, and the connect is locked to the channel and BSSID the scan saw. |
| 2 | A send that couldn't take the WebSocket client's lock was treated as a dead link. | Drop at 14:38:53 on 3.2.1 while the socket was writable. | Retry the same message when the client is still connected (`lw` counter). |
| 3 | A TCP stall starting **during** a write aborted the link at the 1 s write budget. | 3.2.5 run: 33 stalls, longest 3.7 s, ended in a board "send failed, client aborted". | 3.2.6: 4 s write budget, still below the unchanged 8 s dead-link limit. In the final run, 2 writes took ≥ 1 s (max 1.83 s) and the link survived. |
| 4 | **Backend** watchdog closed healthy links at every ~10-minute session renewal. | 16:27:37: link 569.5 s old, closed by the backend ("no authenticated session"). | The deadline now applies to a continuous absence of a session. Verified: the renewal at ~10 min in the final run did not drop the link. |
| 5 | Scans made while connected always reported `SCAN_FAILED`. | Arduino's 20 × 120 ms guess expires before the driver finishes. | Results are read on the driver's own `SCAN_DONE`; 5 of 6 scans OK afterwards (one unexplained failure). |
| 6 | Earlier causes: modem sleep, Nagle, one TLS record per line, work done in the client callback, `LINK_BUSY` at admission. | See `WIFI_LINK_RELIABILITY.md`. | 3.2.0 design, kept. |

## 2. Before / after (measured windows with the hotspot up)

| | 3.0.1-dev (baseline) | 3.2.0 | 3.2.1 | **3.2.6** |
|---|---|---|---|---|
| Window | 15.0 min | 11.8 min | 14.2 min | **15.0 min** |
| Wi-Fi link drops | 9 | 8 | 3 real (+1 deliberate) | **0** |
| Median link life | 51 s | 35 s | 179 s | **one link, whole run (1011 s board uptime)** |
| Max send | 2864 ms | 1067 ms | 10 ms | 1830 ms (2 of 11,588 sends ≥ 1 s, link kept) |
| Sends < 20 ms | not reported | most | all | **11,580 / 11,588** |
| TCP stalls waited out | n/a | n/a | 17 | 15 (longest 0.9 s) |
| Telemetry dropped by the board | not reported | 5 | 0 | 21 (backpressure during stalls); 23 of 16,634 frames missing |
| Crash with the network absent | not tested | every ~15 s | every ~160 s | **none: 27 consecutive failed joins, 0 reboots (3.2.5 join code, unchanged in 3.2.6)** |

## 3. Acceptance tests

| Test | Result |
|---|---|
| Authenticated Wi-Fi standby while USB is connected | **PASS.** Key-proven standby link; the USB session was undisturbed (no SESSION_REPLACED). |
| USB → Wi-Fi handover (COM10 unplugged, power kept) | **PASS, first attempt.** Command session ready on Wi-Fi in **1.09 s**, same link, no reboot (3.2.1). |
| Absent network: ≥ 10 failed joins without reboot, then automatic reconnect | **PASS.** 27 failed joins, 0 reboots; back with an authenticated standby link 32 s after the network returned. Automated with a staged non-existent network; the committed network was never touched. |
| Cold boots, Wi-Fi only, no USB session | **PASS 8/8.** Chip resets through the EN line (board reports reset reason *power-on*): 5 on 3.2.5 (10.3–11.6 s to an authenticated Wi-Fi command session) and 3 on 3.2.6 (9.4–10.0 s), each on the boot's first link. |
| Cold boots from a power bank (power removed) | **NOT RUN.** It needs the board unplugged; the EN-reset boots are the same chip reset but don't cut the supply rail. |
| Non-actuating round trips | **PASS.** Heartbeat round trip throughout (final run: median 218 ms, p99 510 ms, max 821 ms); authenticated scan requests acknowledged and answered. 5 of 6 scans succeeded after the scan fix; one board-side failure is unexplained. |
| Backend + gateway restart | **PASS.** Re-authenticated 1.6 s after the restarted API answered (20 s outage). |
| Gateway-only restart | **PASS.** Loss detected in 0.2 s; re-authenticated 5.9 s after the gateway returned. |
| Hotspot restart | **PASS on 3.2.1** (manual outages; automatic rejoin). On 3.2.5/3.2.6 the absent-network path was verified automatically (above); a physical hotspot power-off was not repeated. |
| TCP stalls don't cause unnecessary disconnections | **PASS.** 15 stalls and 2 writes over 1 s in the final run, 0 drops. |
| **15-minute continuous stability (3.2.6, Wi-Fi only)** | **PASS.** 0 drops, 0 reboots, 0 session replacements (1 routine renewal, no drop), 0 USB attachments, telemetry fresh 99.89 %, command-ready 99.89 %, 0 duplicates, 0 restarts, 0 malformed, RSSI −33 to −74 dBm. |

## 4. Remaining defects and limitations

- **Cold boots cutting the power rail** were not run; EN-reset boots stand in for them.
- **A physical hotspot power-off was not repeated on 3.2.6.** The absent-network path is covered by the automated test. The mid-link AP-loss path (beacon timeout) was last exercised on 3.2.1.
- **The driver fault is not fixed inside Espressif's library.** 3.2.5 avoids the faulting call path, and the root cause is in a closed-source binary. Moving to Arduino-ESP32 3.x (IDF 5.x) would replace that driver, but it's a separate migration.
- **One scan in six failed** after the scan fix, reason not captured.
- **Telemetry backpressure under stalls:** 21 frames dropped by design (oldest telemetry first; acks are never dropped).
- **Every boot's first association is rejected once by the phone AP** ("authentication expired"); the one-time retry connects. This is inside the ~10 s.
- **Cosmetic:** readiness shows "communication failure" for 0.5 s during a handover. Its flap rule (3 drops in 120 s) also trips during deliberate rapid resets.
- **Native USB console after hot-plug:** the board's USB output did not resume after a cable hot-plug until the next reset (seen once).
- **The repository's `firmware/src/ota_pubkey.h` and the shell's `TORQVA_OTA_PUBLIC_KEY` point at keys the board does not trust.** Releases were built from an isolated copy with the dev-local key.
- **Motor safety** (direct-mode heartbeat timeout 0, four interlock test failures) is unresolved; see `MOTOR_SAFETY_OPEN_ITEMS.md`.

## 5. Regression tests (final code)

| Suite | Result |
|---|---|
| Backend | 865 passed, 4 failed (the pre-existing interlock tests), 1 skipped |
| Frontend | 315 / 315; production build OK |
| Firmware host tests | 160 / 160 |
| Firmware builds | `esp32s3_wireless`, `esp32s3_uart_wireless`, `esp32s3`, `fitl` all build |

## 6. Verdict

**Wireless acceptance: PASSED for every test that was run on hardware, with two items not run:** the power-rail cold boots and a physical hotspot power-off on 3.2.6. After a one-time Wi-Fi setup the board needed no further USB connection:
- it authenticates over Wi-Fi on its first link after every reset, in about 10 s;
- it survives an absent network indefinitely and rejoins by itself;
- it held one continuous authenticated link through the 15-minute run.

Powered motor testing stays blocked by `MOTOR_SAFETY_OPEN_ITEMS.md`.
