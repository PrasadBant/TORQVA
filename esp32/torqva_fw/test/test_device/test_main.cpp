// Protocol + device-layer tests using the deterministic SimPlant. No hardware involved.
#include <unity.h>
#include <string>
#include <vector>
#include <stdio.h>
#include <string.h>
#include <math.h>
#include "device.h"
#include "simplant.h"
#include "sha256.h"

using namespace torqva;

static DeviceConfig sim_cfg(bool control = true, bool relaxed = true, bool approved = false, bool wired = false, bool secured = false) {
    DeviceConfig c = {};
    c.fw_version = "3.0.0-test"; c.wiring_id = "SIM"; c.mode = "SIM";
    strcpy(c.key, "sim-key");
    c.control_enabled = control; c.kp = 0.01f; c.ki = 0.03f;
    c.relaxed_interlocks = relaxed;                    // host simulation relaxes the start interlocks; the strict tests below do not
    c.limits_approved = approved; c.estop_input_wired = wired; c.transport_secured = secured;
    return c;
}
static Limits sim_limits() {
    Limits l = default_limits();
    l.max_rpm = 3000.0f; l.vib_rms_stop_g = 2.0f;
    return l;
}

struct Rig {
    Device dev;
    SimPlant plant;
    HalOut act;
    uint32_t t;
    uint32_t next_id, next_seq;
    bool button, auto_hb;
    uint32_t last_hb_t;
    std::vector<std::string> out;

    explicit Rig(bool control = true, const Limits& l = sim_limits(), bool relaxed = true, bool approved = false, bool wired = false, bool secured = false)
        : dev(l, sim_cfg(control, relaxed, approved, wired, secured)), t(0), next_id(1), next_seq(1), button(false), auto_hb(true), last_hb_t(0) {
        act.driver_enable = false; act.duty_pct = 0; act.relay_on = false;
    }
    void drain() {
        char b[256];
        while (dev.pop_line(b, sizeof(b))) out.push_back(b);
    }
    uint32_t send(const char* type, float p = 0, float p2 = 0, float p3 = 0, const char* key = "sim-key",
                  const char* force_id = nullptr) {
        char line[256];
        uint32_t id = next_id++;
        snprintf(line, sizeof(line),
                 "{\"id\":%lu,\"type\":\"%s\",\"p\":%g,\"p2\":%g,\"p3\":%g,\"ttl\":5000,\"age\":0,\"seq\":%lu,\"k\":\"%s\"}",
                 (unsigned long)(force_id ? (uint32_t)atoi(force_id) : id), type, p, p2, p3,
                 (unsigned long)next_seq++, key);
        dev.on_line(line, t);
        drain();
        return id;
    }
    void run(uint32_t ms) {
        for (uint32_t e = 0; e < ms; e += 10) {
            if (auto_hb && t - last_hb_t >= 500) { last_hb_t = t; send("HEARTBEAT"); }
            HalIn in = plant.step(10, act, button);
            t = in.now_ms;
            act = dev.step(in);
            drain();
        }
    }
    bool has(const char* needle) const {
        for (size_t i = 0; i < out.size(); i++) if (out[i].find(needle) != std::string::npos) return true;
        return false;
    }
    int count(const char* needle) const {
        int n = 0;
        for (size_t i = 0; i < out.size(); i++) if (out[i].find(needle) != std::string::npos) n++;
        return n;
    }
    std::string last_with(const char* needle) const {
        for (size_t i = out.size(); i-- > 0;) if (out[i].find(needle) != std::string::npos) return out[i];
        return "";
    }
};

void setUp() {}
void tearDown() {}

// ---------- start interlocks (strict mode) ----------
static std::string start_reason(Rig& r) {
    r.out.clear();
    r.send("START", 30);
    const std::string a = r.last_with("\"status\":\"");
    const size_t p = a.find("\"reason\":\"");
    return p == std::string::npos ? "" : a.substr(p + 10, a.find('"', p + 10) - (p + 10));
}
static void ready(Rig& r) { r.dev.set_watchdog_active(true); r.dev.set_secure_session(true); r.run(300); r.send("HEARTBEAT"); r.last_hb_t = r.t; }   // a few control cycles, then an authorised heartbeat

void test_strict_start_refused_until_limits_approved() {
    Rig r(true, sim_limits(), false, /*approved*/ false, /*wired*/ true, /*secured*/ true); ready(r);
    TEST_ASSERT_EQUAL_STRING("LIMITS_NOT_APPROVED", start_reason(r).c_str());
    r.run(500);
    TEST_ASSERT_EQUAL_FLOAT(0.0f, r.act.duty_pct);                 // nothing was energised
    TEST_ASSERT_FALSE(r.act.driver_enable);
}

void test_strict_start_refused_until_an_estop_input_is_declared_wired() {
    Rig r(true, sim_limits(), false, true, /*wired*/ false, /*secured*/ true); ready(r);
    TEST_ASSERT_EQUAL_STRING("ESTOP_INPUT_NOT_VERIFIED", start_reason(r).c_str());
}

void test_strict_start_refused_while_the_watchdog_is_not_active() {
    Rig r(true, sim_limits(), false, true, true, /*secured*/ true); r.dev.set_secure_session(true); r.run(300);       // watchdog NOT reported active
    TEST_ASSERT_EQUAL_STRING("WATCHDOG_NOT_ACTIVE", start_reason(r).c_str());
}

void test_strict_start_refused_before_the_first_control_cycle() {
    Rig r(true, sim_limits(), false, true, true, /*secured*/ true); r.dev.set_watchdog_active(true); r.dev.set_secure_session(true);
    TEST_ASSERT_EQUAL_STRING("NOT_INITIALIZED", start_reason(r).c_str());
}

void test_strict_start_refused_without_an_authorised_heartbeat() {
    Rig r(true, sim_limits(), false, true, true, /*secured*/ true); r.dev.set_watchdog_active(true); r.dev.set_secure_session(true);
    r.auto_hb = false; r.run(300);
    TEST_ASSERT_EQUAL_STRING("NO_HEARTBEAT", start_reason(r).c_str());
}

void test_strict_start_refused_on_stale_telemetry_and_wrap_safe() {
    Rig r(true, sim_limits(), false, true, true, /*secured*/ true); ready(r);
    r.t += 600;                                                      // control loop silent for 600 ms; heartbeat window (2 s) still open
    TEST_ASSERT_EQUAL_STRING("TELEMETRY_STALE", start_reason(r).c_str());
    // millis() rollover: a snapshot taken just before the wrap and a start request just after it is fresh; 600 ms later is stale.
    Device d(sim_limits(), sim_cfg(false, false, true, true, true));      // control not enabled (the shipped build): no heartbeat is expected
    d.set_watchdog_active(true); d.set_secure_session(true);
    HalIn in = {};
    in.now_ms = 0xFFFFFFF0u; in.current_valid = in.voltage_valid = in.housing_valid = in.rpm_valid = true;
    in.voltage_v = 24.0f; in.housing_c = 30.0f;
    d.step(in);
    d.on_line("{\"id\":1,\"type\":\"HEARTBEAT\",\"p\":0,\"p2\":0,\"p3\":0,\"ttl\":5000,\"age\":0,\"seq\":1,\"k\":\"sim-key\"}", 0xFFFFFFF8u);
    TEST_ASSERT_NULL(d.start_blocked_reason(0x00000010u));         // age 32 ms across the wrap
    TEST_ASSERT_EQUAL_STRING("TELEMETRY_STALE", d.start_blocked_reason(0x00000260u));   // age ~624 ms across the wrap
}

void test_strict_start_refused_for_invalid_nan_or_infinite_required_sensors() {
    for (int mode = 0; mode < 5; mode++) {
        Rig r(true, sim_limits(), false, true, true, /*secured*/ true); ready(r);
        HalIn in = r.plant.step(10, r.act, false); r.t = in.now_ms;
        if (mode == 0) in.housing_c = NAN;
        else if (mode == 1) in.current_a = INFINITY;
        else if (mode == 2) in.voltage_valid = false;
        else if (mode == 3) in.rpm_valid = false;
        else in.housing_valid = false;
        r.act = r.dev.step(in); r.drain();
        TEST_ASSERT_EQUAL_STRING("SENSOR_NOT_VALID", start_reason(r).c_str());
        TEST_ASSERT_FALSE(r.act.driver_enable);
    }
}

void test_strict_start_permitted_only_when_every_interlock_passes_and_then_ramps() {
    Rig r(true, sim_limits(), false, true, true, /*secured*/ true); ready(r);
    TEST_ASSERT_EQUAL_STRING("OK", start_reason(r).c_str());
    r.run(2000);
    TEST_ASSERT_TRUE(r.act.driver_enable);
    TEST_ASSERT_TRUE(r.act.duty_pct > 0.0f);
}

void test_stop_is_never_blocked_by_the_interlocks() {
    Rig r(true, sim_limits(), false, false, false, /*secured*/ true);                 // nothing approved, nothing initialised
    r.out.clear(); r.send("STOP");
    TEST_ASSERT_TRUE(r.has("\"status\":\"ACCEPTED\""));
    TEST_ASSERT_TRUE(r.has("STOPPED"));
}

