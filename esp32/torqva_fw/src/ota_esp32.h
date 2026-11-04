// ESP32-S3 platform layer for the over-the-air update (lib/torqva_core/ota.h). Wi-Fi, TLS-verified HTTPS, the Update library (inactive OTA partition),
// mbedTLS ECDSA P-256 signature checks and the first-boot confirm / roll-back. Nothing here touches a motor output.
#pragma once
#include <Arduino.h>
#include "device.h"

// Before the Device is constructed: decides whether this boot can do OTA at all and why not (partitions, compiled-in public key, NVS provisioning).
void ota_platform_capability(torqva::DeviceConfig& cfg);
// After the Device exists: reports this boot's facts, resolves the last attempt (confirmed / rolled back / self-test pending) and starts the OTA task.
// `ina_ok` / `temp_ok` are the sensor initialisation results the self-test needs; `identity_ok` = a provisioned device id AND authentication key.
void ota_platform_start(torqva::Device* dev, SemaphoreHandle_t mu, bool ina_ok, bool temp_ok, bool identity_ok, void (*outputs_off)());
