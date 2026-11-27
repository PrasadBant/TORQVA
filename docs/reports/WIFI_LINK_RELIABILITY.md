# Wi-Fi link reliability: causes, changes, and the bench procedure that verifies them

Status: **software changes are built and tested on the host. They have not been flashed or measured on RIG-1.** The bench procedure is in section 5. No acceptance target in section 6 is met until that run produces the numbers.

## 1. Evidence available before this change

| Source | What it shows |
|---|---|
| Bench notes behind commit 4e935bf | Every drop was reported by the board as "send failed or timed out", at a good signal (about -50 dBm). Single sends took up to about 840 ms. |
| Memory note *esp32s3-usb-cdc-blocks-loop* (5 Nov) | USB serial writes stalled `loop()` while the cable was plugged in and no host read the port. This is already fixed by `usb_out.cpp`, which drops lines instead of waiting. |
| Memory note *hotspot-profile-flips-public* | Each hotspot reconnect makes a new Windows profile, defaulting to Public. That blocks the Private-only TCP 8443 rule, and it looks like a device or TLS failure. |
| Code reading (this change) | The four mechanisms in section 2. |

The 840 ms figure is a symptom. Its cause had not been measured. The board did not report its power-save mode, its socket options, its queue depth, or a distribution of send times. The new `link_diag` frame reports all of these.

## 2. Candidate causes found in the code

Each item lists the change made and the value that will confirm or refute it on the bench.

1. **Wi-Fi modem sleep was on.** Nothing called `setSleep(false)` or `esp_wifi_set_ps`, so the Arduino-ESP32 2.x default (`WIFI_PS_MIN_MODEM`) applied. The radio then receives only at the AP's DTIM beacon, so inbound TCP ACKs and pongs arrive late. On a phone hotspot that can be hundreds of ms.
   *Change:* `WiFi.setSleep(false)`. The build flag `TORQVA_WIFI_PS=1` restores the old mode for an A/B run. *Measured by:* `link_diag.ps` and the send-time histogram.
2. **Nagle's algorithm with many tiny messages.** The board sent about 18 lines/s, each as its own WebSocket message. The IDF 4.4 transport writes the frame header and the payload as two separate TLS records. With Nagle on, the second record waits for the peer's ACK of the first, and Windows delays ACKs by up to 200 ms.
   *Change:* `TCP_NODELAY` on the link socket. Telemetry is also batched into one message at most every 100 ms; priority lines are never delayed. *Measured by:* `link_diag.nd` (sockets the option was applied to) and the histogram.
3. **TORQVA work ran inside the WebSocket client's event callback.** That work included device-lock waits of up to 200 ms, `on_line`, NVS writes, and system commands containing `delay(300)`, all on the client's own task. A send waiting for the client's lock could wait behind it.
   *Change:* the callback only copies the message into a queue, and the link task processes it. *Measured by:* `link_diag.rx` (longest inbound handling) and `rd` (inbound drops).
4. **Retries were stretched to hide a stall.** Commit 4e935bf turned one 1 s send into up to three 3 s attempts. That can block the link task for about 9 s, during which the 24-line queue overflows and acknowledgements sit behind telemetry.
   *Change:* one bounded 1 s send per message, and a failure closes the link (a partly written TLS stream cannot be resumed). There are now two queues: priority (acks, handshake, status, logs, network info) and telemetry. Under backpressure the oldest telemetry line is dropped and counted (`td`), never an acknowledgement (`pd` must stay 0).

Causes of the "replug USB several times" symptom, on the backend side:

5. **`LINK_BUSY` for every Wi-Fi dial while USB held a session.** The board's backoff then grew to 30 s plus up to 50% jitter (about 45 s), and it reset only after a link had lasted 30 s. The backend also rate-limited each address to one attempt per 3 s, so the board's second attempt (1 to 1.5 s later) was always refused and its backoff doubled. A user waiting out that delay would reasonably replug.
   *Change:* standby links (section 3). The board's backoff is now capped at 8 s and resets after a 10 s link. The backend rate limit is 1 s.