void test_latched_trip_blocks_start_and_does_not_restart_after_reset() {
    Rig r(true, sim_limits(), false, true, true, /*secured*/ true); ready(r);
    r.send("START", 30); r.run(2000);
    TEST_ASSERT_TRUE(r.act.driver_enable);
    r.plant.faults.estop_pressed = true; r.run(100);                 // external E-stop input -> device trips
    TEST_ASSERT_FALSE(r.act.driver_enable);
    TEST_ASSERT_EQUAL(SafetyState::EMERGENCY_STOP, r.dev.safety().state());
    r.plant.faults.estop_pressed = false; r.run(3000);               // the condition clears: the latch must NOT clear by itself
    TEST_ASSERT_EQUAL(SafetyState::EMERGENCY_STOP, r.dev.safety().state());
    TEST_ASSERT_FALSE(r.act.driver_enable);
    TEST_ASSERT_EQUAL_STRING("ESTOP_LATCHED", start_reason(r).c_str());
    r.send("RESET_ESTOP"); r.button = true; r.run(300); r.button = false;   // authorised command + local button
    TEST_ASSERT_EQUAL(SafetyState::OK, r.dev.safety().state());
    r.run(3000);
    TEST_ASSERT_FALSE(r.act.driver_enable);                          // reset never restarts the motor
    TEST_ASSERT_EQUAL_FLOAT(0.0f, r.act.duty_pct);
    TEST_ASSERT_EQUAL(DriveMode::IDLE, r.dev.drive().mode());
}

void test_duplicate_stop_and_rejected_start_are_harmless() {
    Rig r(true, sim_limits(), false, false, false, /*secured*/ true); ready(r);
    for (int i = 0; i < 3; i++) { r.send("STOP"); r.send("START", 30); }
    r.run(500);
    TEST_ASSERT_FALSE(r.act.driver_enable);
    TEST_ASSERT_EQUAL_FLOAT(0.0f, r.act.duty_pct);
}

static void raw(Rig& r, const char* line) { r.dev.on_line(line, r.t); r.drain(); }

void test_strict_start_refused_until_the_transport_is_declared_secured() {
    Rig r(true, sim_limits(), false, true, true, /*secured*/ false); ready(r);
    TEST_ASSERT_EQUAL_STRING("TRANSPORT_NOT_SECURED", start_reason(r).c_str());
    r.run(500);
    TEST_ASSERT_FALSE(r.act.driver_enable);
}

void test_asserted_estop_input_inhibits_start() {
    Rig r(true, sim_limits(), false, true, true, true); ready(r);
    r.plant.faults.estop_pressed = true; r.run(30);
    const std::string why = start_reason(r);
    TEST_ASSERT_TRUE(why == "ESTOP_LATCHED" || why == "ESTOP_ACTIVE");
    TEST_ASSERT_FALSE(r.act.driver_enable);
}

void test_power_up_state_is_off_and_never_starts_by_itself() {
    Rig r(true, sim_limits(), false, true, true, true);                // everything permitted, but nobody asked for motion
    r.dev.set_watchdog_active(true); r.dev.set_secure_session(true);
    r.run(5000);
    TEST_ASSERT_FALSE(r.act.driver_enable);
    TEST_ASSERT_FALSE(r.act.relay_on);
    TEST_ASSERT_EQUAL_FLOAT(0.0f, r.act.duty_pct);
    TEST_ASSERT_EQUAL(DriveMode::IDLE, r.dev.drive().mode());
}

void test_stop_takes_effect_even_when_the_telemetry_queue_is_full_and_never_drained() {
    Rig r(true, sim_limits(), false, true, true, true); ready(r);
    r.send("START", 30); r.run(1500);
    TEST_ASSERT_TRUE(r.act.driver_enable);
    for (int i = 0; i < 800; i++) {                                    // 8 s of control cycles with NOBODY reading the output queue (slow/stalled logging)
        if (i % 50 == 0) r.dev.on_line("{\"id\":9000,\"type\":\"HEARTBEAT\",\"p\":0,\"p2\":0,\"p3\":0,\"ttl\":5000,\"age\":0,\"seq\":1,\"k\":\"sim-key\"}", r.t);
        HalIn in = r.plant.step(10, r.act, false); r.t = in.now_ms; r.act = r.dev.step(in);
    }
    r.dev.on_line("{\"id\":9100,\"type\":\"STOP\",\"p\":0,\"p2\":0,\"p3\":0,\"ttl\":1000,\"age\":0,\"seq\":0,\"k\":\"\"}", r.t);   // no key, no seq: STOP is never refused
    HalIn in = r.plant.step(10, r.act, false); r.t = in.now_ms; r.act = r.dev.step(in);
    TEST_ASSERT_FALSE(r.act.driver_enable);
    TEST_ASSERT_EQUAL_FLOAT(0.0f, r.act.duty_pct);
}

void test_unauthenticated_malformed_oversized_and_stale_commands_are_rejected() {
    Rig r(true, sim_limits(), false, true, true, true); ready(r);
    r.out.clear();
    r.send("START", 30, 0, 0, "wrong-key");
    TEST_ASSERT_TRUE(r.has("UNAUTHORIZED"));
    raw(r, "not json at all"); raw(r, "{\"type\":\"START\"}"); raw(r, "{\"id\":5,\"type\":\"START\",\"p\":30,\"ttl\":5000,\"seq\":50,\"k\":");   // truncated
    std::string big(600, 'A');
    raw(r, ("{\"id\":6,\"type\":\"START\",\"p\":30,\"ttl\":5000,\"seq\":51,\"k\":\"" + big + "\"}").c_str());                                   // oversized key
    raw(r, "{\"id\":7,\"type\":\"START\",\"p\":30,\"p2\":0,\"p3\":0,\"ttl\":1000,\"age\":1000,\"seq\":60,\"k\":\"sim-key\"}");                     // already expired
    raw(r, "{\"id\":8,\"type\":\"START\",\"p\":30,\"p2\":0,\"p3\":0,\"ttl\":99999,\"age\":0,\"seq\":61,\"k\":\"sim-key\"}");                        // ttl beyond the 30 s cap
    r.run(300);
    TEST_ASSERT_FALSE(r.act.driver_enable);                           // none of them moved the motor
    TEST_ASSERT_TRUE(r.has("EXPIRED")); TEST_ASSERT_TRUE(r.has("BAD_TTL"));
}

void test_replayed_commands_are_not_executed_twice_and_old_sequence_numbers_are_refused() {
    Rig r(true, sim_limits(), false, true, true, true); ready(r);
    const char* start = "{\"id\":500,\"type\":\"START\",\"p\":30,\"p2\":0,\"p3\":0,\"ttl\":5000,\"age\":0,\"seq\":500,\"k\":\"sim-key\"}";
    raw(r, start); r.run(1500);
    TEST_ASSERT_TRUE(r.act.driver_enable);
    r.send("STOP"); r.run(300);
    TEST_ASSERT_FALSE(r.act.driver_enable);
    raw(r, start); r.run(1500);                                       // exact replay while its id is still remembered: original ack, NOT re-executed
    TEST_ASSERT_FALSE(r.act.driver_enable);
    for (int i = 0; i < 20; i++) r.send("HEARTBEAT");                  // evict the id from the 16-entry duplicate cache
    r.out.clear(); raw(r, start); r.run(500);                         // now only the sequence rule protects: seq 500 <= last
    TEST_ASSERT_FALSE(r.act.driver_enable);
}

void test_a_captured_command_replayed_after_a_reboot_cannot_start_the_motor_because_a_reboot_has_no_session() {
    const char* hb = "{\"id\":1,\"type\":\"HEARTBEAT\",\"p\":0,\"p2\":0,\"p3\":0,\"ttl\":5000,\"age\":0,\"seq\":1,\"k\":\"sim-key\"}";
    const char* start = "{\"id\":2,\"type\":\"START\",\"p\":30,\"p2\":0,\"p3\":0,\"ttl\":5000,\"age\":0,\"seq\":2,\"k\":\"sim-key\"}";
    Rig first(true, sim_limits(), false, true, true, /*secured*/ true); first.dev.set_watchdog_active(true); first.dev.set_secure_session(true);
    first.run(300); raw(first, hb); raw(first, start); first.run(1500);
    TEST_ASSERT_TRUE(first.act.driver_enable);                       // inside an authenticated session the start works
    Rig rebooted(true, sim_limits(), false, true, true, true); rebooted.dev.set_watchdog_active(true);    // a fresh Device = a power cycle: sequence memory AND session are gone
    rebooted.run(300); rebooted.out.clear();
    raw(rebooted, hb);
    TEST_ASSERT_TRUE(rebooted.has("NO_SECURE_SESSION"));            // before any session exists even a captured heartbeat is refused (strict mode)
    rebooted.out.clear(); raw(rebooted, start);
    TEST_ASSERT_TRUE(rebooted.has("NO_SECURE_SESSION"));            // and so is the captured START: motion needs a fresh authenticated session, which a replay cannot create
    rebooted.run(500);
    TEST_ASSERT_FALSE(rebooted.act.driver_enable);
}

void test_losing_the_secure_session_stops_a_running_motor_and_blocks_restart() {
    Rig r(true, sim_limits(), false, true, true, true); ready(r);
    r.send("START", 30); r.run(2000);
    TEST_ASSERT_TRUE(r.act.driver_enable);
    r.dev.set_secure_session(false);                                  // link dropped / session expired / revoked
    r.run(50);
    TEST_ASSERT_FALSE(r.act.driver_enable);
    TEST_ASSERT_EQUAL(DriveMode::IDLE, r.dev.drive().mode());
    TEST_ASSERT_EQUAL_STRING("NO_SECURE_SESSION", start_reason(r).c_str());
    r.dev.set_secure_session(true); r.run(100);                       // a NEW session does not resume the old motion
    TEST_ASSERT_FALSE(r.act.driver_enable);
}

void test_a_session_cannot_be_inherited_a_fresh_device_never_has_one() {
    Device d(sim_limits(), sim_cfg(false, false, true, true, true));      // control not enabled (the shipped build): no heartbeat is expected
    TEST_ASSERT_FALSE(d.secure_session());
}

