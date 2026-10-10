// Device: composes safety monitor, drive controller, command validator and test executor behind a
// hardware-agnostic interface. main.cpp (real hardware) and SimPlant (simulation) both talk to this
// through HalIn / HalOut only, so the exact same logic is exercised in host tests.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "torqva_limits.h"
#include "safety.h"
#include "control.h"
#include "commands.h"
#include "testexec.h"
#include "protocol.h"

namespace torqva {

struct DeviceConfig {
    const char* fw_version;
    const char* wiring_id;
    const char* mode;            // "SIM" | "HW"
    char key[32];                // shared secret expected in command field "k"
    bool control_enabled;        // false: motor commands rejected (default on real hardware until Phase 8)
    float kp, ki;
};

// Sensor / input snapshot supplied by the platform (real HAL or SimPlant).
struct HalIn {
    uint32_t now_ms;
    float current_a;  bool current_valid;
    float voltage_v;  bool voltage_valid;
    float housing_c;  bool housing_valid;
    float ambient_c;  bool ambient_valid;
    float rpm;        bool rpm_valid;
    bool  pulse_recent;
    float vib_rms_g;  bool vib_valid;
    bool  button_pressed;        // local acknowledge button, level
    bool  external_estop;        // sensed E-stop / relay feedback if wired
};

// Actuator demands for the platform to apply. Fail-safe values are all-off.
struct HalOut {
    bool driver_enable;          // BTS7960 R_EN/L_EN
    float duty_pct;              // RPWM
    bool relay_on;               // motor power relay
};

class Device {
public:
    Device(const Limits& l, const DeviceConfig& c);

    // Feed one received line (no trailing newline). Never blocks. Responses are queued.
    void on_line(const char* line, uint32_t now_ms);
    // Run one control/safety cycle. Call at >= 100 Hz.
    HalOut step(const HalIn& in);
    // Pop one queued output line. Returns false when empty.
    bool pop_line(char* buf, size_t n);

    const SafetyMonitor& safety() const { return safety_; }
    const DriveController& drive() const { return drive_; }
    const TestExecutor& tests() const { return tests_; }
    // Only for host-side simulation/commissioning code, not reachable over the wire.
    void set_limits(const Limits& l);

private:
    void queue_line(const char* s, size_t len);
    void queue_ack(const Ack& a);
    void emit_frames(const HalIn& in);
    void execute(const Command& c, uint32_t now_ms);
    CommandContext ctx() const;

    DeviceConfig cfg_;
    Limits lim_;
    SafetyMonitor safety_;
    DriveController drive_;
    CommandValidator validator_;
    TestExecutor tests_;

    uint32_t last_step_ms_; bool stepped_;
    uint32_t last_hb_ms_; bool hb_seen_;
    uint32_t seq_;
    uint32_t last_fast_ms_, last_slow_ms_, last_status_ms_;
    SafetyState last_state_; TripReason last_reason_;
    uint32_t test_cmd_id_; bool test_cmd_valid_;
    uint32_t reset_cmd_id_; bool reset_pending_; uint32_t reset_deadline_ms_;
    HalOut last_out_;
    float last_dt_s_;

    static const int kQ = 24;
    static const int kLine = 200;
    char q_[kQ][kLine];
    int q_head_, q_tail_, q_count_;
    uint32_t dropped_;
};

}  // namespace torqva