6. **Dead links were never detected.** The gateway relay had no TCP keepalive, and the backend checked silence only when the same address redialled. A board that rebooted with a new DHCP address was refused with `LINK_BUSY` behind its own dead link, possibly forever.
   *Change:* the backend closes any attached link that has been silent for 8 s. The gateway sets keepalive (10 s idle, 2 s probes) and `TCP_NODELAY` on both relayed sockets.
7. **Gateway TLS socket used by two threads at once.** One thread read the device's `SSLSocket` while another wrote to it. OpenSSL does not support that, and CPython does not serialise it. This is a latent hazard. No observed drop has been tied to it.
   - *Host A/B (27 Nov):* 30 trials each, 4000 small messages both ways at once, the client on one thread. The old relay delivered 30/30 intact and so did the new one, so **this is not reproduced as a cause of drops**.
   - The hazard itself is real on this Python/OpenSSL. A test harness that read and wrote one `SSLSocket` from two threads failed with `SSLV3_ALERT_BAD_RECORD_MAC`.
   *Change:* a single-threaded, non-blocking relay (hardening, not a fix for a measured fault).

## 3. Transport architecture after the change

- **Exactly one authoritative transport.** It is the one the bridge holds, and only it carries commands.
- **Wi-Fi standby.** A board that dials in while a handshaken production USB session is active is admitted as STANDBY:
  - the backend never writes to it, so no second session starts: no `SESSION_REPLACED` and no duplicate command;
  - the backend tracks its liveness and the device ID the board *claims* in its status frames;
  - readiness shows `wifi_standby: READY` before the cable is pulled.
- **Promotion.** When the USB session ends, the standby link is promoted. The bridge runs the normal mutual handshake on it, which starts a new session. In-flight USB commands become `UNKNOWN_OUTCOME` and are never replayed. A USB port that has produced no handshake after 10 s also yields to a standby link.
- **Wi-Fi to USB.** When the Wi-Fi link is lost, USB auto-connect takes the board (the existing behaviour), and a later Wi-Fi dial becomes standby. There is no operator button for a planned Wi-Fi-to-USB switch while both links are healthy (see section 7).
- **Unchanged:** authentication, the HMAC on commands, replay protection, watchdogs, the firmware's safe stop on a new or lost session, OTA signing, and the NVS layout.

Ordering rule (`lib/torqva_core/communication/link_classify.h`): every line with a real `seq` stays in one ordered queue. The backend reads a backwards `seq` as a device restart, and a restart ends the session. Only lines outside the sequence may overtake: acks, auth, and `seq` 0 lines.

**Setup flow.** The Wi-Fi setup job used to say "Unplug the USB data cable" as soon as USB pairing was verified, before anything showed that Wi-Fi worked. Now it says *keep USB connected*, waits until the standby link is READY, and only then says to unplug. READY means a live link from the address the board reports over USB, carrying the board's device ID.

**Behaviour changes to review:**
- A production USB session no longer refuses Wi-Fi with `LINK_BUSY`; the link becomes standby.
- The per-address rate limit went from 3 s to 1 s.
- Commit 4e935bf's 3 × 3 s send retry is gone.
- The backend batches its outbound lines into messages of up to 1000 bytes.

## 4. Diagnostics added

The `link_diag` frame is sent every 5 s with `net_info`. It is parsed in `wire_protocol.py`, named in `serial_bridge.link_diag_view`, and shown under **Device > Advanced details: Wi-Fi device link**. It carries:

- power-save mode and `TCP_NODELAY` sockets
- last station disconnect reason code and the disconnect count
- minimum free heap
- queue peaks
- telemetry, priority and inbound drops
- messages sent, average send time, and a 5-bucket send histogram
- longest inbound handling time
- the peer's close code (4409 = refused or replaced)
- current link uptime
- link and OLED task stack headroom