void test_stop_works_without_a_session_and_without_authentication() {
    Rig r(true, sim_limits(), false, true, true, true); ready(r);
    r.send("START", 30); r.run(1500);
    TEST_ASSERT_TRUE(r.act.driver_enable);
    r.dev.set_secure_session(false);                                  // no session
    r.dev.on_line("{\"id\":777,\"type\":\"STOP\",\"p\":0,\"p2\":0,\"p3\":0,\"ttl\":1000,\"age\":0,\"seq\":0,\"k\":\"\"}", r.t);      // and no key
    r.run(50);
    TEST_ASSERT_FALSE(r.act.driver_enable);
}

void test_a_boot_fault_latches_until_an_intentional_reset_and_never_restarts_the_motor() {
    Rig r(true, sim_limits(), false, true, true, true);
    r.dev.latch_boot_fault(TripReason::RESET_FAULT);                  // what main.cpp does after a watchdog / brown-out / panic reset
    ready(r);
    TEST_ASSERT_EQUAL(SafetyState::EMERGENCY_STOP, r.dev.safety().state());
    TEST_ASSERT_EQUAL_STRING("ESTOP_LATCHED", start_reason(r).c_str());
    r.run(3000);
    TEST_ASSERT_EQUAL(SafetyState::EMERGENCY_STOP, r.dev.safety().state());   // normal readings do not clear it
    TEST_ASSERT_TRUE(r.has("RESET_FAULT"));                           // and it is visible in the status frames
    r.send("RESET_ESTOP"); r.button = true; r.run(300); r.button = false;
    TEST_ASSERT_EQUAL(SafetyState::OK, r.dev.safety().state());
    r.run(2000);
    TEST_ASSERT_FALSE(r.act.driver_enable);                           // no automatic restart
}

void test_an_output_initialisation_fault_latches_blocks_start_and_is_reported() {
    Rig r(true, sim_limits(), false, true, true, true);
    r.dev.latch_boot_fault(TripReason::OUTPUT_INIT_FAULT);            // what main.cpp does when the motor-driver PWM cannot be set up
    ready(r);
    TEST_ASSERT_EQUAL(SafetyState::EMERGENCY_STOP, r.dev.safety().state());
    TEST_ASSERT_EQUAL_STRING("ESTOP_LATCHED", start_reason(r).c_str());
    r.run(2000);
    TEST_ASSERT_TRUE(r.has("OUTPUT_INIT_FAULT"));
    TEST_ASSERT_FALSE(r.act.driver_enable);
    r.button = true; r.send("RESET_ESTOP"); r.run(300); r.button = false;                // with the button the intentional reset exists; without a wired button none does
    TEST_ASSERT_EQUAL(SafetyState::OK, r.dev.safety().state());
    r.run(1000);
    TEST_ASSERT_FALSE(r.act.driver_enable);                           // and the reset never restarts the motor
}

static std::vector<std::string> run_with_accel(bool supported, bool valid, float mag) {
    DeviceConfig c = sim_cfg(true, true); c.accel_supported = supported;
    Device d(sim_limits(), c);
    SimPlant plant; HalOut act = {false, 0, false}; std::vector<std::string> out;
    for (int i = 0; i < 150; i++) {
        HalIn in = plant.step(10, act, false);
        in.acc_valid = valid; in.acc_x_g = 0.01f; in.acc_y_g = -0.02f; in.acc_z_g = 0.99f; in.acc_mag_g = mag;
        act = d.step(in);
        char b[320]; while (d.pop_line(b, sizeof(b))) out.push_back(b);
    }
    return out;
}

void test_accel_frames_carry_raw_axes_and_a_total_magnitude_only_when_valid() {
    std::vector<std::string> out = run_with_accel(true, true, 0.99f);
    int n = 0;
    for (size_t i = 0; i < out.size(); i++) if (out[i].find("\"t\":\"accel\"") != std::string::npos) {
        n++;
        TEST_ASSERT_NOT_NULL(strstr(out[i].c_str(), "\"ok\":1")); TEST_ASSERT_NOT_NULL(strstr(out[i].c_str(), "\"ax\":0.010"));
        TEST_ASSERT_NOT_NULL(strstr(out[i].c_str(), "\"mag\":0.990")); TEST_ASSERT_NULL(strstr(out[i].c_str(), "vib"));      // never labelled as vibration
        TEST_ASSERT_TRUE(out[i].size() < 288);
    }
    TEST_ASSERT_TRUE(n >= 6);                                          // ~5 Hz for 1.5 s
}

void test_invalid_or_non_finite_accelerometer_data_sends_ok_zero_without_numbers_and_unsupported_builds_send_nothing() {
    std::vector<std::string> bad = run_with_accel(true, false, 0.0f), nan_ = run_with_accel(true, true, NAN), none = run_with_accel(false, true, 0.99f);
    for (size_t k = 0; k < 2; k++) {
        const std::vector<std::string>& v = k == 0 ? bad : nan_;
        int n = 0;
        for (size_t i = 0; i < v.size(); i++) if (v[i].find("\"t\":\"accel\"") != std::string::npos) {
            n++; TEST_ASSERT_NOT_NULL(strstr(v[i].c_str(), "\"ok\":0")); TEST_ASSERT_NULL(strstr(v[i].c_str(), "\"mag\"")); TEST_ASSERT_NULL(strstr(v[i].c_str(), "\"ax\""));
        }
        TEST_ASSERT_TRUE(n >= 6);
    }
    for (size_t i = 0; i < none.size(); i++) TEST_ASSERT_NULL(strstr(none[i].c_str(), "\"t\":\"accel\""));      // a build without the sensor invents nothing
}

void test_strict_device_idle_with_no_motor_supply_stays_ok_and_reports_the_supply_interlock() {
    Device d(sim_limits(), sim_cfg(false, false, true, true, true));      // control not enabled (the shipped build): no heartbeat is expected
    HalIn in = {};
    for (uint32_t t = 0; t < 3000; t += 10) {
        in.now_ms = t; in.current_a = 0.0f; in.current_valid = true; in.voltage_v = 0.0f; in.voltage_valid = true;      // INA219 answers, motor rail is at 0 V
        in.housing_c = 25.0f; in.housing_valid = true; in.rpm = 0.0f; in.rpm_valid = true;
        d.step(in);
    }
    Device::DisplayInfo di; d.display_info(&di, 3000);
    TEST_ASSERT_EQUAL_MESSAGE(0, (int)di.reason, trip_reason_name(di.reason));
    TEST_ASSERT_EQUAL(SafetyState::OK, di.state);                      // no latched emergency stop for an absent supply
    TEST_ASSERT_TRUE(di.voltage_valid);                                // 0 V is a valid measurement, shown as a number
    TEST_ASSERT_TRUE(strlen(di.start_block) > 0);                      // but motion stays refused (session/heartbeat/supply...)
    in.voltage_valid = false; in.now_ms = 3010; d.step(in);            // a sensor that stops answering is still invalid, never shown as a number
    d.display_info(&di, 3010); TEST_ASSERT_FALSE(di.voltage_valid);
}

// ---------------- authenticated session through the whole Device (strict mode) ----------------
static uint32_t g_arng = 7;
static uint32_t arand() { g_arng = g_arng * 1103515245u + 12345u; return g_arng; }
static std::string last_line(Device& d) { char b[320]; std::string out; while (d.pop_line(b, sizeof(b))) out += std::string(b) + "\n"; return out; }
static std::string field(const std::string& l, const char* name, size_t len) { std::string k = std::string("\"") + name + "\":\""; size_t p = l.find(k); return p == std::string::npos ? "" : l.substr(p + k.size(), len); }
static std::string hmachex(const uint8_t* key, const std::string& msg, size_t bytes) { uint8_t d[32]; char h[65]; hmac_sha256(key, 32, msg.data(), msg.size(), d); to_hex(d, bytes, h); return h; }

static int g_persisted = 0; static uint16_t g_persisted_ver = 0;
static void test_persist(const RuntimeLimits& r) { g_persisted++; g_persisted_ver = r.version; }

struct AuthRig {
    Device dev; uint8_t key[32]; uint8_t sk[32]; std::string sid; uint32_t now; uint32_t seq;
    static DeviceConfig cfg(uint8_t* key, bool approved = true) {
        DeviceConfig c = sim_cfg(true, false, approved, true, true); c.persist_cfg = test_persist;
        c.device_id = "RIG-1"; c.auth_enabled = true; c.rand32 = arand;
        for (int i = 0; i < 32; i++) key[i] = c.auth_key[i] = (uint8_t)(i * 5 + 1);
        return c;
    }
    AuthRig(uint8_t* k, bool approved = true) : dev(sim_limits(), cfg(k, approved)), now(1000), seq(0) { memcpy(key, k, 32); }
    bool login(uint32_t ttl = 60000) {
        const std::string cn = "00112233445566778899aabbccddeeff";
        dev.on_line(("{\"t\":\"hello\",\"cn\":\"" + cn + "\"}").c_str(), now);
        std::string ch = last_line(dev); std::string dn = field(ch, "dn", 32);
        if (dn.size() != 32 || field(ch, "proof", 64) != hmachex(key, "dev|" + cn + "|" + dn + "|RIG-1", 32)) return false;
        char t[16]; snprintf(t, sizeof(t), "%lu", (unsigned long)ttl);
        dev.on_line(("{\"t\":\"auth\",\"proof\":\"" + hmachex(key, "cli|" + dn + "|" + cn + "|RIG-1|" + t, 32) + "\",\"ttl\":" + t + "}").c_str(), now + 5);
        std::string ok = last_line(dev); sid = field(ok, "sid", 16);
        if (sid.size() != 16) return false;
        std::string skm = "sk|" + cn + "|" + dn; hmac_sha256(key, 32, skm.data(), skm.size(), sk);
        return true;
    }
    std::string send(const char* type, float p, bool good_mac = true, bool with_key = false) {
        seq++;
        char canon[200], line[300];
        snprintf(canon, sizeof(canon), "%lu|%s|%.3f|%.3f|%.3f|%lu|%lu|%lu|%s", (unsigned long)(100 + seq), type, (double)p, 0.0, 0.0, 5000ul, (unsigned long)seq, 0ul, sid.c_str());
        uint8_t d[32]; char m[33]; hmac_sha256(sk, 32, canon, strlen(canon), d); to_hex(d, 16, m); if (!good_mac) m[0] = (m[0] == 'a') ? 'b' : 'a';
        snprintf(line, sizeof(line), "{\"id\":%lu,\"type\":\"%s\",\"p\":%.3f,\"p2\":0.000,\"p3\":0.000,\"ttl\":5000,\"age\":0,\"seq\":%lu,\"sid\":\"%s\",\"m\":\"%s\"%s}",
                 (unsigned long)(100 + seq), type, (double)p, (unsigned long)seq, sid.c_str(), m, with_key ? ",\"k\":\"sim-key\"" : "");
        dev.on_line(line, now); return last_line(dev);
    }
};

