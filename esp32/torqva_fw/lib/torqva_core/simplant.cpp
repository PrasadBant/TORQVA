#include "simplant.h"

namespace torqva {

HalIn SimPlant::step(uint32_t dt_ms, const HalOut& act, bool button) {
    const float dt = dt_ms / 1000.0f;
    now_ms_ += dt_ms;

    const bool powered = act.driver_enable && act.relay_on;
    if (powered) {
        const float target = p_.rpm_per_pct * act.duty_pct;
        rpm_ += (target - rpm_) / p_.tau_drive_s * dt;
    } else {
        rpm_ -= rpm_ / p_.tau_coast_s * dt;   // coast, no braking
    }
    if (rpm_ < 0.5f) rpm_ = 0.0f;

    float cur = 0.0f;
    if (powered) cur = p_.i_idle_a + p_.i_per_pct_a * act.duty_pct + faults.extra_friction_a;
    const float volt = p_.supply_v - p_.r_supply_ohm * cur - faults.supply_sag_v;

    housing_ += (p_.heat_per_a2_cps * cur * cur - p_.cool_per_s * (housing_ - p_.ambient_c)) * dt;

    HalIn in;
    in.now_ms = now_ms_;
    in.current_a = faults.current_sensor_dead ? 0.0f : cur;  in.current_valid = !faults.current_sensor_dead;
    in.voltage_v = volt;  in.voltage_valid = true;
    in.housing_c = housing_;  in.housing_valid = true;
    in.ambient_c = p_.ambient_c;  in.ambient_valid = true;
    in.rpm = faults.hall_dead ? 0.0f : rpm_;  in.rpm_valid = true;
    in.pulse_recent = !faults.hall_dead && rpm_ > 10.0f;
    in.vib_rms_g = p_.vib_per_rpm2 * rpm_ * rpm_ * faults.imbalance_gain + 0.02f;
    in.vib_valid = true;
    in.button_pressed = button;
    in.external_estop = faults.estop_pressed;
    return in;
}

}  // namespace torqva
