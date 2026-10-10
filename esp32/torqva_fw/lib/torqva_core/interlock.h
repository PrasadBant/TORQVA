// Start interlocks: pure logic, host-testable. A command that can energise the motor (START, SET_SPEED, RUN_TEST) is accepted only if EVERY condition
// below is verified. Anything unverified counts as unavailable (fail closed), never as safe.
#pragma once
#include <stdint.h>
#include "safety.h"

namespace torqva {

struct StartInterlockInputs {
    bool initialized;            // the control loop has run at least once
    bool limits_approved;        // a human approved the safety-trip limits for THIS motor/driver/PSU (commissioning decision)
    bool session_active;         // a freshly authenticated session is established RIGHT NOW (set by the transport layer after its handshake; false after any link loss or reboot)
    bool transport_secured;      // the command link is authenticated, confidential and replay-protected (the plaintext shared key alone is NOT sufficient)
    bool estop_input_wired;      // an independent emergency-stop input exists with a documented wiring contract
    bool estop_active;           // that input currently asserts stop
    bool watchdog_active;        // the task watchdog is registered for the control task
    SafetyState safety_state;    // must be OK (WARN and EMERGENCY_STOP both block)
    bool required_sensors_valid; // current, voltage, housing and rpm: flagged valid AND finite
    bool telemetry_fresh;        // the last sensor snapshot is recent (wrap-safe age)
    bool link_ok;                // an authorised heartbeat was seen within the heartbeat timeout
};

// nullptr = permit; otherwise a static reason string (the first failed check, in this order).
const char* start_interlock_reason(const StartInterlockInputs& in);

}  // namespace torqva