void test_authenticated_session_gates_every_command_and_never_blocks_stop() {
    uint8_t k[32]; AuthRig r(k);
    r.dev.on_line("{\"id\":1,\"type\":\"STOP\",\"ttl\":5000,\"seq\":1,\"age\":0,\"k\":\"sim-key\"}", r.now);
    TEST_ASSERT_NOT_NULL(strstr(last_line(r.dev).c_str(), "ACCEPTED"));                                 // STOP needs no session
    r.dev.on_line("{\"id\":2,\"type\":\"START\",\"p\":20,\"ttl\":5000,\"seq\":2,\"age\":0,\"k\":\"sim-key\"}", r.now);
    TEST_ASSERT_NOT_NULL(strstr(last_line(r.dev).c_str(), "NO_SECURE_SESSION"));                        // the plaintext key opens nothing
    TEST_ASSERT_TRUE(r.login());
    std::string a = r.send("START", 20.0f, false);
    TEST_ASSERT_NOT_NULL(strstr(a.c_str(), "BAD_MAC")); TEST_ASSERT_NULL(strstr(a.c_str(), "ACCEPTED"));
    a = r.send("START", 20.0f, true, true);
    TEST_ASSERT_NULL(strstr(a.c_str(), "BAD_MAC")); TEST_ASSERT_NULL(strstr(a.c_str(), "NO_SECURE_SESSION")); TEST_ASSERT_NULL(strstr(a.c_str(), "WRONG_SESSION"));       // authentic: now it is the interlocks' decision
    a = r.send("STOP", 0.0f, false);
    TEST_ASSERT_NOT_NULL(strstr(a.c_str(), "ACCEPTED"));                                                // even a bad-MAC STOP is honoured: it can only make things safer
    TEST_ASSERT_FALSE(r.dev.start_blocked_reason(r.now) == nullptr);                                    // and START is still refused by the other interlocks (heartbeat, sensors, ...)
}

void test_a_captured_authentic_command_cannot_be_replayed_or_survive_expiry_or_a_new_login() {
    uint8_t k[32]; AuthRig r(k); TEST_ASSERT_TRUE(r.login(30000));
    char line[300]; std::string a = r.send("SET_SPEED", 10.0f);
    TEST_ASSERT_NULL(strstr(a.c_str(), "BAD_MAC")); TEST_ASSERT_NULL(strstr(a.c_str(), "REPLAY"));
    snprintf(line, sizeof(line), "{\"id\":101,\"type\":\"SET_SPEED\",\"p\":10.000,\"p2\":0.000,\"p3\":0.000,\"ttl\":5000,\"age\":0,\"seq\":1,\"sid\":\"%s\",\"m\":\"%s\"}", r.sid.c_str(), "x");
    r.dev.on_line(line, r.now);
    TEST_ASSERT_NOT_NULL(strstr(last_line(r.dev).c_str(), "BAD_MAC"));
    const uint32_t saved_seq = r.seq; std::string old_sid = r.sid;
    r.seq = saved_seq - 1;                                                                              // re-send the same counter with a fresh, valid MAC
    TEST_ASSERT_NOT_NULL(strstr(r.send("SET_SPEED", 10.0f).c_str(), "REPLAY"));
    r.now += 40000; HalIn in = {}; in.now_ms = r.now; r.dev.step(in);                                   // past the 30 s ttl
    TEST_ASSERT_FALSE(r.dev.secure_session());                                                          // expiry ends the session (and stops motion)
    TEST_ASSERT_NOT_NULL(strstr(r.send("SET_SPEED", 10.0f).c_str(), "NO_SECURE_SESSION"));
    TEST_ASSERT_TRUE(r.login()); TEST_ASSERT_TRUE(r.sid != old_sid);                                    // a new login gives a new session id
    r.seq = 0;
    std::string stale = r.send("SET_SPEED", 10.0f); TEST_ASSERT_NULL(strstr(stale.c_str(), "NO_SECURE_SESSION"));
}

// ---------------- runtime-configurable limits over the authenticated session ----------------
struct CfgRig : AuthRig {
    CfgRig(uint8_t* k, bool approved = false) : AuthRig(k, approved) { HalIn in = {}; in.now_ms = now; dev.step(in); }       // one control iteration so the device is initialised
    std::string cfg(uint16_t ver, const char* ci = "3.000", const char* vl = "18.000", const char* vh = "26.000", const char* ct = "60.000", const char* rp = "3000.000", const char* dp = "30.000",
                    bool good_mac = true, bool bump_seq = true, const char* sid_override = nullptr) {
        if (bump_seq) seq++;
        const std::string use_sid = sid_override ? sid_override : sid;
        char canon[220], line[300];
        snprintf(canon, sizeof(canon), "cfg|%u|%lu|%lu|%s|%s|%s|%s|%s|%s|%s", (unsigned)ver, (unsigned long)(900 + seq), (unsigned long)seq, use_sid.c_str(), ci, vl, vh, ct, rp, dp);
        uint8_t d[32]; char m[33]; hmac_sha256(sk, 32, canon, strlen(canon), d); to_hex(d, 16, m); if (!good_mac) m[0] = (m[0] == 'a') ? 'b' : 'a';
        snprintf(line, sizeof(line), "{\"t\":\"cfg\",\"ver\":%u,\"id\":%lu,\"seq\":%lu,\"sid\":\"%s\",\"ci\":%s,\"vl\":%s,\"vh\":%s,\"ct\":%s,\"rp\":%s,\"dp\":%s,\"m\":\"%s\"}",
                 (unsigned)ver, (unsigned long)(900 + seq), (unsigned long)seq, use_sid.c_str(), ci, vl, vh, ct, rp, dp, m);
        dev.on_line(line, now); return last_line(dev);
    }
};

void test_an_authenticated_configuration_approves_limits_applies_them_and_is_reported_in_status() {
    g_persisted = 0;
    uint8_t k[32]; CfgRig r(k);
    TEST_ASSERT_EQUAL_STRING("LIMITS_NOT_APPROVED", r.dev.start_blocked_reason(r.now));                         // nothing is defaulted: no configuration, no motion
    TEST_ASSERT_EQUAL(0, r.dev.cfg_version());
    TEST_ASSERT_TRUE(r.login());
    std::string a = r.cfg(2);
    TEST_ASSERT_NOT_NULL(strstr(a.c_str(), "\"t\":\"cfg_ack\"")); TEST_ASSERT_NOT_NULL(strstr(a.c_str(), "\"ok\":1")); TEST_ASSERT_NOT_NULL(strstr(a.c_str(), "\"ver\":2"));
    TEST_ASSERT_EQUAL(2, r.dev.cfg_version()); TEST_ASSERT_EQUAL(1, g_persisted); TEST_ASSERT_EQUAL(2, g_persisted_ver);                  // stored for audit only
    TEST_ASSERT_TRUE(strcmp(r.dev.start_blocked_reason(r.now), "LIMITS_NOT_APPROVED") != 0);                    // the limits gate is satisfied; other interlocks still decide
    const Limits& l = r.dev.limits();
    TEST_ASSERT_EQUAL_FLOAT(3.0f, l.current_stop_a); TEST_ASSERT_EQUAL_FLOAT(3.75f, l.current_inst_a); TEST_ASSERT_EQUAL_FLOAT(18.0f, l.volt_min_v); TEST_ASSERT_EQUAL_FLOAT(26.0f, l.volt_max_v);
    TEST_ASSERT_EQUAL_FLOAT(60.0f, l.temp_stop_c); TEST_ASSERT_EQUAL_FLOAT(50.0f, l.temp_warn_c); TEST_ASSERT_EQUAL_FLOAT(3000.0f, l.max_rpm); TEST_ASSERT_EQUAL_FLOAT(30.0f, l.max_duty_pct);
    HalIn in = {}; in.now_ms = r.now + 1100; in.housing_valid = true; in.housing_c = 25.0f; r.dev.step(in);       // status frame carries the accepted version
    TEST_ASSERT_NOT_NULL(strstr(last_line(r.dev).c_str(), "\"cfg\":2"));
}

