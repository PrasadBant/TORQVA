#include "interlock.h"

namespace torqva {

const char* start_interlock_reason(const StartInterlockInputs& in) {
    if (!in.initialized) return "NOT_INITIALIZED";
    if (!in.limits_approved) return "LIMITS_NOT_APPROVED";
    if (!in.transport_secured) return "TRANSPORT_NOT_SECURED";
    if (!in.session_active) return "NO_SECURE_SESSION";
    if (!in.estop_input_wired) return "ESTOP_INPUT_NOT_VERIFIED";
    if (in.estop_active) return "ESTOP_ACTIVE";
    if (!in.watchdog_active) return "WATCHDOG_NOT_ACTIVE";
    if (in.safety_state != SafetyState::OK) return "SAFETY_NOT_OK";
    if (!in.required_sensors_valid) return "SENSOR_NOT_VALID";
    if (!in.telemetry_fresh) return "TELEMETRY_STALE";
    if (!in.link_ok) return "NO_HEARTBEAT";
    return nullptr;
}

}  // namespace torqva
