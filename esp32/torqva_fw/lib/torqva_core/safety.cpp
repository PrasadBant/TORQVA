#include "safety.h"

namespace torqva {

const char* trip_reason_name(TripReason r) {
    switch (r) {
        case TripReason::NONE: return "NONE";
        case TripReason::OVER_CURRENT_SUSTAINED: return "OVER_CURRENT_SUSTAINED";
        case TripReason::OVER_CURRENT_INSTANT: return "OVER_CURRENT_INSTANT";
        case TripReason::TEMP_STOP: return "TEMP_STOP";
        case TripReason::TEMP_RISE: return "TEMP_RISE";
        case TripReason::VIBRATION: return "VIBRATION";
        case TripReason::RPM_LOSS: return "RPM_LOSS";
        case TripReason::VOLTAGE_LOW: return "VOLTAGE_LOW";
        case TripReason::VOLTAGE_HIGH: return "VOLTAGE_HIGH";
        case TripReason::HEARTBEAT_LOST: return "HEARTBEAT_LOST";
        case TripReason::SENSOR_INVALID: return "SENSOR_INVALID";
        case TripReason::EXTERNAL_ESTOP: return "EXTERNAL_ESTOP";
        case TripReason::RESET_FAULT: return "RESET_FAULT";
        case TripReason::OUTPUT_INIT_FAULT: return "OUTPUT_INIT_FAULT";
    }
    return "UNKNOWN";
}

SafetyMonitor::SafetyMonitor(const Limits& l)
    : lim_(l), state_(SafetyState::OK), reason_(TripReason::NONE), fault_mask_(0),
      oc_active_(false), oc_start_(0), rl_active_(false), rl_start_(0),
      inv_active_(false), inv_start_(0), crit_seen_ok_(false), last_hb_ms_(0), hb_seen_(false) {}

void SafetyMonitor::trip(TripReason r) {
    fault_mask_ |= trip_bit(r);                      // record every cause, even when a first cause is already latched
    if (state_ != SafetyState::EMERGENCY_STOP) {   // keep the FIRST cause
        state_ = SafetyState::EMERGENCY_STOP;
        reason_ = r;
    }
}

bool SafetyMonitor::reset_trip(bool authorized_command, bool local_button) {
    (void)local_button;
    if (state_ != SafetyState::EMERGENCY_STOP) return true;
    if (!authorized_command) return false;
    state_ = SafetyState::OK;
    reason_ = TripReason::NONE;
    fault_mask_ = 0;
    oc_active_ = rl_active_ = inv_active_ = false;
    hb_seen_ = false;          // heartbeat must be re-established after a reset
    return true;
}

SafetyOutput SafetyMonitor::update(const SafetyInputs& in) {
    const uint32_t now = in.now_ms;
    const bool current_ok = in.current_valid && finite_f(in.current_a);
    const bool voltage_ok = in.voltage_valid && finite_f(in.voltage_v);
    const bool housing_ok = in.housing_valid && finite_f(in.housing_c);
    const bool ambient_ok = in.ambient_valid && finite_f(in.ambient_c);
    const bool rpm_ok = in.rpm_valid && finite_f(in.rpm);
    const bool vib_ok = in.vib_valid && finite_f(in.vib_rms_g);

    if (state_ != SafetyState::EMERGENCY_STOP) {
        state_ = SafetyState::OK;

        if (in.external_estop_active) trip(TripReason::EXTERNAL_ESTOP);

        // Critical signal validity (fail safe: no data -> no motion)
        const bool critical_invalid = !current_ok || !voltage_ok || !housing_ok || !rpm_ok;
        // A critical signal that is invalid latches a fault when (a) it was valid before and has been lost, or (b) the motor is being driven. Before every critical signal has been
        // valid once (sensors still warming up after power-up, for example the DS18B20's first conversion) an idle device does NOT latch: it simply cannot be started, because the
        // start interlock refuses with SENSOR_NOT_VALID. Nothing invalid is ever treated as valid.
        if (!critical_invalid) crit_seen_ok_ = true;
        if (critical_invalid && !in.relaxed_interlocks) {
            if (!inv_active_) { inv_active_ = true; inv_start_ = now; }
            if ((uint32_t)(now - inv_start_) >= lim_.sensor_invalid_ms && (crit_seen_ok_ || in.duty_pct > 0.0f)) trip(TripReason::SENSOR_INVALID);
        } else {
            inv_active_ = false;
        }

        // Current
        if (current_ok && !in.relaxed_interlocks) {
            if (in.current_a > lim_.current_inst_a) trip(TripReason::OVER_CURRENT_INSTANT);
            if (in.current_a > lim_.current_stop_a) {
                if (!oc_active_) { oc_active_ = true; oc_start_ = now; }
                if ((uint32_t)(now - oc_start_) >= lim_.current_stop_ms) trip(TripReason::OVER_CURRENT_SUSTAINED);
            } else {
                oc_active_ = false;
            }
        }

        // Voltage
        if (voltage_ok && !in.relaxed_interlocks) {
            // An absent supply (below kSupplyPresentV) with the drive idle is not a fault: nothing can move. A supply that is present but low, or ANY low voltage while driving, trips.
            if (lim_.volt_min_v > 0.0f && in.voltage_v < lim_.volt_min_v && (in.duty_pct > 0.0f || in.voltage_v >= kSupplyPresentV)) trip(TripReason::VOLTAGE_LOW);
            if (in.voltage_v > lim_.volt_max_v) trip(TripReason::VOLTAGE_HIGH);
        }

        // Temperature
        if (housing_ok) {
            if (in.housing_c > lim_.temp_stop_c) trip(TripReason::TEMP_STOP);
            else if (in.housing_c > lim_.temp_warn_c) state_ = SafetyState::WARN;
            if (lim_.temp_rise_stop_c > 0.0f && ambient_ok &&
                (in.housing_c - in.ambient_c) > lim_.temp_rise_stop_c) trip(TripReason::TEMP_RISE);
        }

        // Vibration (only once the human has commissioned a limit)
        if (lim_.vib_rms_stop_g > 0.0f && vib_ok && in.vib_rms_g > lim_.vib_rms_stop_g)
            trip(TripReason::VIBRATION);

        // RPM loss: driving but no hall pulses
        if (!in.relaxed_interlocks && in.duty_pct > lim_.rpm_loss_duty_pct && !in.rpm_pulse_seen_recently) {
            if (!rl_active_) { rl_active_ = true; rl_start_ = now; }
            if ((uint32_t)(now - rl_start_) >= lim_.rpm_loss_ms) trip(TripReason::RPM_LOSS);
        } else {
            rl_active_ = false;
        }

        // Heartbeat (Hardware-control mode only). Timer starts at first update after enable/reset.
        // The dead-man applies while the motor is being driven: if the host goes quiet the motor stops and the fault latches. An idle device is not driving anything, so a quiet host (not yet
        // connected, restarted, unplugged) is not a fault there (otherwise every boot would latch HEARTBEAT_LOST before the authenticated session can start); START itself is refused
        // without a recent heartbeat (NO_HEARTBEAT), so nothing can start without a live host.
        if (!in.relaxed_interlocks && in.hardware_control_mode && in.duty_pct > 0.0f) {
            if (!hb_seen_) { hb_seen_ = true; last_hb_ms_ = now; }
            if ((uint32_t)(now - last_hb_ms_) >= lim_.heartbeat_timeout_ms) trip(TripReason::HEARTBEAT_LOST);
        }
    }

    SafetyOutput out;
    out.state = state_;
    out.reason = reason_;
    out.drive_allowed = (state_ != SafetyState::EMERGENCY_STOP);
    return out;
}

}  // namespace torqva