void test_a_configuration_without_authentication_or_with_tampering_replay_rollback_or_bad_values_changes_nothing() {
    g_persisted = 0;
    uint8_t k[32]; CfgRig r(k);
    std::string a = r.cfg(2, "3.000", "18.000", "26.000", "60.000", "3000.000", "30.000", true, true, "0123456789abcdef");        // no session yet
    TEST_ASSERT_NOT_NULL(strstr(a.c_str(), "NO_SECURE_SESSION")); TEST_ASSERT_EQUAL(0, r.dev.cfg_version());
    TEST_ASSERT_TRUE(r.login());
    TEST_ASSERT_NOT_NULL(strstr(r.cfg(2, "3.000", "18.000", "26.000", "60.000", "3000.000", "30.000", false).c_str(), "BAD_MAC")); TEST_ASSERT_EQUAL(0, r.dev.cfg_version());
    TEST_ASSERT_NOT_NULL(strstr(r.cfg(2, "3.000", "18.000", "26.000", "60.000", "3000.000", "30.000", true, true, "0123456789abcdef").c_str(), "WRONG_SESSION"));
    TEST_ASSERT_NOT_NULL(strstr(r.cfg(2, "9.000").c_str(), "CURRENT_OUT_OF_RANGE"));                                              // above the sensor's measurement ceiling
    TEST_ASSERT_NOT_NULL(strstr(r.cfg(2, "3.000", "26.000", "18.000").c_str(), "VOLTAGE_OUT_OF_RANGE"));                         // min above max
    TEST_ASSERT_NOT_NULL(strstr(r.cfg(2, "3.000", "18.000", "26.000", "200.000").c_str(), "TEMPERATURE_OUT_OF_RANGE"));
    TEST_ASSERT_NOT_NULL(strstr(r.cfg(2, "3.000", "18.000", "26.000", "60.000", "0.000").c_str(), "RPM_OUT_OF_RANGE"));
    TEST_ASSERT_NOT_NULL(strstr(r.cfg(2, "3.000", "18.000", "26.000", "60.000", "3000.000", "101.000").c_str(), "DUTY_OUT_OF_RANGE"));
    TEST_ASSERT_NOT_NULL(strstr(r.cfg(2, "nan").c_str(), "INCOMPLETE"));                                                          // non-numeric values never parse
    TEST_ASSERT_EQUAL(0, r.dev.cfg_version()); TEST_ASSERT_EQUAL_STRING("LIMITS_NOT_APPROVED", r.dev.start_blocked_reason(r.now));
    TEST_ASSERT_EQUAL_FLOAT(default_limits().current_stop_a, r.dev.limits().current_stop_a);                                      // nothing was applied
    TEST_ASSERT_NOT_NULL(strstr(r.cfg(3).c_str(), "\"ok\":1")); TEST_ASSERT_EQUAL(3, r.dev.cfg_version());
    r.seq -= 1;                                                                                                                   // the identical counter again, with a valid MAC and a newer version
    TEST_ASSERT_NOT_NULL(strstr(r.cfg(4).c_str(), "REPLAY")); TEST_ASSERT_EQUAL(3, r.dev.cfg_version());
    TEST_ASSERT_NOT_NULL(strstr(r.cfg(3).c_str(), "VERSION_NOT_NEWER"));                                                          // the same version again is not a new approval
    TEST_ASSERT_NOT_NULL(strstr(r.cfg(2).c_str(), "VERSION_NOT_NEWER"));                                                          // rollback refused even with a fresh counter
    TEST_ASSERT_NOT_NULL(strstr(r.cfg(4, "2.500").c_str(), "\"ok\":1")); TEST_ASSERT_EQUAL(4, r.dev.cfg_version());
    TEST_ASSERT_EQUAL_FLOAT(2.5f, r.dev.limits().current_stop_a); TEST_ASSERT_EQUAL(2, g_persisted);                                // only the two accepted configurations were stored
}

void test_a_restored_configuration_sets_the_trip_numbers_but_never_approves_motion_and_the_target_persists_accepted_configurations() {
    uint8_t k[32];
    DeviceConfig c = AuthRig::cfg(k, false);
    Device d(sim_limits(), c);
    RuntimeLimits r = {7, 2.5f, 19.0f, 25.0f, 55.0f, 2500.0f, 25.0f};
    { HalIn in = {}; in.now_ms = 1000; d.step(in); }
    d.restore_runtime_limits(r);
    TEST_ASSERT_EQUAL(0, d.cfg_version());                                                                                       // not approved
    TEST_ASSERT_EQUAL_FLOAT(2.5f, d.limits().current_stop_a); TEST_ASSERT_EQUAL_FLOAT(55.0f, d.limits().temp_stop_c);
    TEST_ASSERT_EQUAL_STRING("LIMITS_NOT_APPROVED", d.start_blocked_reason(1000));
    RuntimeLimits bad = r; bad.max_current_a = NAN; d.restore_runtime_limits(bad);                                                // an invalid stored copy is ignored
    TEST_ASSERT_EQUAL_FLOAT(2.5f, d.limits().current_stop_a);
}

void test_runtime_configuration_validation_mapping_and_codec() {
    RuntimeLimits ok = {2, 3.0f, 18.0f, 26.0f, 60.0f, 3000.0f, 30.0f};
    TEST_ASSERT_NULL(runtime_limits_validate(ok));
    RuntimeLimits b = ok; b.version = 0; TEST_ASSERT_NOT_NULL(runtime_limits_validate(b));
    b = ok; b.max_current_a = INFINITY; TEST_ASSERT_NOT_NULL(runtime_limits_validate(b));
    b = ok; b.volt_max_v = 30.0f; TEST_ASSERT_EQUAL_STRING("VOLTAGE_OUT_OF_RANGE", runtime_limits_validate(b));
    b = ok; b.max_rpm = 40000.0f; TEST_ASSERT_EQUAL_STRING("RPM_OUT_OF_RANGE", runtime_limits_validate(b));
    Limits l = runtime_limits_to_limits(ok, default_limits());
    TEST_ASSERT_EQUAL_FLOAT(default_limits().ramp_pct_per_s, l.ramp_pct_per_s);                                                  // what the operator did not set keeps its value
    char line[300];
    snprintf(line, sizeof(line), "{\"t\":\"cfg\",\"ver\":2,\"id\":5,\"seq\":9,\"sid\":\"abcdef0123456789\",\"ci\":3.000,\"vl\":18.000,\"vh\":26.000,\"ct\":60.000,\"rp\":3000.000,\"dp\":30.000,\"m\":\"%s\"}", "00000000000000000000000000000000");
    TEST_ASSERT_TRUE(is_cfg_line(line)); TEST_ASSERT_FALSE(is_cfg_line("{\"t\":\"hello\"}"));
    CfgMsg m; TEST_ASSERT_NULL(parse_cfg(line, &m));
    TEST_ASSERT_EQUAL(2, m.lim.version); TEST_ASSERT_EQUAL_FLOAT(3.0f, m.lim.max_current_a); TEST_ASSERT_EQUAL_UINT32(9, m.seq);
    char canon[200]; cfg_canonical(m, canon, sizeof(canon));
    TEST_ASSERT_EQUAL_STRING("cfg|2|5|9|abcdef0123456789|3.000|18.000|26.000|60.000|3000.000|30.000", canon);
    TEST_ASSERT_NOT_NULL(parse_cfg("{\"t\":\"cfg\",\"ver\":2}", &m));
    char ack[96]; TEST_ASSERT_TRUE(encode_cfg_ack(ack, sizeof(ack), 2, false, "BAD_MAC") > 0); TEST_ASSERT_EQUAL_STRING("{\"t\":\"cfg_ack\",\"ver\":2,\"ok\":0,\"reason\":\"BAD_MAC\"}", ack);
}

void test_status_frames_report_the_estop_input_state_without_changing_any_decision() {
    DeviceConfig c = sim_cfg(false, false, true, false, true);                     // E-stop input NOT declared installed
    Device d(sim_limits(), c); d.set_secure_session(true);
    const uint8_t states[4] = {0, 1, 2, 3};
    const char* want[4] = {"\"es\":0", "\"es\":1", "\"es\":2", "\"es\":3"};
    for (int i = 0; i < 4; i++) {
        HalIn in = {}; in.now_ms = 1000u * (uint32_t)(i + 1); in.estop_state = states[i]; d.step(in); d.step(in);
        TEST_ASSERT_NOT_NULL(strstr(last_line(d).c_str(), want[i]));
        TEST_ASSERT_EQUAL_STRING("ESTOP_INPUT_NOT_VERIFIED", d.start_blocked_reason(in.now_ms));      // reporting the pin never marks the circuit installed
    }
}

void test_a_pressed_open_or_unread_estop_input_blocks_a_start_in_a_build_that_declares_the_circuit() {
    Device d(sim_limits(), sim_cfg(false, false, true, true, true)); d.set_secure_session(true); d.set_watchdog_active(true);       // E-stop declared installed
    HalIn in = {}; in.now_ms = 1000; in.current_valid = in.voltage_valid = in.housing_valid = in.rpm_valid = true; in.voltage_v = 24.0f;
    const uint8_t blocking[2] = {1, 3};
    for (int i = 0; i < 2; i++) { in.estop_state = blocking[i]; in.now_ms += 10; d.step(in); TEST_ASSERT_EQUAL_STRING("ESTOP_ACTIVE", d.start_blocked_reason(in.now_ms)); }
    in.estop_state = 2; in.now_ms += 10; d.step(in);
    TEST_ASSERT_TRUE(strcmp(d.start_blocked_reason(in.now_ms), "ESTOP_ACTIVE") != 0);                 // released: the E-stop is no longer the reason (other interlocks still decide)
    TEST_ASSERT_EQUAL(SafetyState::OK, d.safety().state());                                           // UNKNOWN / released never latch by themselves
}

void test_a_device_without_a_provisioned_key_can_never_open_a_session() {
    DeviceConfig c = sim_cfg(true, false, true, true, true); c.device_id = "RIG-1";
    Device d(sim_limits(), c);
    d.on_line("{\"t\":\"hello\",\"cn\":\"00112233445566778899aabbccddeeff\"}", 10);
    TEST_ASSERT_NOT_NULL(strstr(last_line(d).c_str(), "NO_KEY")); TEST_ASSERT_FALSE(d.secure_session());
    d.on_line("{\"id\":3,\"type\":\"START\",\"p\":20,\"ttl\":5000,\"seq\":3,\"age\":0,\"k\":\"sim-key\"}", 20);
    TEST_ASSERT_NOT_NULL(strstr(last_line(d).c_str(), "NO_SECURE_SESSION"));
}

