// ESP32-S3 platform layer for the over-the-air update (lib/torqva_core/communication/ota.h). Wi-Fi, TLS-verified HTTPS, the Update library (inactive OTA partition),
// mbedTLS ECDSA P-256 signature checks and the first-boot confirm / roll-back. Nothing here touches a motor output.
#pragma once
#include <Arduino.h>
#include "shared/device.h"

// Before the Device is constructed: decides whether this boot can do OTA at all and why not (partitions, compiled-in public key, NVS provisioning).
void ota_platform_capability(torqva::DeviceConfig& cfg);
// After the Device exists: reports this boot's facts, resolves the last attempt (confirmed / rolled back / self-test pending) and starts the OTA task.
// `ina_ok` / `temp_ok` are the sensor initialisation results the self-test needs; `identity_ok` = a provisioned device id AND authentication key.
void ota_platform_start(torqva::Device* dev, SemaphoreHandle_t mu, bool ina_ok, bool temp_ok, bool identity_ok, void (*outputs_off)());
// The provisioned network settings (NVS torqva_ota), for the wireless device link (wifi_link.cpp). False when they are incomplete or the base URL is
// not an https:// address the device can reach (same rules as the OTA capability check).
bool ota_net_config(String* ssid, String* pass, String* base, String* ca);
// Persists updated Wi-Fi / HTTPS base URL settings to NVS (authenticated host config update only).
bool ota_update_wifi_config(const String& ssid, const String& pass, const String& base);
// Staged Wi-Fi change (lib/torqva_core/communication/wifi_trial.h). ota_wifi_stage tries a NEW network without overwriting the committed one in NVS;
// ota_wifi_commit (authenticated host request, made over the new network) makes it permanent; ota_wifi_trial_tick (call often) restores the previous
// network when a trial ends without a commit. A network staged in NVS (keys n_*) over USB provisioning is tried the same way after boot.
bool ota_wifi_stage(const String& ssid, const String& pass, const String& base, uint32_t trial_s);
bool ota_wifi_commit();
bool ota_wifi_trial_tick(uint32_t now_ms);
void ota_wifi_state(bool* trial, uint32_t* left_s, String* active_ssid, uint32_t now_ms);
// Switches boot partition to the inactive valid OTA slot for manual rollback.
bool ota_rollback_partition();
