# TORQVA local Wi-Fi configuration

Verified host at configuration time: `10.71.51.194`. The address is supplied at launch and is not hardcoded in application source.

## Network layout and ports

| Port | Listener | LAN purpose | Protection |
|---:|---|---|---|
| 5173/TCP | Vite | Website, same-origin REST proxy and browser WebSocket proxy | Windows rule limited to `LocalSubnet`; bearer/WebSocket authentication remains required |
| 8000/TCP | FastAPI/Uvicorn | Direct API verification and optional LAN API clients | Windows rule limited to `LocalSubnet`; bearer roles, CORS and WebSocket origin checks remain active |
| 8443/TCP | TLS gateway | ESP32 authenticated `wss` device link and signed HTTPS OTA image routes | Windows rule limited to `LocalSubnet`; private CA verification; gateway exposes only device WebSocket and tokenized OTA GET routes |

No port is opened to an internet-facing router and Windows Firewall remains enabled.

## Start LAN mode

From an ordinary PowerShell terminal:

```powershell
cd C:\Users\vishu\Downloads\Torqva
.\scripts\development\start_lan.ps1 -LanHost 10.71.51.194
```

USB autoconnect is off by default. Use `-AutoConnectUsb` only when an intentional USB-to-Wi-Fi handover is required and the board is safe to reset. The equivalent direct command is:

```powershell
$env:TORQVA_LAN_HOST='10.71.51.194'
$env:TORQVA_AUTOCONNECT='0'
cd frontend
npm run dev:lan
```

If DHCP changes the laptop address, stop TORQVA, reissue the gateway certificate from the existing CA for the new IP, then launch with the new value. Reusing the CA avoids reprovisioning the ESP32 trust anchor; the ESP32 backend URL must still be updated through authenticated USB provisioning.

## Configurable addresses

- `TORQVA_LAN_HOST`: required LAN-mode host advertised to operators and the ESP32.
- `TORQVA_FRONTEND_BIND`: listener address; defaults to `0.0.0.0`.
- `TORQVA_BACKEND_BIND`: listener address; defaults to `0.0.0.0`.
- `TORQVA_VITE_PROXY_TARGET`: frontend REST/WebSocket proxy target; defaults to `http://127.0.0.1:8000`.
- `VITE_API_BASE_URL`: optional browser REST base. Empty/default keeps safer same-origin proxying.
- `VITE_WS_BASE_URL`: optional browser `ws://` or `wss://` origin. Empty/default uses the page origin.
- `TORQVA_CORS_ORIGINS`: launcher defaults to localhost plus `http://<LAN_HOST>:5173`; wildcard is rejected.
- `TORQVA_OTA_PUBLIC_BASE_URL`: launcher defaults to `https://<LAN_HOST>:8443`.
- `TORQVA_SECRETS_DIR`, `TORQVA_TLS_CERT`, `TORQVA_TLS_KEY`, `TORQVA_OTA_PUBLIC_KEY`: optional path overrides; defaults are under `%LOCALAPPDATA%\Torqva\secrets`.

## Firewall management

Run the following from an elevated PowerShell terminal if the rules need to be recreated:

```powershell
.\scripts\development\configure_lan_firewall.ps1
```

Remove only TORQVA's rules with:

```powershell
.\scripts\development\configure_lan_firewall.ps1 -Remove
```

The rules use `RemoteAddress LocalSubnet`, apply to Public and Private profiles, and are restricted to Node/Python plus the three listed ports.

## ESP32 provisioning

The production device needs `esp32s3_wireless` or `esp32s3_uart_wireless`, the same release public key compiled into firmware, and NVS containing:

- the Wi-Fi SSID/password;
- `https://<LAN_HOST>:8443` as `torqva_ota.base`;
- `bench_ca.pem` as the trust anchor;
- the per-device 32-byte authentication key matching `backend/data/device_keys.json`.

Generate/inspect artifacts without flashing:

```powershell
python scripts/setup/provision_wireless.py --ip 10.71.51.194
```

Actual NVS or firmware flashing requires a separate explicit authorization, motor power disconnected, and the hardware checklist. Secrets must never be passed in command history; the provisioner prompts for the password.

For a board already authenticated over USB, Hardware Manager can send the new SSID and HTTPS base using the authenticated `wifi_cfg` protocol. TORQVA never treats discovery as authentication. The backend accepts Wi-Fi ownership only after the per-device challenge/response succeeds. Production-motor USB ownership is not dropped for an unverified challenger; supported handover behavior remains capability/profile dependent.

## Verified software connectivity

- `http://10.71.51.194:5173`: HTTP 200.
- `http://10.71.51.194:8000/api/health`: HTTP 200.
- Frontend same-origin `/api` proxy: HTTP 200.
- Direct backend CORS response permits exactly `http://10.71.51.194:5173`.
- Browser WebSocket `ws://10.71.51.194:5173/api/torqva/ws`: authenticated snapshot received; automatic exponential reconnect remains enabled.
- TLS gateway certificate SAN contains `10.71.51.194`; trusted-CA request reaches the restricted gateway and receives the expected 404 for an unexposed route; the same request without the CA fails as untrusted.
- Backend wireless/device-link integration: 64 tests passed.
- Frontend network/workspace tests: 24 tests passed; production build passed.

## Remaining hardware requirements

- No ESP32 was provisioned, flashed, restarted or connected during this configuration task.
- Wireless telemetry, console streaming, USB-to-Wi-Fi handover, automatic board reconnection, OTA transfer and post-restart identity verification need the provisioned physical ESP32-S3.
- Router/client isolation can still prevent peers on the same SSID from communicating. Disable AP/client isolation only on a trusted network; do not configure internet port forwarding.
- If the laptop moves to another subnet or receives a new IP, update the certificate/backend URL as described above.