void test_display_info_reflects_validity_and_the_safety_state_without_inventing_values() {
    Device d(sim_limits(), sim_cfg(true, false, false, false, false));
    Device::DisplayInfo di;
    d.display_info(&di, 0);
    TEST_ASSERT_FALSE(di.have_data); TEST_ASSERT_FALSE(di.rpm_valid); TEST_ASSERT_FALSE(di.acc_valid);
    HalIn in = {}; in.now_ms = 10; in.housing_c = 31.0f; in.housing_valid = true; in.rpm_valid = false; in.acc_valid = true; in.acc_mag_g = NAN;
    d.step(in); d.display_info(&di, 10);
    TEST_ASSERT_TRUE(di.have_data); TEST_ASSERT_TRUE(di.housing_valid); TEST_ASSERT_FALSE(di.rpm_valid); TEST_ASSERT_FALSE(di.acc_valid);       // NaN magnitude is not valid
    TEST_ASSERT_TRUE(strlen(di.start_block) > 0);                      // strict: motion is locked, and the display says so
}

void test_acknowledgements_carry_the_device_id_when_configured() {
    DeviceConfig c = sim_cfg(true, true); c.device_id = "MOTOR-RIG-01";
    Device d(sim_limits(), c);
    d.on_line("{\"id\":5,\"type\":\"HEARTBEAT\",\"p\":0,\"p2\":0,\"p3\":0,\"ttl\":5000,\"age\":0,\"seq\":1,\"k\":\"sim-key\"}", 0);
    char b[256]; TEST_ASSERT_TRUE(d.pop_line(b, sizeof(b)));
    TEST_ASSERT_NOT_NULL(strstr(b, "\"dev\":\"MOTOR-RIG-01\""));
    Device e(sim_limits(), sim_cfg(true, true));                      // no id configured: the field is omitted (older contract)
    e.on_line("{\"id\":5,\"type\":\"HEARTBEAT\",\"p\":0,\"p2\":0,\"p3\":0,\"ttl\":5000,\"age\":0,\"seq\":1,\"k\":\"sim-key\"}", 0);
    TEST_ASSERT_TRUE(e.pop_line(b, sizeof(b)));
    TEST_ASSERT_NULL(strstr(b, "\"dev\""));
}

static std::string cmd_line(const char* type, unsigned id, unsigned seq, const char* sid, float p = 0) {
    char b[300];
    if (sid) snprintf(b, sizeof(b), "{\"id\":%u,\"type\":\"%s\",\"p\":%g,\"p2\":0,\"p3\":0,\"ttl\":5000,\"age\":0,\"seq\":%u,\"k\":\"sim-key\",\"sid\":\"%s\"}", id, type, p, seq, sid);
    else snprintf(b, sizeof(b), "{\"id\":%u,\"type\":\"%s\",\"p\":%g,\"p2\":0,\"p3\":0,\"ttl\":5000,\"age\":0,\"seq\":%u,\"k\":\"sim-key\"}", id, type, p, seq);
    return b;
}

void test_commands_must_carry_the_live_session_id_and_old_session_ids_are_rejected() {
    Rig r(true, sim_limits(), false, true, true, true); r.dev.set_watchdog_active(true);
    TEST_ASSERT_TRUE(r.dev.begin_session("sess-A"));
    r.auto_hb = false; r.run(300);
    raw(r, cmd_line("HEARTBEAT", 1, 1, "sess-A").c_str());
    TEST_ASSERT_FALSE(r.has("WRONG_SESSION"));
    r.out.clear();
    raw(r, cmd_line("START", 2, 2, nullptr, 30).c_str());              // no session id at all
    raw(r, cmd_line("START", 3, 3, "sess-B", 30).c_str());             // some other session's id
    TEST_ASSERT_EQUAL(2, r.count("WRONG_SESSION"));
    r.run(300);
    TEST_ASSERT_FALSE(r.act.driver_enable);
    r.out.clear();
    raw(r, cmd_line("START", 4, 4, "sess-A", 30).c_str());             // the live session id: accepted
    TEST_ASSERT_TRUE(r.has("\"status\":\"ACCEPTED\""));
    TEST_ASSERT_TRUE(r.has("\"sid\":\"sess-A\""));                     // acknowledgements echo the session id so the backend can bind them
    r.run(1500);
    TEST_ASSERT_TRUE(r.act.driver_enable);
}

void test_a_new_session_replaces_the_old_one_stops_motion_and_makes_old_commands_invalid() {
    Rig r(true, sim_limits(), false, true, true, true); r.dev.set_watchdog_active(true);
    r.dev.begin_session("sess-A"); r.auto_hb = false; r.run(300);
    raw(r, cmd_line("HEARTBEAT", 1, 1, "sess-A").c_str());
    raw(r, cmd_line("START", 2, 2, "sess-A", 30).c_str());
    r.run(1500);
    TEST_ASSERT_TRUE(r.act.driver_enable);
    r.dev.begin_session("sess-B"); r.run(50);                         // reconnect: new session id
    TEST_ASSERT_FALSE(r.act.driver_enable);                           // nothing carries over
    r.out.clear();
    raw(r, cmd_line("START", 3, 3, "sess-A", 30).c_str());            // a pending/captured command of the OLD session
    TEST_ASSERT_TRUE(r.has("WRONG_SESSION"));
    r.run(300);
    TEST_ASSERT_FALSE(r.act.driver_enable);
}

void test_stop_needs_no_session_id_and_session_ids_are_validated() {
    Rig r(true, sim_limits(), false, true, true, true);
    TEST_ASSERT_FALSE(r.dev.begin_session(""));
    TEST_ASSERT_FALSE(r.dev.begin_session("0123456789012345678901234567890123456789"));     // longer than 32
    TEST_ASSERT_FALSE(r.dev.secure_session());
    r.dev.set_watchdog_active(true); r.dev.begin_session("sess-A"); r.auto_hb = false; r.run(300);
    raw(r, cmd_line("HEARTBEAT", 1, 1, "sess-A").c_str());
    raw(r, cmd_line("START", 2, 2, "sess-A", 30).c_str()); r.run(1500);
    TEST_ASSERT_TRUE(r.act.driver_enable);
    raw(r, "{\"id\":9,\"type\":\"STOP\",\"ttl\":1000,\"seq\":0,\"k\":\"\"}"); r.run(50);       // no sid, no key
    TEST_ASSERT_FALSE(r.act.driver_enable);
}

void test_status_frame_reports_protocol_identity_interlock_reason_and_fault_mask() {
    DeviceConfig c = sim_cfg(true, /*relaxed*/ false, false, false, false); c.device_id = "RIG-7";
    Device d(sim_limits(), c);
    SimPlant plant; HalOut act = {false, 0, false}; uint32_t t = 0;
    std::vector<std::string> out;
    for (int i = 0; i < 150; i++) { HalIn in = plant.step(10, act, false); t = in.now_ms; act = d.step(in); char b[320]; while (d.pop_line(b, sizeof(b))) out.push_back(b); }
    std::string st;
    for (size_t i = 0; i < out.size(); i++) if (out[i].find("\"t\":\"status\"") != std::string::npos) st = out[i];
    TEST_ASSERT_TRUE(st.size() > 0 && st.size() < 288);
    TEST_ASSERT_NOT_NULL(strstr(st.c_str(), "\"proto\":1"));
    TEST_ASSERT_NOT_NULL(strstr(st.c_str(), "\"dev\":\"RIG-7\""));
    TEST_ASSERT_NOT_NULL(strstr(st.c_str(), "\"blk\":\"LIMITS_NOT_APPROVED\""));      // the device itself says why motion is not permitted
    TEST_ASSERT_NOT_NULL(strstr(st.c_str(), "\"fm\":0"));
}

// ---------- protocol ----------
void test_parse_valid_command() {
    ParsedCommand pc;
    const char* line = "{\"id\":7,\"type\":\"SET_SPEED\",\"p\":1500,\"p2\":2.5,\"p3\":9,\"ttl\":5000,\"age\":12,\"seq\":3,\"k\":\"abc\"}";
    TEST_ASSERT_NULL(parse_command(line, &pc));
    TEST_ASSERT_EQUAL_UINT32(7, pc.cmd.id);
    TEST_ASSERT_EQUAL(CmdType::SET_SPEED, pc.cmd.type);
    TEST_ASSERT_EQUAL_FLOAT(1500.0f, pc.cmd.param);
    TEST_ASSERT_EQUAL_FLOAT(2.5f, pc.cmd.param2);   // "p2" must not be read as "p"
    TEST_ASSERT_EQUAL_FLOAT(9.0f, pc.cmd.param3);
    TEST_ASSERT_EQUAL_UINT32(12, pc.cmd.age_ms);
    TEST_ASSERT_EQUAL_STRING("abc", pc.key);
}

void test_parse_never_trusts_sender_authorization() {
    ParsedCommand pc;
    TEST_ASSERT_NULL(parse_command("{\"id\":1,\"type\":\"STOP\",\"ttl\":1000,\"seq\":1,\"authorized\":true,\"auth\":1}", &pc));
    TEST_ASSERT_FALSE(pc.cmd.authorized);
}

