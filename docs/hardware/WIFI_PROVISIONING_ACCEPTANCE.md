# Wi-Fi provisioning and network switching: physical acceptance procedure

**No board has been provisioned, flashed or driven by this work.** Everything below is the first real run of the esptool path and of the new firmware. Use an **isolated ESP32-S3 bench board** with the **motor supply disconnected** and no load. Do not use RIG-1 until this passes.

## Software prerequisites (verified in this repository)
| Prerequisite | Evidence |
|---|---|
| `pip install -r backend/requirements.txt` (esptool 4.x, esp-idf-nvs-partition-gen) | `esptool` 4.14 imports; the adapter's calls exist (`flash_begin`, `flash_block`, `read_flash`, `hard_reset`, `FLASH_WRITE_SIZE`) |
| NVS range is 0x9000 / 0x5000 for both read and write | test compares the constants with PlatformIO's pinned `default_8MB.csv`; the job re-reads the board's own partition table and refuses any mismatch or overlap |
| Firmware builds with staged networks + scan | `esp32s3_wireless`, `esp32s3_uart_wireless`, `esp32s3`, `esp32s3_uart`, OTA LED bench all build; 155 native tests pass |
| Bench CA + gateway certificate exist and the certificate names this laptop's address | Firmware Manager → Device Management shows no certificate warning (otherwise *Reissue certificate*, then restart the gateway) |
| Backup of the bench board's NVS | `python -m esptool --port COMx read_flash 0x9000 0x5000 nvs_backup.bin`. It contains the old Wi-Fi password and device key: keep it encrypted, delete it after the run |

The board must run a firmware **built from this tree** to support staged networks and scanning. A board on older firmware still works (direct write, no automatic fallback; the page says so). Build and install it on the bench board by USB first (`esp32s3_wireless`), with motor power disconnected.

## Procedure and pass criteria
| # | Action | Pass criterion |
|---|---|---|
| 1 | Connect the board by USB, open Firmware Manager → Device Management → Configure Wi-Fi. | Pill **Ready**; port marked *likely ESP32*; device row shows the board; "Staged changes: supported" once connected. |
| 2 | **Scan**. | Real nearby networks with signal, security, channel, 2.4 GHz; your network is marked *saved*/*current* where applicable. The motor-idle and busy refusals apply. |
| 3 | Pick a network, enter a **wrong** password, tick the confirmation, **Configure & Connect**. | Steps run through *Authenticating device and telemetry*; unplug USB; job ends **Wi-Fi pending** (never "paired"); after the trial the board is back on its previous network by itself. `commit` was never sent. |
| 4 | Same network, **correct** password. | After unplugging USB: *Committing*, then **Paired wireless**; checks show authenticated session, fresh telemetry, console over Wi-Fi, OTA capability. |
| 5 | Read NVS back and parse with `torqva.device.nvs.parse_partition`. | `torqva/authkey` unchanged vs the backup; `torqva/cfg` and every `torqva_ota/last|lver|att_ver` unchanged; staged keys `n_*` gone after commit; `ssid/pass/base` now the new network. |
| 6 | Compare flash outside 0x9000–0xE000 before/after. | Bootloader, partition table, otadata and both app slots byte-identical. |
| 7 | **Change Network** (board on Wi-Fi) to a second network with the correct password. | **Committed**; board reports the new network; old one replaced only after pairing. |
| 8 | **Change Network** with a wrong password / a network without gateway access. | **Rolled back**: the page shows your previous network working again; the board was authenticated back on it with fresh telemetry; nothing changed. |
| 9 | Change Network, then power-cycle the board during the trial. | It boots on the previous network (a staged change is RAM-only on this path). |
| 10 | Unplug USB mid-job; restart the backend mid-job. | Job shows *Interrupted*; a write that had started blocks other device operations until a verified USB provisioning (or an explicit clear). |
| 11 | Start a firmware deployment, then Configure & Connect (and the reverse). | The second is refused with `BUSY` naming the first. |
| 12 | Move the laptop to another network (new IP). | The page warns the gateway certificate does not name the address; *Reissue certificate*, restart the gateway, then provisioning succeeds. |
| 13 | Search backend logs, `backend/data/wifi_provisioning_history.json`, audit records, browser console and storage for the Wi-Fi password. | No occurrence. |
| 14 | Verify with a damaged NVS (erase 0x9000 once): Configure & Connect refuses with "rebuild"; tick *rebuild* and repeat. | Refusal without writing; with *rebuild* it succeeds and the identity is rewritten from the key store. |

## Known limits to confirm on hardware
- The in-process esptool read/write (`EsptoolFlash`) is exercised only against a fake until step 3.
- USB-CDC behaviour while the board waits for a host (memory: *ESP32-S3 USB CDC blocks loop*): confirm Wi-Fi telemetry flows after the cable is removed and the trial window (default 5 min for USB setup, 2 min for Change Network) is long enough for your unplug.
- Scanning briefly leaves the home channel; it is refused while the motor runs and rate-limited, but the effect on an active link is only measurable on hardware.
- A wrong password, an unreachable gateway and a 5 GHz-only network look the same to the board (it never joins or never pairs); the page lists the likely causes instead of guessing one.
- Windows may label a new hotspot network Public; check the profile and `scripts/development/configure_lan_firewall.ps1` before step 4.
- Hidden networks are not listed by the scan; type the name. Open networks are not supported (8–63 character passphrase required).
- A staged change cannot be used when the trust anchor changes at the same time; that case writes directly and says so.
