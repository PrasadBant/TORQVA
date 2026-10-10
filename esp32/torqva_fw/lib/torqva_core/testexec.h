// On-device diagnostic test executor (T1 speed step down, T3 hold & observe, T4 coast down).
// Runs entirely on the device so a lost link mid-test still ends safely: the safety monitor
// overrides everything, and the executor aborts itself whenever drive is not allowed.
#pragma once
#include <stdint.h>
#include "torqva_limits.h"

namespace torqva {

enum class TestId : uint8_t { NONE = 0, T1_SPEED_STEP_DOWN = 1, T3_HOLD_AND_OBSERVE = 3, T4_COAST_DOWN = 4 };
enum class TestEvent : uint8_t { NONE = 0, COMPLETED, ABORTED };

struct TestParams {
    float target_fraction;   // T1: fraction of starting setpoint, [0.3, 1.0]
    uint32_t hold_ms;        // T1: 5 000 .. 60 000
    uint32_t duration_ms;    // T3: 1 000 .. 600 000
};

struct TestTickInput {
    uint32_t now_ms;
    bool drive_allowed;      // from SafetyMonitor
    bool link_ok;            // heartbeat fresh
    float rpm;
};

struct TestTickOutput {
    bool active;
    float setpoint_rpm;      // valid when driver_enable
    bool driver_enable;
    TestEvent event;
    const char* abort_reason;
};

class TestExecutor {
public:
    explicit TestExecutor(const Limits& l) : lim_(l), active_(false), id_(TestId::NONE),
        start_ms_(0), start_setpoint_(0), p_(), pending_abort_(false),
        abort_reason_("NONE"), last_output_setpoint_(0) {}
    void set_limits(const Limits& l) { lim_ = l; }
    // Returns nullptr when started, otherwise a static rejection reason. Upward steps are not possible.
    const char* start(TestId id, const TestParams& p, float current_setpoint_rpm, bool motor_running, uint32_t now_ms);
    void abort(const char* reason);         // command abort: hold the CURRENT speed (never go faster)
    TestTickOutput tick(const TestTickInput& in);
    bool active() const { return active_; }
    TestId id() const { return id_; }

private:
    Limits lim_;
    bool active_;
    TestId id_;
    uint32_t start_ms_;
    float start_setpoint_;
    TestParams p_;
    bool pending_abort_;
    const char* abort_reason_;
    float last_output_setpoint_;
};

}  // namespace torqva