void test_parse_rejects_garbage() {
    ParsedCommand pc;
    TEST_ASSERT_NOT_NULL(parse_command("", &pc));
    TEST_ASSERT_NOT_NULL(parse_command("hello", &pc));
    TEST_ASSERT_NOT_NULL(parse_command("{\"type\":\"STOP\",\"ttl\":1,\"seq\":1}", &pc));          // no id
    TEST_ASSERT_NOT_NULL(parse_command("{\"id\":-1,\"type\":\"STOP\",\"ttl\":1,\"seq\":1}", &pc)); // negative id
    TEST_ASSERT_NOT_NULL(parse_command("{\"id\":1,\"type\":\"STOP\",\"ttl\":1}", &pc));            // no seq
    char big[400]; memset(big, 'a', sizeof(big)); big[0] = '{'; big[399] = 0;
    TEST_ASSERT_EQUAL_STRING("LINE_TOO_LONG", parse_command(big, &pc));
}

void test_unknown_type_is_rejected_by_device() {
    Rig r;
    r.dev.on_line("{\"id\":9,\"type\":\"FORMAT_DISK\",\"ttl\":1000,\"seq\":1,\"k\":\"sim-key\"}", 0);
    r.drain();
    TEST_ASSERT_TRUE(r.has("\"id\":9,\"status\":\"REJECTED\",\"reason\":\"UNKNOWN_TYPE\""));
}

void test_encoders_fit_and_truncate_safely() {
    char b[256];
    FastFrame f = {1, 100, 1500, 1500, 40, 24, 1.2f, 28.8f, 0x1F};
    size_t n = encode_fast(b, sizeof(b), f);
    TEST_ASSERT_TRUE(n > 0);
    TEST_ASSERT_NOT_NULL(strstr(b, "\"t\":\"fast\""));
    char tiny[16];
    TEST_ASSERT_EQUAL(0, (int)encode_fast(tiny, sizeof(tiny), f));   // too small -> 0, no overflow
}

// ---------- device ----------
void test_hardware_default_rejects_motor_commands() {
    Rig r(false);
    r.send("START", 30);
    r.run(2000);
    TEST_ASSERT_TRUE(r.has("\"reason\":\"NOT_IN_HARDWARE_CONTROL\""));
    TEST_ASSERT_FALSE(r.act.driver_enable);
    TEST_ASSERT_FALSE(r.act.relay_on);
}

void test_wrong_key_cannot_start_motor() {
    Rig r;
    r.send("START", 30, 0, 0, "wrong");
    r.run(2000);
    TEST_ASSERT_TRUE(r.has("\"reason\":\"UNAUTHORIZED\""));
    TEST_ASSERT_FALSE(r.act.driver_enable);
}

void test_start_soft_ramps_and_reaches_duty() {
    Rig r;
    r.send("START", 40);
    float prev = 0, max_step = 0;
    for (int i = 0; i < 100; i++) {   // first second
        r.run(10);
        max_step = fmaxf(max_step, r.act.duty_pct - prev);
        prev = r.act.duty_pct;
    }
    TEST_ASSERT_TRUE(r.act.duty_pct <= 30.5f);
    TEST_ASSERT_TRUE(max_step <= 0.31f);           // <= 30 %/s at 10 ms steps
    r.run(5000);
    TEST_ASSERT_FLOAT_WITHIN(0.5f, 40.0f, r.act.duty_pct);
    TEST_ASSERT_TRUE(r.act.relay_on);
    TEST_ASSERT_EQUAL(SafetyState::OK, r.dev.safety().state());
}

void test_duty_never_exceeds_cap() {
    Rig r;
    r.send("START", 99);                            // rejected by validator
    r.run(3000);
    TEST_ASSERT_TRUE(r.has("DUTY_OUT_OF_RANGE"));
    TEST_ASSERT_TRUE(r.act.duty_pct <= 0.01f);
}

void test_heartbeat_loss_trips_and_latches() {
    Rig r;
    r.send("START", 30);
    r.run(3000);
    TEST_ASSERT_TRUE(r.act.driver_enable);
    r.auto_hb = false;
    r.run(2300);
    TEST_ASSERT_EQUAL(SafetyState::EMERGENCY_STOP, r.dev.safety().state());
    TEST_ASSERT_EQUAL(TripReason::HEARTBEAT_LOST, r.dev.safety().reason());
    TEST_ASSERT_FALSE(r.act.driver_enable);
    TEST_ASSERT_FALSE(r.act.relay_on);
    TEST_ASSERT_TRUE(r.has("\"state\":\"EMERGENCY_STOP\",\"reason\":\"HEARTBEAT_LOST\""));
    r.auto_hb = true;
    r.send("START", 30);
    TEST_ASSERT_TRUE(r.has("ESTOP_LATCHED"));
}

void test_stop_works_with_bad_key_and_stale_age() {
    Rig r;
    r.send("START", 30);
    r.run(2000);
    char line[200];
    snprintf(line, sizeof(line), "{\"id\":500,\"type\":\"STOP\",\"ttl\":0,\"age\":99999,\"seq\":0,\"k\":\"nope\"}");
    r.dev.on_line(line, r.t);
    r.drain();
    r.run(20);
    TEST_ASSERT_FALSE(r.act.driver_enable);
    TEST_ASSERT_TRUE(r.has("\"id\":500,\"status\":\"COMPLETED\",\"reason\":\"STOPPED\""));
}

void test_reset_needs_command_and_local_button() {
    Rig r;
    r.send("START", 30);
    r.run(2000);
    r.plant.faults.estop_pressed = true;
    r.run(50);
    TEST_ASSERT_EQUAL(SafetyState::EMERGENCY_STOP, r.dev.safety().state());
    r.plant.faults.estop_pressed = false;
    r.button = true;                                // button alone does nothing
    r.run(200);
    TEST_ASSERT_EQUAL(SafetyState::EMERGENCY_STOP, r.dev.safety().state());
    r.button = false;
    uint32_t id = r.send("RESET_ESTOP");
    r.run(200);                                     // command alone does nothing
    TEST_ASSERT_EQUAL(SafetyState::EMERGENCY_STOP, r.dev.safety().state());
    r.button = true;
    r.run(50);
    TEST_ASSERT_EQUAL(SafetyState::OK, r.dev.safety().state());
    char needle[64]; snprintf(needle, sizeof(needle), "\"id\":%lu,\"status\":\"COMPLETED\"", (unsigned long)id);
    TEST_ASSERT_TRUE(r.has(needle));
    TEST_ASSERT_FALSE(r.act.driver_enable);         // reset does not restart the motor
}

void test_reset_request_times_out() {
    Rig r;
    r.plant.faults.estop_pressed = true;
    r.run(50);
    r.plant.faults.estop_pressed = false;
    uint32_t id = r.send("RESET_ESTOP");
    r.run(10500);
    char needle[64]; snprintf(needle, sizeof(needle), "\"id\":%lu,\"status\":\"ABORTED\"", (unsigned long)id);
    TEST_ASSERT_TRUE(r.has(needle));
    TEST_ASSERT_EQUAL(SafetyState::EMERGENCY_STOP, r.dev.safety().state());
}

void test_external_estop_cuts_drive_same_cycle() {
    Rig r;
    r.send("START", 30);
    r.run(3000);
    r.plant.faults.estop_pressed = true;
    r.run(10);
    TEST_ASSERT_FALSE(r.act.driver_enable);
    TEST_ASSERT_FALSE(r.act.relay_on);
    TEST_ASSERT_EQUAL(TripReason::EXTERNAL_ESTOP, r.dev.safety().reason());
}

void test_dead_hall_trips_rpm_loss() {
    Rig r;
    r.send("START", 40);
    r.run(500);
    r.plant.faults.hall_dead = true;
    r.run(2500);
    TEST_ASSERT_EQUAL(TripReason::RPM_LOSS, r.dev.safety().reason());
    TEST_ASSERT_FALSE(r.act.driver_enable);
}

void test_sustained_overcurrent_from_friction_trips() {
    Rig r;
    r.send("START", 40);
    r.run(3000);
    r.plant.faults.extra_friction_a = 3.0f;         // 0.35 + 1.0 + 3.0 = 4.35 A
    r.run(2500);
    TEST_ASSERT_EQUAL(TripReason::OVER_CURRENT_SUSTAINED, r.dev.safety().reason());
    TEST_ASSERT_FALSE(r.act.driver_enable);
}

void test_sensor_loss_trips_fail_safe() {
    Rig r;
    r.send("START", 30);
    r.run(2000);
    r.plant.faults.current_sensor_dead = true;
    r.run(700);
    TEST_ASSERT_EQUAL(TripReason::SENSOR_INVALID, r.dev.safety().reason());
    TEST_ASSERT_FALSE(r.act.driver_enable);
}

void test_duplicate_command_id_is_idempotent() {
    Rig r;
    uint32_t id = r.send("START", 30);
    int before = r.count("\"status\":\"ACCEPTED\"");
    r.send("START", 55, 0, 0, "sim-key", "1");      // same id again, different params: must not be re-run
    (void)id;
    // The replay returns the stored ACCEPTED ack but is not executed: duty target stays 30.
    r.run(8000);
    TEST_ASSERT_TRUE(r.count("\"status\":\"ACCEPTED\"") > before);
    TEST_ASSERT_FLOAT_WITHIN(0.5f, 30.0f, r.act.duty_pct);
}

void test_t1_closed_loop_step_down_end_to_end() {
    Rig r;
    uint32_t sid = r.send("SET_SPEED", 1500);
    (void)sid;
    r.run(20000);
    TEST_ASSERT_FLOAT_WITHIN(150.0f, 1500.0f, r.plant.true_rpm());
    uint32_t tid = r.send("RUN_TEST", 1, 0.7f, 10000);
    char acc[80]; snprintf(acc, sizeof(acc), "\"id\":%lu,\"status\":\"ACCEPTED\"", (unsigned long)tid);
    TEST_ASSERT_TRUE(r.has(acc));
    r.run(1000);
    TEST_ASSERT_TRUE(r.has("\"test\":1"));
    r.run(25000);
    char done[96]; snprintf(done, sizeof(done), "\"id\":%lu,\"status\":\"COMPLETED\",\"reason\":\"TEST_DONE\"", (unsigned long)tid);
    TEST_ASSERT_TRUE(r.has(done));
    TEST_ASSERT_FLOAT_WITHIN(160.0f, 1050.0f, r.plant.true_rpm());     // holds the lower speed
    TEST_ASSERT_EQUAL(SafetyState::OK, r.dev.safety().state());
}

