#include "testexec.h"

namespace torqva {

static const uint32_t kCoastMaxMs = 60000;
static const float kCoastDoneFraction = 0.05f;

const char* TestExecutor::start(TestId id, const TestParams& p, float current_setpoint_rpm,
                                bool motor_running, uint32_t now_ms) {
    if (active_) return "TEST_ACTIVE";
    if (!motor_running || current_setpoint_rpm <= 0.0f) return "NOT_RUNNING";
    // Tests are disabled until the human has commissioned a vibration stop limit.
    if (lim_.vib_rms_stop_g <= 0.0f) return "VIB_LIMIT_NOT_SET";

    switch (id) {
        case TestId::T1_SPEED_STEP_DOWN:
            if (!(p.target_fraction >= 0.3f && p.target_fraction <= 1.0f)) return "FRACTION_OUT_OF_RANGE";
            if (p.hold_ms < 5000 || p.hold_ms > 60000) return "HOLD_OUT_OF_RANGE";
            break;
        case TestId::T3_HOLD_AND_OBSERVE:
            if (p.duration_ms < 1000 || p.duration_ms > 600000) return "DURATION_OUT_OF_RANGE";
            break;
        case TestId::T4_COAST_DOWN:
            break;
        default:
            return "UNKNOWN_TEST";
    }
    active_ = true;
    id_ = id;
    p_ = p;
    start_ms_ = now_ms;
    start_setpoint_ = current_setpoint_rpm;
    last_output_setpoint_ = current_setpoint_rpm;
    pending_abort_ = false;
    abort_reason_ = "NONE";
    return nullptr;
}

void TestExecutor::abort(const char* reason) {
    if (!active_) return;
    pending_abort_ = true;
    abort_reason_ = reason;
}

TestTickOutput TestExecutor::tick(const TestTickInput& in) {
    TestTickOutput out;
    out.active = active_;
    out.setpoint_rpm = last_output_setpoint_;
    out.driver_enable = true;
    out.event = TestEvent::NONE;
    out.abort_reason = "NONE";
    if (!active_) return out;

    // Safety / link loss: abort and cut drive. Never keep a test running without a link.
    if (!in.drive_allowed || !in.link_ok) {
        active_ = false;
        out.active = false;
        out.driver_enable = false;
        out.setpoint_rpm = 0.0f;
        out.event = TestEvent::ABORTED;
        out.abort_reason = !in.drive_allowed ? "SAFETY_TRIP" : "LINK_LOST";
        return out;
    }
    // Command abort: hold the speed we are at, never return to a faster one.
    if (pending_abort_) {
        active_ = false;
        out.active = false;
        out.event = TestEvent::ABORTED;
        out.abort_reason = abort_reason_;
        out.driver_enable = (id_ != TestId::T4_COAST_DOWN);
        return out;
    }

    const uint32_t elapsed = (uint32_t)(in.now_ms - start_ms_);
    switch (id_) {
        case TestId::T1_SPEED_STEP_DOWN:
            last_output_setpoint_ = start_setpoint_ * p_.target_fraction;
            out.setpoint_rpm = last_output_setpoint_;
            if (elapsed >= p_.hold_ms) { active_ = false; out.active = false; out.event = TestEvent::COMPLETED; }
            break;
        case TestId::T3_HOLD_AND_OBSERVE:
            out.setpoint_rpm = start_setpoint_;
            if (elapsed >= p_.duration_ms) { active_ = false; out.active = false; out.event = TestEvent::COMPLETED; }
            break;
        case TestId::T4_COAST_DOWN:
            out.driver_enable = false;     // coast, no braking
            out.setpoint_rpm = 0.0f;
            if (in.rpm <= start_setpoint_ * kCoastDoneFraction || elapsed >= kCoastMaxMs) {
                active_ = false; out.active = false; out.event = TestEvent::COMPLETED;
            }
            break;
        default:
            break;
    }
    return out;
}

}  // namespace torqva
