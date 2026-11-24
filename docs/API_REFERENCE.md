# Wireless and Firmware Manager API reference

All paths below use the `/api/torqva` prefix. Website routes require the existing bearer-token authentication. Admin routes also require the admin role. A command record being `SENT` means transport delivery was attempted; only a device acknowledgement can establish execution.

| Method and path | Role | Actual behavior |
|---|---|---|
| `GET /device/status` | Viewer | Real bridge connection, transport, device handshake, session and telemetry validity. |
| `GET /device/history` | Viewer | Physical signal history with null gaps for unavailable readings. |
| `POST /device/connect` | Admin | Open a named USB serial port; returns `CONNECTING` until a real status frame arrives. |
| `POST /device/disconnect` | Admin | Disconnect the current bridge transport. |
| `POST /device/commands` | Admin for non-STOP; authenticated viewer for STOP | Send a command through the existing dispatcher, subject to device session, policy and firmware checks. |
| `GET /firmware/status` | Viewer | Connected device's actual OTA capability, current deployment and eligibility. |
| `GET /firmware/releases` | Viewer | Stored validated firmware releases. |
| `POST /firmware/releases` | Admin | Upload a signed application `.bin`; source compilation is not supported. |
| `POST /firmware/deployments` | Admin | Request a compatible OTA update with `{release_id, device_id}`. The device repeats eligibility checks. |
| `GET /firmware/deployments` | Viewer | Current and historical deployment data, including recovered last state after backend restart. |
| `GET /firmware/deployments/{id}` | Viewer | One deployment's actual reported state and bytes. |
| `GET /firmware/ota/{release}/manifest?t=…` | Device token | Short-lived, release-bound download manifest over HTTPS. |
| `GET /firmware/ota/{release}/image?t=…` | Device token | Bounded streaming image download over HTTPS. |
| WebSocket `/device/link` | Device protocol | Outbound ESP32 TLS link; accepted only when enabled and authenticated by the per-device handshake. |

The removed `/device/direct_mode` route returns 404. The backend does not expose a source compilation, network-switching, remote-restart or manual-rollback API yet.
