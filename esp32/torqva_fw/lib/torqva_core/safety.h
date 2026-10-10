// Device safety monitor: pure logic, no Arduino dependencies, host-testable.
// Fail-safe: any trip latches until reset_trip(authorized, local_button).
#pragma once
#include <stdint.h>
#include "torqva_limits.h"

namespace torqva {

enum class SafetyState : uint8_t { OK = 0, WARN = 1, EMERGENCY_STOP = 2 };

enum class TripReason : uint8_t {
    NONE = 0, OVER_CURRENT_SUSTAINED, OVER_CURRENT_INSTANT, TEMP_STOP, TEMP_RISE,
    VIBRATION, RPM_LOSS, VOLTAGE_LOW, VOLTAGE_HIGH, HEARTBEAT_LOST, SENSOR_INVALID,
    EXTERNAL_ESTOP,
    RESET_FAULT              // the controller restarted because of a watchdog, brown-out or panic: latched until an intentional reset
};

const char* trip_reason_name(TripReason r);

// A NaN or infinite reading compares false against every limit; it must never be treated as a healthy value.
inline bool finite_f(float x) { return x == x && x <= 3.0e38f && x >= -3.0e38f; }

inline uint32_t trip_bit(TripReason r) { return 1u << (uint8_t)r; }

struct SafetyInputs {
    uint32_t now_ms;
    float current_a;      bool current_valid;
    float voltage_v;      bool voltage_valid;
    float housing_c;      bool housing_valid;
    float ambient_c;      bool ambient_valid;
    float rpm;            bool rpm_valid;
    bool  rpm_pulse_seen_recently;   // any hall pulse within rpm_loss_ms
    float vib_rms_g;      bool vib_valid;
    float duty_pct;                  // currently applied duty
    bool  hardware_control_mode;     // heartbeat only enforced in this mode
    bool  external_estop_active;     // sensed from relay/E-stop feedback if wired
};

struct SafetyOutput {
    SafetyState state;
    TripReason reason;
    bool drive_allowed;   // false -> firmware must disable driver (EN low, relay off, coast)
};

class SafetyMonitor {
public:
    explicit SafetyMonitor(const Limits& l);
    // Call at >= 100 Hz. Never blocks.
    SafetyOutput update(const SafetyInputs& in);
    void heartbeat(uint32_t now_ms) { last_hb_ms_ = now_ms; hb_seen_ = true; }
    // Reset needs BOTH an authorized command and the local button press.
    bool reset_trip(bool authorized_command, bool local_button);
    // Latch a fault detected outside update() (e.g. the reason for the last reset). Same latch, same intentional-reset requirement.
    void latch_external(TripReason r) { trip(r); }
    SafetyState state() const { return state_; }
    TripReason reason() const { return reason_; }
    // Every distinct condition that tripped since the last reset (reason() keeps only the FIRST cause). Bit = trip_bit(TripReason).
    uint32_t fault_mask() const { return fault_mask_; }
    const Limits& limits() const { return lim_; }
    // Replaces limits. Caller must have human approval; learning code must not call this.
    void set_limits(const Limits& l) { lim_ = l; }

private:
    void trip(TripReason r);
    Limits lim_;
    SafetyState state_;
    TripReason reason_;
    uint32_t fault_mask_;
    bool oc_active_; uint32_t oc_start_;
    bool rl_active_; uint32_t rl_start_;
    bool inv_active_; uint32_t inv_start_;
    uint32_t last_hb_ms_; bool hb_seen_;
};

}  // namespace torqva
