// Protocol + device-layer tests using the deterministic SimPlant. No hardware involved.
#include <unity.h>
#include <string>
#include <vector>
#include <stdio.h>
#include <string.h>
#include <math.h>
#include "device.h"
#include "simplant.h"

using namespace torqva;

static DeviceConfig sim_cfg(bool control = true, bool relaxed = true, bool approved = false, bool wired = false) {
    DeviceConfig c = {};
    c.fw_version = "3.0.0-test"; c.wiring_id = "SIM"; c.mode = "SIM";
    strcpy(c.key, "sim-key");
    c.control_enabled = control; c.kp = 0.01f; c.ki = 0.03f;
    c.relaxed_interlocks = relaxed;                    // host simulation relaxes the start interlocks; the strict tests below do not
    c.limits_approved = approved; c.estop_input_wired = wired;
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

    explicit Rig(bool control = true, const Limits& l = sim_limits(), bool relaxed = true, bool approved = false, bool wired = false)
        : dev(l, sim_cfg(control, relaxed, approved, wired)), t(0), next_id(1), next_seq(1), button(false), auto_hb(true), last_hb_t(0) {
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
static void ready(Rig& r) { r.dev.set_watchdog_active(true); r.run(300); r.send("HEARTBEAT"); r.last_hb_t = r.t; }   // a few control cycles, then an authorised heartbeat

void test_strict_start_refused_until_limits_approved() {
    Rig r(true, sim_limits(), false, /*approved*/ false, /*wired*/ true); ready(r);
    TEST_ASSERT_EQUAL_STRING("LIMITS_NOT_APPROVED", start_reason(r).c_str());
    r.run(500);
    TEST_ASSERT_EQUAL_FLOAT(0.0f, r.act.duty_pct);                 // nothing was energised
    TEST_ASSERT_FALSE(r.act.driver_enable);
}

void test_strict_start_refused_until_an_estop_input_is_declared_wired() {
    Rig r(true, sim_limits(), false, true, /*wired*/ false); ready(r);
    TEST_ASSERT_EQUAL_STRING("ESTOP_INPUT_NOT_VERIFIED", start_reason(r).c_str());
}

void test_strict_start_refused_while_the_watchdog_is_not_active() {
    Rig r(true, sim_limits(), false, true, true); r.run(300);       // watchdog NOT reported active
    TEST_ASSERT_EQUAL_STRING("WATCHDOG_NOT_ACTIVE", start_reason(r).c_str());
}

void test_strict_start_refused_before_the_first_control_cycle() {
    Rig r(true, sim_limits(), false, true, true); r.dev.set_watchdog_active(true);
    TEST_ASSERT_EQUAL_STRING("NOT_INITIALIZED", start_reason(r).c_str());
}

void test_strict_start_refused_without_an_authorised_heartbeat() {
    Rig r(true, sim_limits(), false, true, true); r.dev.set_watchdog_active(true);
    r.auto_hb = false; r.run(300);
    TEST_ASSERT_EQUAL_STRING("NO_HEARTBEAT", start_reason(r).c_str());
}

void test_strict_start_refused_on_stale_telemetry_and_wrap_safe() {
    Rig r(true, sim_limits(), false, true, true); ready(r);
    r.t += 600;                                                      // control loop silent for 600 ms; heartbeat window (2 s) still open
    TEST_ASSERT_EQUAL_STRING("TELEMETRY_STALE", start_reason(r).c_str());
    // millis() rollover: a snapshot taken just before the wrap and a start request just after it is fresh; 600 ms later is stale.
    Device d(sim_limits(), sim_cfg(true, false, true, true));
    d.set_watchdog_active(true);
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
        Rig r(true, sim_limits(), false, true, true); ready(r);
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
    Rig r(true, sim_limits(), false, true, true); ready(r);
    TEST_ASSERT_EQUAL_STRING("OK", start_reason(r).c_str());
    r.run(2000);
    TEST_ASSERT_TRUE(r.act.driver_enable);
    TEST_ASSERT_TRUE(r.act.duty_pct > 0.0f);
}

void test_stop_is_never_blocked_by_the_interlocks() {
    Rig r(true, sim_limits(), false, false, false);                 // nothing approved, nothing initialised
    r.out.clear(); r.send("STOP");
    TEST_ASSERT_TRUE(r.has("\"status\":\"ACCEPTED\""));
    TEST_ASSERT_TRUE(r.has("STOPPED"));
}

void test_latched_trip_blocks_start_and_does_not_restart_after_reset() {
    Rig r(true, sim_limits(), false, true, true); ready(r);
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
    Rig r(true, sim_limits(), false, false, false); ready(r);
    for (int i = 0; i < 3; i++) { r.send("STOP"); r.send("START", 30); }
    r.run(500);
    TEST_ASSERT_FALSE(r.act.driver_enable);
    TEST_ASSERT_EQUAL_FLOAT(0.0f, r.act.duty_pct);
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
        TEST_ASSERT_TRUE(s.size() < 200);
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
    return UNITY_END();
}
