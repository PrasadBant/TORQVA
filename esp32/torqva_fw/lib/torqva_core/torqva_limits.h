// Hard safety limits. Versioned. Only changeable with human approval (master prompt 0.3);
// learning code must never write to this struct.
#pragma once
#include <stdint.h>

namespace torqva {

struct Limits {
    uint16_t version;
    float ramp_pct_per_s;        // max duty slew
    float max_duty_pct;          // absolute duty cap
    float current_stop_a;        // sustained over-current threshold
    uint32_t current_stop_ms;    // ... for this long
    float current_inst_a;        // instantaneous trip (PSU limit)
    float temp_warn_c;
    float temp_stop_c;
    float temp_rise_stop_c;      // housing - ambient; <=0 disables
    float vib_rms_stop_g;        // <=0: not commissioned (imbalance tests disabled)
    float rpm_loss_duty_pct;     // duty above this with no pulses -> stall/sensor loss
    uint32_t rpm_loss_ms;
    float volt_min_v;
    float volt_max_v;
    uint32_t heartbeat_timeout_ms;
    uint32_t sensor_invalid_ms;  // critical signal invalid this long -> stop
    float max_rpm;               // <=0: not commissioned, SET_SPEED rejected
};

inline Limits default_limits() {
    Limits l;
    l.version = 1;
    l.ramp_pct_per_s = 30.0f;
    l.max_duty_pct = 70.0f;
    l.current_stop_a = 4.0f;
    l.current_stop_ms = 2000;
    l.current_inst_a = 5.0f;     // ASSUMPTION: PSU limit unknown (human task H-10)
    l.temp_warn_c = 50.0f;
    l.temp_stop_c = 60.0f;
    l.temp_rise_stop_c = 0.0f;
    l.vib_rms_stop_g = 0.0f;
    l.rpm_loss_duty_pct = 15.0f;
    l.rpm_loss_ms = 1000;
    l.volt_min_v = 20.0f;
    l.volt_max_v = 25.5f;
    l.heartbeat_timeout_ms = 2000;
    l.sensor_invalid_ms = 500;
    l.max_rpm = 0.0f;
    return l;
}

}  // namespace torqva
