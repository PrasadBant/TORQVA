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
#include "interlock.h"
#include "auth.h"
#include "runtime_config.h"

namespace torqva {

struct DeviceConfig {
    const char* fw_version;
    const char* wiring_id;
    const char* mode;            // "SIM" | "HW"
    char key[32];                // shared secret expected in command field "k"
    bool control_enabled;        // false: motor commands rejected (default on real hardware until Phase 8)
    float kp, ki;
    // Start interlocks (see interlock.h). Zero-initialised = STRICT: motor-energising commands are refused until a human approves the limits and an
    // independent E-stop input is wired and declared. Only host simulation (SimPlant / fitl / tests) sets relaxed_interlocks.
    bool limits_approved;
    bool estop_input_wired;
    const char* device_id;       // optional identity echoed in every acknowledgement ("dev"); the backend can require it. NOT a secret and NOT authentication by itself
    bool accel_supported;        // an ADXL345 is read by this build: "accel" frames are emitted (ok=0 when the reading is invalid). False in host simulation: no frames, nothing invented
    bool transport_secured;      // declared by the deployment: the command link is an AUTHENTICATED USB link (per-device key, HMAC, replay protection, expiry). NOT encrypted. Valid only for a direct USB link to a local PC. (was: the serial/TCP protocol itself has a plaintext shared key and no challenge, so this stays false until a secured channel exists
    bool relaxed_interlocks;
    // Authenticated session (auth.h). auth_enabled = a per-device key was provisioned. Without it no session can exist and motion commands are refused (NO_SECURE_SESSION).
    bool auth_enabled;
    uint8_t auth_key[32];
    uint32_t (*rand32)();
    uint32_t auth_max_ttl_ms;    // 0 = 600000
    // Called after a runtime configuration was authenticated, validated and applied (the target stores it for audit; it is NEVER trusted on its own after a reboot). May be null.
    void (*persist_cfg)(const RuntimeLimits&);
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
    float acc_x_g, acc_y_g, acc_z_g, acc_mag_g;   // raw acceleration per axis and total magnitude (gravity included; NOT vibration RMS)
    bool  acc_valid;
    bool  button_pressed;        // local acknowledge button, level
    bool  external_estop;        // sensed E-stop / relay feedback if wired
    uint8_t estop_state;         // reported only: 0 not monitored, 1 asserted (pressed / open circuit), 2 released (circuit healthy), 3 unknown (not yet read / debounce)
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
    // The platform tells the device whether the task watchdog is actually registered for the control task (strict mode refuses to start otherwise).
    void set_watchdog_active(bool v) { watchdog_active_ = v; }
    // The transport layer calls this ONLY after an authenticated handshake succeeded, and with false on any loss/expiry of that session. Losing a session while the
    // motor is energised stops it (like a STOP), so a dropped or hijacked link cannot leave motion running. Never true after construction (a reboot has no session).
    void set_secure_session(bool v);
    bool secure_session() const { return session_active_; }
    // Runtime limits. restore_runtime_limits() loads a STORED configuration so the safety trips use the approved numbers, but does NOT approve motion: only an authenticated cfg message
    // received in this boot does (cfg_version() > 0).
    void restore_runtime_limits(const RuntimeLimits& r);
    uint16_t cfg_version() const { return cfg_runtime_valid_ ? cfg_ver_ : 0; }
    const Limits& limits() const { return lim_; }
    // Begin a session bound to a session id issued by the authenticated transport (up to 32 chars, non-empty). Every non-STOP command must then carry the same "sid";
    // commands for an earlier session id are rejected (WRONG_SESSION). Replaces any previous session. The transport calls this only after its handshake.
    bool begin_session(const char* sid);
    // Snapshot for the local display (OLED): last sensor values, validity and safety state. Read-only; never used for any decision.
    struct DisplayInfo {
        float rpm, current_a, voltage_v, housing_c, acc_mag_g;
        bool rpm_valid, current_valid, voltage_valid, housing_valid, acc_valid, have_data;
        SafetyState state; TripReason reason; const char* start_block; const char* drive;
    };
    void display_info(DisplayInfo* d, uint32_t now_ms) const;
    // Latch a fault detected before the control loop starts (reset reason). Cleared only by the normal intentional reset (authorised RESET_ESTOP + local button).
    void latch_boot_fault(TripReason r) { safety_.latch_external(r); }
    // Whether a motor-energising command would currently be permitted, and if not why (static string). Same logic the command path uses.
    const char* start_blocked_reason(uint32_t now_ms) const;
    // Only for host-side simulation/commissioning code, not reachable over the wire.
    void set_limits(const Limits& l);

private:
    void queue_line(const char* s, size_t len);
    void queue_ack(const Ack& a);
    void emit_frames(const HalIn& in);
    // Returns nullptr on success, else a static reason the execution layer refused the (already validated) command.
    const char* execute(const Command& c, uint32_t now_ms);
    CommandContext ctx() const;

    DeviceConfig cfg_;
    Limits lim_;
    SafetyMonitor safety_;
    DriveController drive_;
    CommandValidator validator_;
    TestExecutor tests_;
    SessionAuth auth_;
    bool cfg_runtime_valid_; uint16_t cfg_ver_;
    void handle_cfg(const char* line, uint32_t now_ms);

    HalIn last_in_; bool have_in_; bool watchdog_active_; bool session_active_; char session_sid_[33];
    uint32_t last_step_ms_; bool stepped_;
    uint32_t last_hb_ms_; bool hb_seen_;
    uint32_t seq_;
    uint32_t last_fast_ms_, last_slow_ms_, last_status_ms_, last_accel_ms_;
    SafetyState last_state_; TripReason last_reason_;
    uint32_t test_cmd_id_; bool test_cmd_valid_;
    uint32_t reset_cmd_id_; bool reset_pending_; uint32_t reset_deadline_ms_;
    HalOut last_out_;
    float last_dt_s_;

    static const int kQ = 24;
    static const int kLine = 288;
    char q_[kQ][kLine];
    int q_head_, q_tail_, q_count_;
    uint32_t dropped_;
};

}  // namespace torqva
