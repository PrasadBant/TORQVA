// Deterministic simulated motor + sensors for host tests and the simulation mode.
// NOT calibrated to the real RS-775: parameters are placeholders until commissioning data exists.
// All output built from this class is SIMULATED data and must be tagged as such downstream.
#pragma once
#include "device.h"

namespace torqva {

struct SimParams {
    float rpm_per_pct = 45.0f;       // steady rpm per % duty
    float tau_drive_s = 0.6f;        // speed time constant while driven
    float tau_coast_s = 5.0f;        // speed time constant while coasting
    float i_idle_a = 0.35f;
    float i_per_pct_a = 0.025f;      // load current per % duty
    float supply_v = 24.0f;
    float r_supply_ohm = 0.3f;       // supply sag per amp
    float ambient_c = 22.0f;
    float heat_per_a2_cps = 0.012f;  // deg C / s per A^2
    float cool_per_s = 0.0015f;      // 1/s toward ambient
    float vib_per_rpm2 = 2.0e-8f;    // g per rpm^2 (imbalance-like)
};

struct SimFaults {
    bool hall_dead = false;          // no pulses, rpm reads 0
    bool current_sensor_dead = false;
    float extra_friction_a = 0.0f;   // adds load current
    float supply_sag_v = 0.0f;
    bool estop_pressed = false;      // external E-stop sensed
    float imbalance_gain = 1.0f;
};

class SimPlant {
public:
    explicit SimPlant(const SimParams& p = SimParams()) : p_(p), rpm_(0), housing_(p.ambient_c), now_ms_(0) {}
    SimFaults faults;
    // Advance by dt_ms using the previous cycle's actuator demand, return the sensor snapshot.
    HalIn step(uint32_t dt_ms, const HalOut& act, bool button);
    float true_rpm() const { return rpm_; }
    float true_housing() const { return housing_; }

private:
    SimParams p_;
    float rpm_, housing_;
    uint32_t now_ms_;
};

}  // namespace torqva