void test_link_loss_mid_test_ends_safely_on_device() {
    Rig r;
    r.send("SET_SPEED", 1500);
    r.run(15000);
    uint32_t tid = r.send("RUN_TEST", 3, 60000);                         // T3 hold 60 s
    r.run(2000);
    r.auto_hb = false;                                                   // link dies
    r.run(3000);
    TEST_ASSERT_FALSE(r.act.driver_enable);
    TEST_ASSERT_EQUAL(SafetyState::EMERGENCY_STOP, r.dev.safety().state());
    char needle[80]; snprintf(needle, sizeof(needle), "\"id\":%lu,\"status\":\"ABORTED\"", (unsigned long)tid);
    TEST_ASSERT_TRUE(r.has(needle));
}

void test_tests_refused_until_vibration_limit_commissioned() {
    Limits l = default_limits();
    l.max_rpm = 3000.0f;                                                 // vib limit left at 0
    Rig r(true, l);
    r.send("SET_SPEED", 1500);
    r.run(15000);
    uint32_t tid = r.send("RUN_TEST", 1, 0.7f, 10000);
    char needle[96]; snprintf(needle, sizeof(needle), "\"id\":%lu,\"status\":\"REJECTED\",\"reason\":\"VIB_LIMIT_NOT_SET\"", (unsigned long)tid);
    TEST_ASSERT_TRUE(r.has(needle));
}

void test_upward_test_rejected() {
    Rig r;
    r.send("SET_SPEED", 1500);
    r.run(15000);
    uint32_t tid = r.send("RUN_TEST", 1, 1.4f, 10000);
    char needle[96]; snprintf(needle, sizeof(needle), "\"id\":%lu,\"status\":\"REJECTED\",\"reason\":\"FRACTION_OUT_OF_RANGE\"", (unsigned long)tid);
    TEST_ASSERT_TRUE(r.has(needle));
}

void test_frames_have_increasing_seq_and_bounded_length() {
    Rig r;
    r.run(3000);
    uint32_t last = 0; bool first = true; int frames = 0;
    for (size_t i = 0; i < r.out.size(); i++) {
        const std::string& s = r.out[i];
        TEST_ASSERT_TRUE(s.size() < 288);                              // the line buffer (kLine); wire protocol 1 added fields to the status frame
        TEST_ASSERT_EQUAL('{', s[0]);
        TEST_ASSERT_EQUAL('}', s[s.size() - 1]);
        size_t p = s.find("\"seq\":");
        if (s.find("\"t\":\"ack\"") == std::string::npos && p != std::string::npos) {
            uint32_t seq = (uint32_t)atol(s.c_str() + p + 6);
            if (!first) TEST_ASSERT_TRUE(seq > last);
            last = seq; first = false; frames++;
        }
    }
    TEST_ASSERT_TRUE(frames > 20);
    TEST_ASSERT_TRUE(r.has("\"wiring\":\"SIM\""));
    TEST_ASSERT_TRUE(r.has("\"mode\":\"SIM\""));
}

void test_simulation_is_deterministic() {
    std::string a, b;
    for (int k = 0; k < 2; k++) {
        Rig r;
        r.send("SET_SPEED", 1800);
        r.run(12000);
        r.send("RUN_TEST", 1, 0.6f, 8000);
        r.run(12000);
        std::string& dst = k == 0 ? a : b;
        for (size_t i = 0; i < r.out.size(); i++) dst += r.out[i];
    }
    TEST_ASSERT_TRUE(a.size() > 1000);
    TEST_ASSERT_TRUE(a == b);
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_parse_valid_command);
    RUN_TEST(test_parse_never_trusts_sender_authorization);
    RUN_TEST(test_parse_rejects_garbage);
    RUN_TEST(test_unknown_type_is_rejected_by_device);
    RUN_TEST(test_encoders_fit_and_truncate_safely);
    RUN_TEST(test_hardware_default_rejects_motor_commands);
    RUN_TEST(test_wrong_key_cannot_start_motor);
    RUN_TEST(test_start_soft_ramps_and_reaches_duty);
    RUN_TEST(test_duty_never_exceeds_cap);
    RUN_TEST(test_heartbeat_loss_trips_and_latches);
    RUN_TEST(test_stop_works_with_bad_key_and_stale_age);
    RUN_TEST(test_reset_needs_command_and_local_button);
    RUN_TEST(test_reset_request_times_out);
    RUN_TEST(test_external_estop_cuts_drive_same_cycle);
    RUN_TEST(test_dead_hall_trips_rpm_loss);
    RUN_TEST(test_sustained_overcurrent_from_friction_trips);
    RUN_TEST(test_sensor_loss_trips_fail_safe);
    RUN_TEST(test_duplicate_command_id_is_idempotent);
    RUN_TEST(test_t1_closed_loop_step_down_end_to_end);
    RUN_TEST(test_link_loss_mid_test_ends_safely_on_device);
    RUN_TEST(test_tests_refused_until_vibration_limit_commissioned);
    RUN_TEST(test_upward_test_rejected);
    RUN_TEST(test_frames_have_increasing_seq_and_bounded_length);
    RUN_TEST(test_simulation_is_deterministic);
    RUN_TEST(test_strict_start_refused_until_limits_approved);
    RUN_TEST(test_strict_start_refused_until_an_estop_input_is_declared_wired);
    RUN_TEST(test_strict_start_refused_while_the_watchdog_is_not_active);
    RUN_TEST(test_strict_start_refused_before_the_first_control_cycle);
    RUN_TEST(test_strict_start_refused_without_an_authorised_heartbeat);
    RUN_TEST(test_strict_start_refused_on_stale_telemetry_and_wrap_safe);
    RUN_TEST(test_strict_start_refused_for_invalid_nan_or_infinite_required_sensors);
    RUN_TEST(test_strict_start_permitted_only_when_every_interlock_passes_and_then_ramps);
    RUN_TEST(test_stop_is_never_blocked_by_the_interlocks);
    RUN_TEST(test_latched_trip_blocks_start_and_does_not_restart_after_reset);
    RUN_TEST(test_duplicate_stop_and_rejected_start_are_harmless);
    RUN_TEST(test_strict_start_refused_until_the_transport_is_declared_secured);
    RUN_TEST(test_asserted_estop_input_inhibits_start);
    RUN_TEST(test_power_up_state_is_off_and_never_starts_by_itself);
    RUN_TEST(test_stop_takes_effect_even_when_the_telemetry_queue_is_full_and_never_drained);
    RUN_TEST(test_unauthenticated_malformed_oversized_and_stale_commands_are_rejected);
    RUN_TEST(test_replayed_commands_are_not_executed_twice_and_old_sequence_numbers_are_refused);
    RUN_TEST(test_a_captured_command_replayed_after_a_reboot_cannot_start_the_motor_because_a_reboot_has_no_session);
    RUN_TEST(test_losing_the_secure_session_stops_a_running_motor_and_blocks_restart);
    RUN_TEST(test_a_session_cannot_be_inherited_a_fresh_device_never_has_one);
    RUN_TEST(test_stop_works_without_a_session_and_without_authentication);
    RUN_TEST(test_a_boot_fault_latches_until_an_intentional_reset_and_never_restarts_the_motor);
    RUN_TEST(test_an_output_initialisation_fault_latches_blocks_start_and_is_reported);
    RUN_TEST(test_accel_frames_carry_raw_axes_and_a_total_magnitude_only_when_valid);
    RUN_TEST(test_invalid_or_non_finite_accelerometer_data_sends_ok_zero_without_numbers_and_unsupported_builds_send_nothing);
    RUN_TEST(test_strict_device_idle_with_no_motor_supply_stays_ok_and_reports_the_supply_interlock);
    RUN_TEST(test_authenticated_session_gates_every_command_and_never_blocks_stop);
    RUN_TEST(test_a_captured_authentic_command_cannot_be_replayed_or_survive_expiry_or_a_new_login);
    RUN_TEST(test_an_authenticated_configuration_approves_limits_applies_them_and_is_reported_in_status);
    RUN_TEST(test_a_configuration_without_authentication_or_with_tampering_replay_rollback_or_bad_values_changes_nothing);
    RUN_TEST(test_a_restored_configuration_sets_the_trip_numbers_but_never_approves_motion_and_the_target_persists_accepted_configurations);
    RUN_TEST(test_runtime_configuration_validation_mapping_and_codec);
    RUN_TEST(test_status_frames_report_the_estop_input_state_without_changing_any_decision);
    RUN_TEST(test_a_pressed_open_or_unread_estop_input_blocks_a_start_in_a_build_that_declares_the_circuit);
    RUN_TEST(test_a_device_without_a_provisioned_key_can_never_open_a_session);
    RUN_TEST(test_display_info_reflects_validity_and_the_safety_state_without_inventing_values);
    RUN_TEST(test_acknowledgements_carry_the_device_id_when_configured);
    RUN_TEST(test_status_frame_reports_protocol_identity_interlock_reason_and_fault_mask);
    RUN_TEST(test_commands_must_carry_the_live_session_id_and_old_session_ids_are_rejected);
    RUN_TEST(test_a_new_session_replaces_the_old_one_stops_motion_and_makes_old_commands_invalid);
    RUN_TEST(test_stop_needs_no_session_id_and_session_ids_are_validated);
    return UNITY_END();
}