The backend writes every link event, `net_info`, `link_diag`, session start and transport end to `.tmp/link_log/link-YYYYMMDD.jsonl`. `scripts/development/link_report.py` summarises it: boots, time from boot to session, drops, promotions, send times, drops and RSSI.

## 5. Bench procedure (motor supply physically disconnected throughout)

Before every run:

- Motor power is unplugged.
- The laptop's hotspot profile is **Private**: `(Get-NetConnectionProfile -InterfaceAlias 'Wi-Fi 3').NetworkCategory`.
- The gateway and the backend are running.
- Note the time, for `link_report.py --since`.

0. **Baseline, before flashing.** Keep the image the board runs now (3.1.1) and run 15 to 30 minutes on Wi-Fi with the new backend and gateway. Its `net_info` fields (`sm`, `lc`, `rr`, `lu`) are unchanged, so `link_report.py` already records max send time, drop causes and link lifetimes. This baseline already uses the new gateway and backend, so before/after isolates the firmware changes.
1. **Flash** the new firmware as **3.2.0**. Either:
   - through the Firmware Manager (signed OTA; its compiler sets `TORQVA_FW_VERSION`), or
   - `esp32s3_wireless` (or `esp32s3_uart_wireless`) over USB.

   Both need explicit authorization. An application flash does not erase NVS (keys and Wi-Fi).
2. **Standby.** With USB connected, open Device > Advanced details. Expect *Wi-Fi standby: ready* within about 10 s, `power_save off`, and `TCP no-delay on`.
3. **USB to Wi-Fi.** Power the board from the power bank and USB together, then pull the USB cable. Expect one *handover* event, a Wi-Fi session in under 5 s, and 0 replugs.
4. **Five cold boots.** Power bank only. Disconnect and reconnect power 5 times, 60 s apart. `link_report.py` must show 5 boots, each with an authenticated Wi-Fi session, reset reason power-on, and no brown-out.
5. **Recovery.** Restart the backend, then the hotspot, then the gateway. Each time, expect a new authenticated session within 15 s and no USB.
6. **Non-actuating round trips.** Wi-Fi scan, config read, and heartbeats. Acks must arrive and `priority_dropped` must stay 0.
7. **60 minutes** on a stable network. Expect 0 `link_disconnected` events, no send of 1000 ms or more, telemetry drops reported (target 0), and min free heap steady.
8. **A/B (optional).** Build with `-DTORQVA_WIFI_PS=1` and repeat step 7 for 15 minutes. If the histogram moves into the slower buckets, cause 1 is confirmed.

## 6. Acceptance targets: status

| Target | Status |
|---|---|
| 5/5 first-attempt cold boots | not yet measured (needs the bench run) |
| 0 USB reconnections after provisioning | not yet measured |
| 0 unexpected drops in 60 min | not yet measured |
| 0 inbound drops (`rx_dropped`) and 0 priority drops | not yet measured |
| 0 stale USB routing / 0 duplicate commands | by construction: standby links are never written to (covered by backend tests) |
| Unplug USB only after Wi-Fi is verified | the setup flow (`provisioning._wait_wireless`) asks for the unplug only after the standby link is READY (covered by tests) |
| No false "connected" status | standby is reported separately from the active transport (readiness and UI tests) |

## 7. Remaining limitations

- **No planned Wi-Fi-to-USB switch.** Wi-Fi hands over to USB only when the Wi-Fi link is lost.
- **Standby identity is a claim.** The device ID shown for a standby link is unauthenticated; it is verified by the handshake at promotion. Authenticating standby before promotion would need a protocol change (a proof that does not start a session).
- **`TCP_NODELAY` relies on a socket scan.** `esp_websocket_client` (IDF 4.4) does not expose its socket, so the option is applied by scanning lwIP sockets for the gateway port. `nd` reports whether it worked.
- **Heartbeat loss may not stop the motor in direct mode.** `heartbeat_timeout_ms = 0` there, so loss of communication alone may not stop the motor. This belongs to the separate motor-safety regression work (`FIVE_INTERLOCK_TEST_FAILURES.md`). Those 5 backend tests fail before and after this change.
