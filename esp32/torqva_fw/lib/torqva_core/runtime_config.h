// Runtime-configurable operating limits. The OPERATOR approves numbers in the application; the backend sends them over the AUTHENTICATED session; the device validates and applies them.
//   {"t":"cfg","ver":N,"id":I,"seq":S,"sid":"<session>","ci":A,"vl":Vmin,"vh":Vmax,"ct":C,"rp":RPM,"dp":PCT,"m":"<HMAC-SHA-256 of the canonical text, first 16 bytes hex>"}
// canonical text: cfg|ver|id|seq|sid|ci|vl|vh|ct|rp|dp   (integers %lu, numbers %.3f). The MAC key is the SESSION key, which is derived from the per-device key and the device id, so a
// configuration is bound to ONE device and ONE session; the shared command counter (seq) gives replay protection; the version must increase (no rollback).
//   device -> {"t":"cfg_ack","ver":N,"ok":1|0,"reason":"OK|<why>"}
// Nothing is defaulted: motion needs a configuration that was received and accepted in THIS boot; a stored copy is never trusted on its own.
// The absolute ceilings below are MEASUREMENT / hardware-interface ratings of this firmware's sensors (INA219 range, DS18B20 range, Hall counter), NOT motor ratings: they only stop
// nonsense values. The operator remains responsible for entering the motor, driver and supply ratings.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "torqva_limits.h"

namespace torqva {

static const float kAbsMaxCurrentA = 3.2f;     // INA219 with the 0.1 ohm shunt used here measures about +-3.2 A
static const float kAbsMaxVoltageV = 26.0f;    // INA219 bus-voltage range
static const float kAbsMaxTempC = 125.0f;      // DS18B20 range
static const float kAbsMaxRpm = 30000.0f;      // Hall pulse counting plausibility ceiling used by the firmware
static const float kInstantCurrentFactor = 1.25f;   // instantaneous over-current trip = factor x the approved sustained limit (same ratio as the original placeholder pair 4 A / 5 A)

struct RuntimeLimits {
    uint16_t version;
    float max_current_a;
    float volt_min_v;
    float volt_max_v;
    float max_temp_c;
    float max_rpm;
    float max_duty_pct;
};

// nullptr = valid. Otherwise a static reason string.
const char* runtime_limits_validate(const RuntimeLimits& r);
// Maps approved values onto the full Limits struct. Everything the operator did not set keeps its existing value from `base` (ramp, timings, rpm-loss, heartbeat, sensor timeout).
Limits runtime_limits_to_limits(const RuntimeLimits& r, const Limits& base);

struct CfgMsg {
    uint32_t id, seq;
    char sid[33];
    char mac[33];
    RuntimeLimits lim;
};

bool is_cfg_line(const char* line);
// nullptr = parsed (NOT yet authenticated). Never reads past the NUL terminator.
const char* parse_cfg(const char* line, CfgMsg* out);
void cfg_canonical(const CfgMsg& m, char* out, size_t n);
size_t encode_cfg_ack(char* buf, size_t n, uint16_t ver, bool ok, const char* reason);

}  // namespace torqva
