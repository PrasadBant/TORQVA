// Wireless device link (OTA LED bench profile with TORQVA_WIFI_LINK=1 only): the device opens a WebSocket over TLS to the backend's
// /api/torqva/device/link (through backend/tools/ota_https_gateway.py) and carries the SAME JSON lines it writes to USB serial, both ways.
// The backend runs the existing mutual challenge-response on it (per-device key, never sent), so the authenticated host session, HOST_LINK in the
// first-boot self-test, heartbeats, telemetry and the OTA lifecycle all work without USB. USB serial stays available for diagnostics and recovery.
// The device only connects out; it listens on nothing. TLS is verified against the provisioned CA (NVS torqva_ota/ca) with the host name checked.
#pragma once
#include <Arduino.h>
#include "device.h"

// Starts the link task (after ota_platform_capability has loaded the Wi-Fi / base URL / CA from NVS). Does nothing when they are not provisioned.
void wifi_link_start(torqva::Device* dev, SemaphoreHandle_t mu);
// Queues one device line for the backend (dropped, and counted, while the link is down or the queue is full; never blocks the caller).
void wifi_link_send(const char* line);
// True while the WebSocket is connected (not the same as authenticated: the backend decides that through the device handshake).
bool wifi_link_up();
