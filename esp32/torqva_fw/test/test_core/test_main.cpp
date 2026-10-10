#include <unity.h>
#include <math.h>
#include "safety.h"
#include "control.h"
#include "commands.h"
#include "testexec.h"
#include "interlock.h"
#include "estop.h"

using namespace torqva;

static SafetyInputs healthy(uint32_t now) {
    SafetyInputs in;
    in.now_ms = now;
    in.current_a = 1.0f;  in.current_valid = true;
    in.voltage_v = 24.0f; in.voltage_valid = true;
    in.housing_c = 30.0f; in.housing_valid = true;
    in.ambient_c = 22.0f; in.ambient_valid = true;
    in.rpm = 1000.0f;     in.rpm_valid = true;
    in.rpm_pulse_seen_recently = true;
    in.vib_rms_g = 0.1f;  in.vib_valid = true;
    in.duty_pct = 40.0f;
    in.hardware_control_mode = false;
    in.external_estop_active = false;
    return in;
}

void setUp() {}
void tearDown() {}

// ---------------- Safety ----------------
void test_healthy_is_ok() {
    SafetyMonitor m(default_limits());
    SafetyOutput o = m.update(healthy(0));
    TEST_ASSERT_TRUE(o.drive_allowed);
    TEST_ASSERT_EQUAL(SafetyState::OK, o.state);
}

void test_instant_overcurrent_trips_immediately() {
    SafetyMonitor m(default_limits());
    SafetyInputs in = healthy(0); in.current_a = 5.5f;
    SafetyOutput o = m.update(in);
    TEST_ASSERT_FALSE(o.drive_allowed);
    TEST_ASSERT_EQUAL(TripReason::OVER_CURRENT_INSTANT, o.reason);
}

void test_sustained_overcurrent_needs_2s() {
    SafetyMonitor m(default_limits());
    SafetyInputs in = healthy(0); in.current_a = 4.2f;
    TEST_ASSERT_TRUE(m.update(in).drive_allowed);
    in.now_ms = 1999;
    TEST_ASSERT_TRUE(m.update(in).drive_allowed);
    in.now_ms = 2000;
    SafetyOutput o = m.update(in);
    TEST_ASSERT_FALSE(o.drive_allowed);
    TEST_ASSERT_EQUAL(TripReason::OVER_CURRENT_SUSTAINED, o.reason);
}

void test_overcurrent_timer_resets_on_dip() {
    SafetyMonitor m(default_limits());
    SafetyInputs in = healthy(0); in.current_a = 4.2f;
    m.update(in);
    in.now_ms = 1500; in.current_a = 3.0f; m.update(in);
    in.now_ms = 2500; in.current_a = 4.2f; m.update(in);
    in.now_ms = 4000;
    TEST_ASSERT_TRUE(m.update(in).drive_allowed);   // only 1.5 s into new excursion
}

void test_temperature_warn_and_stop() {
    SafetyMonitor m(default_limits());
    SafetyInputs in = healthy(0); in.housing_c = 55.0f;
    SafetyOutput o = m.update(in);
    TEST_ASSERT_EQUAL(SafetyState::WARN, o.state);
    TEST_ASSERT_TRUE(o.drive_allowed);
    in.housing_c = 60.5f;
    o = m.update(in);
    TEST_ASSERT_FALSE(o.drive_allowed);
    TEST_ASSERT_EQUAL(TripReason::TEMP_STOP, o.reason);
}

void test_temp_rise_limit_only_when_configured() {
    Limits l = default_limits();
    SafetyMonitor off(l);
    SafetyInputs in = healthy(0); in.housing_c = 45.0f; in.ambient_c = 20.0f;
    TEST_ASSERT_TRUE(off.update(in).drive_allowed);
    l.temp_rise_stop_c = 20.0f;
    SafetyMonitor on(l);
    TEST_ASSERT_EQUAL(TripReason::TEMP_RISE, on.update(in).reason);
}

void test_voltage_window() {
    SafetyMonitor lo(default_limits());
    SafetyInputs in = healthy(0); in.voltage_v = 19.9f;
    TEST_ASSERT_EQUAL(TripReason::VOLTAGE_LOW, lo.update(in).reason);
    SafetyMonitor hi(default_limits());
    in.voltage_v = 25.6f;
    TEST_ASSERT_EQUAL(TripReason::VOLTAGE_HIGH, hi.update(in).reason);
}

void test_rpm_loss_when_driving_without_pulses() {
    SafetyMonitor m(default_limits());
    SafetyInputs in = healthy(0); in.rpm_pulse_seen_recently = false; in.duty_pct = 40.0f;
    TEST_ASSERT_TRUE(m.update(in).drive_allowed);
    in.now_ms = 1000;
    SafetyOutput o = m.update(in);
    TEST_ASSERT_FALSE(o.drive_allowed);
    TEST_ASSERT_EQUAL(TripReason::RPM_LOSS, o.reason);
}

void test_no_rpm_loss_when_idle() {
    SafetyMonitor m(default_limits());
    SafetyInputs in = healthy(0); in.rpm_pulse_seen_recently = false; in.duty_pct = 0.0f;
    in.now_ms = 5000;
    TEST_ASSERT_TRUE(m.update(in).drive_allowed);
}

void test_critical_sensor_invalid_trips_after_500ms() {
    SafetyMonitor m(default_limits());
    SafetyInputs in = healthy(0); in.current_valid = false;
    TEST_ASSERT_TRUE(m.update(in).drive_allowed);
    in.now_ms = 499;
    TEST_ASSERT_TRUE(m.update(in).drive_allowed);
    in.now_ms = 500;
    TEST_ASSERT_EQUAL(TripReason::SENSOR_INVALID, m.update(in).reason);
}

// A NaN / infinite value flagged "valid" must be treated as invalid (it compares false against every limit, so it would otherwise read as healthy).
void test_non_finite_critical_signal_is_invalid_and_trips_after_500ms() {
    const float bad[] = {(float)NAN, (float)INFINITY, (float)-INFINITY};
    for (float v : bad) {
        for (int sig = 0; sig < 4; sig++) {
            SafetyMonitor m(default_limits());
            SafetyInputs in = healthy(0);
            if (sig == 0) in.current_a = v; else if (sig == 1) in.voltage_v = v; else if (sig == 2) in.housing_c = v; else in.rpm = v;
            TEST_ASSERT_TRUE(m.update(in).drive_allowed);          // the 500 ms debounce applies, as for any invalid signal
            in.now_ms = 499;
            TEST_ASSERT_TRUE(m.update(in).drive_allowed);
            in.now_ms = 500;
            SafetyOutput o = m.update(in);
            TEST_ASSERT_FALSE(o.drive_allowed);
            TEST_ASSERT_EQUAL(TripReason::SENSOR_INVALID, o.reason);
        }
    }
}

void test_non_finite_non_critical_signal_does_not_trip_and_cannot_mask_a_real_limit() {
    SafetyMonitor m(default_limits());
    SafetyInputs in = healthy(0); in.ambient_c = NAN; in.vib_rms_g = NAN;
    TEST_ASSERT_TRUE(m.update(in).drive_allowed);                  // ambient / vibration are not critical signals
    in.now_ms = 10; in.housing_c = 65.0f;                          // a finite over-temperature is still caught
    TEST_ASSERT_EQUAL(TripReason::TEMP_STOP, m.update(in).reason);
    SafetyMonitor m2(default_limits());
    SafetyInputs in2 = healthy(0); in2.voltage_v = NAN; in2.current_a = 5.5f;   // NaN voltage must not hide an instantaneous over-current
    TEST_ASSERT_EQUAL(TripReason::OVER_CURRENT_INSTANT, m2.update(in2).reason);
}

// ---------------- Start interlock (pure logic) ----------------
static StartInterlockInputs all_ok() {
    StartInterlockInputs i = {};
    i.initialized = i.limits_approved = i.transport_secured = i.session_active = i.estop_input_wired = i.watchdog_active = true;
    i.estop_active = false; i.safety_state = SafetyState::OK;
    i.required_sensors_valid = i.telemetry_fresh = i.link_ok = true;
    return i;
}
void test_interlock_permits_only_when_everything_is_verified() {
    TEST_ASSERT_NULL(start_interlock_reason(all_ok()));
}
void test_interlock_blocks_each_unverified_condition_with_its_own_reason() {
    StartInterlockInputs i;
    i = all_ok(); i.initialized = false;            TEST_ASSERT_EQUAL_STRING("NOT_INITIALIZED", start_interlock_reason(i));
    i = all_ok(); i.limits_approved = false;        TEST_ASSERT_EQUAL_STRING("LIMITS_NOT_APPROVED", start_interlock_reason(i));
    i = all_ok(); i.transport_secured = false;     TEST_ASSERT_EQUAL_STRING("TRANSPORT_NOT_SECURED", start_interlock_reason(i));
    i = all_ok(); i.session_active = false;        TEST_ASSERT_EQUAL_STRING("NO_SECURE_SESSION", start_interlock_reason(i));
    i = all_ok(); i.estop_input_wired = false;      TEST_ASSERT_EQUAL_STRING("ESTOP_INPUT_NOT_VERIFIED", start_interlock_reason(i));
    i = all_ok(); i.estop_active = true;            TEST_ASSERT_EQUAL_STRING("ESTOP_ACTIVE", start_interlock_reason(i));
    i = all_ok(); i.watchdog_active = false;        TEST_ASSERT_EQUAL_STRING("WATCHDOG_NOT_ACTIVE", start_interlock_reason(i));
    i = all_ok(); i.safety_state = SafetyState::WARN;            TEST_ASSERT_EQUAL_STRING("SAFETY_NOT_OK", start_interlock_reason(i));
    i = all_ok(); i.safety_state = SafetyState::EMERGENCY_STOP;  TEST_ASSERT_EQUAL_STRING("SAFETY_NOT_OK", start_interlock_reason(i));
    i = all_ok(); i.required_sensors_valid = false; TEST_ASSERT_EQUAL_STRING("SENSOR_NOT_VALID", start_interlock_reason(i));
    i = all_ok(); i.telemetry_fresh = false;        TEST_ASSERT_EQUAL_STRING("TELEMETRY_STALE", start_interlock_reason(i));
    i = all_ok(); i.link_ok = false;                TEST_ASSERT_EQUAL_STRING("NO_HEARTBEAT", start_interlock_reason(i));
    StartInterlockInputs z = {};                    // an all-zero (unverified) input must never permit a start
    TEST_ASSERT_NOT_NULL(start_interlock_reason(z));
}

// ---------------- Abstract E-stop input (no pin, no polarity: electrical behaviour is NOT tested here) ----------------
static EstopConfig estop_cfg(bool configured = true, bool active_low = true, uint32_t deb = 50) { EstopConfig c = {configured, active_low, deb}; return c; }
void test_estop_input_is_unknown_until_configured_and_never_released_when_unconfigured() {
    EstopInput e(estop_cfg(false));
    for (uint32_t t = 0; t < 5000; t += 10) e.update(t, true, true);
    TEST_ASSERT_EQUAL(EstopState::UNKNOWN, e.state()); TEST_ASSERT_TRUE(e.blocks_operation());
    EstopInput z(estop_cfg(true, true, 0));                       // a zero debounce is an invalid configuration
    z.update(0, true, true); z.update(100, true, true);
    TEST_ASSERT_EQUAL(EstopState::UNKNOWN, z.state());
}
void test_estop_input_starts_unknown_asserts_immediately_and_releases_only_after_the_debounce() {
    EstopInput e(estop_cfg(true, /*active_low*/ true, 50));
    TEST_ASSERT_EQUAL(EstopState::UNKNOWN, e.state());
    e.update(0, true, true);                                      // released level, debounce not yet elapsed
    TEST_ASSERT_TRUE(e.blocks_operation());
    e.update(49, true, true); TEST_ASSERT_TRUE(e.blocks_operation());
    e.update(50, true, true); TEST_ASSERT_EQUAL(EstopState::RELEASED, e.state()); TEST_ASSERT_FALSE(e.blocks_operation());
    e.update(60, true, false);                                    // active-low line pulled low: asserted at once, no debounce
    TEST_ASSERT_EQUAL(EstopState::ASSERTED, e.state());
    e.update(70, true, true); e.update(100, true, true);          // glitch-free release must again wait the full debounce
    TEST_ASSERT_TRUE(e.blocks_operation());
    e.update(120, true, true); TEST_ASSERT_EQUAL(EstopState::RELEASED, e.state());
}
void test_estop_input_treats_an_unreadable_sample_as_asserted_and_a_glitch_restarts_the_debounce() {
    EstopInput e(estop_cfg(true, false, 100));                    // active-high polarity
    e.update(0, true, false); e.update(100, true, false); TEST_ASSERT_EQUAL(EstopState::RELEASED, e.state());
    e.update(110, false, false);                                  // read failure / circuit fault
    TEST_ASSERT_EQUAL(EstopState::ASSERTED, e.state());
    e.update(120, true, false); e.update(180, true, true);        // released, then a glitch back to asserted
    e.update(190, true, false); e.update(280, true, false);
    TEST_ASSERT_TRUE(e.blocks_operation());                       // only 90 ms since the glitch
    e.update(290, true, false); TEST_ASSERT_EQUAL(EstopState::RELEASED, e.state());
}
void test_estop_input_debounce_is_wrap_safe() {
    EstopInput e(estop_cfg(true, true, 50));
    e.update(0xFFFFFFE0u, true, true); TEST_ASSERT_TRUE(e.blocks_operation());
    e.update(0x00000010u, true, true);                            // 48 ms later across the wrap
    TEST_ASSERT_TRUE(e.blocks_operation());
    e.update(0x00000012u, true, true); TEST_ASSERT_EQUAL(EstopState::RELEASED, e.state());
}

// ---------------- Fault mask: every cause is preserved ----------------
void test_fault_mask_keeps_every_simultaneous_cause_while_reason_keeps_the_first() {
    SafetyMonitor m(default_limits());
    SafetyInputs in = healthy(0);
    in.current_a = 5.5f; in.housing_c = 65.0f; in.voltage_v = 18.0f;
    SafetyOutput o = m.update(in);
    TEST_ASSERT_FALSE(o.drive_allowed);
    TEST_ASSERT_EQUAL(TripReason::OVER_CURRENT_INSTANT, m.reason());
    const uint32_t want = trip_bit(TripReason::OVER_CURRENT_INSTANT) | trip_bit(TripReason::TEMP_STOP) | trip_bit(TripReason::VOLTAGE_LOW);
    TEST_ASSERT_EQUAL_HEX32(want, m.fault_mask());
    in = healthy(10);                                               // everything normal again: the latch and the mask persist
    TEST_ASSERT_FALSE(m.update(in).drive_allowed);
    TEST_ASSERT_EQUAL_HEX32(want, m.fault_mask());
    TEST_ASSERT_TRUE(m.reset_trip(true, true));
    TEST_ASSERT_EQUAL_HEX32(0, m.fault_mask());
}

void test_heartbeat_enforced_only_in_hardware_mode() {
    SafetyMonitor sim(default_limits());
    SafetyInputs in = healthy(0);
    sim.update(in);
    in.now_ms = 10000;
    TEST_ASSERT_TRUE(sim.update(in).drive_allowed);

    SafetyMonitor hw(default_limits());
    in = healthy(0); in.hardware_control_mode = true;
    hw.update(in);
    in.now_ms = 1500; hw.heartbeat(1500);
    TEST_ASSERT_TRUE(hw.update(in).drive_allowed);
    in.now_ms = 3499;
    TEST_ASSERT_TRUE(hw.update(in).drive_allowed);
    in.now_ms = 3500;
    SafetyOutput o = hw.update(in);
    TEST_ASSERT_FALSE(o.drive_allowed);
    TEST_ASSERT_EQUAL(TripReason::HEARTBEAT_LOST, o.reason);
}

void test_heartbeat_timer_is_wraparound_safe() {
    SafetyMonitor m(default_limits());
    SafetyInputs in = healthy(0xFFFFFF00u); in.hardware_control_mode = true;
    m.update(in);
    m.heartbeat(0xFFFFFF00u);
    in.now_ms = 0x00000100u;   // 512 ms later, across the wrap
    TEST_ASSERT_TRUE(m.update(in).drive_allowed);
}

void test_external_estop() {
    SafetyMonitor m(default_limits());
    SafetyInputs in = healthy(0); in.external_estop_active = true;
    TEST_ASSERT_EQUAL(TripReason::EXTERNAL_ESTOP, m.update(in).reason);
}

void test_trip_latches_and_keeps_first_cause() {
    SafetyMonitor m(default_limits());
    SafetyInputs in = healthy(0); in.voltage_v = 19.0f;
    m.update(in);
    in = healthy(10);                       // everything fine again
    SafetyOutput o = m.update(in);
    TEST_ASSERT_FALSE(o.drive_allowed);     // still latched
    in.current_a = 9.0f; in.now_ms = 20;
    TEST_ASSERT_EQUAL(TripReason::VOLTAGE_LOW, m.update(in).reason);  // first cause kept
}

void test_reset_requires_authorization_and_local_button() {
    SafetyMonitor m(default_limits());
    SafetyInputs in = healthy(0); in.voltage_v = 19.0f;
    m.update(in);
    TEST_ASSERT_FALSE(m.reset_trip(true, false));
    TEST_ASSERT_FALSE(m.reset_trip(false, true));
    TEST_ASSERT_FALSE(m.update(healthy(5)).drive_allowed);
    TEST_ASSERT_TRUE(m.reset_trip(true, true));
    TEST_ASSERT_TRUE(m.update(healthy(10)).drive_allowed);
}

void test_vibration_limit_disabled_until_commissioned() {
    SafetyInputs in = healthy(0); in.vib_rms_g = 9.0f;
    SafetyMonitor off(default_limits());
    TEST_ASSERT_TRUE(off.update(in).drive_allowed);
    Limits l = default_limits(); l.vib_rms_stop_g = 1.0f;
    SafetyMonitor on(l);
    TEST_ASSERT_EQUAL(TripReason::VIBRATION, on.update(in).reason);
}

// ---------------- Control ----------------
void test_ramp_limits_slew_rate() {
    RampLimiter r(30.0f);
    float v = 0;
    for (int i = 0; i < 100; i++) v = r.step(70.0f, 0.01f);   // 1 s
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 30.0f, v);
    for (int i = 0; i < 200; i++) v = r.step(70.0f, 0.01f);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 70.0f, v);
}

void test_drive_open_loop_soft_start_and_cap() {
    DriveController d(default_limits(), 0.05f, 0.05f);
    d.start_open_loop(95.0f);            // asks for more than the cap
    DriveOutput o = {0, false};
    for (int i = 0; i < 100; i++) o = d.update(0.01f, 0, true);
    TEST_ASSERT_TRUE(o.driver_enable);
    TEST_ASSERT_TRUE(o.duty_pct <= 30.01f);       // ramp: <= 30 %/s
    for (int i = 0; i < 1000; i++) o = d.update(0.01f, 0, true);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 70.0f, o.duty_pct);   // never above cap
}

void test_drive_safety_override_is_immediate() {
    DriveController d(default_limits(), 0.05f, 0.05f);
    d.start_open_loop(50.0f);
    for (int i = 0; i < 500; i++) d.update(0.01f, 0, true);
    DriveOutput o = d.update(0.01f, 0, false);
    TEST_ASSERT_FALSE(o.driver_enable);
    TEST_ASSERT_EQUAL_FLOAT(0.0f, o.duty_pct);
    TEST_ASSERT_EQUAL(DriveMode::IDLE, d.mode());
}

void test_set_speed_rejected_until_commissioned() {
    DriveController d(default_limits(), 0.05f, 0.05f);
    TEST_ASSERT_FALSE(d.set_speed(1000.0f));
    Limits l = default_limits(); l.max_rpm = 3000.0f;
    DriveController c(l, 0.05f, 0.05f);
    TEST_ASSERT_TRUE(c.set_speed(1000.0f));
    TEST_ASSERT_FALSE(c.set_speed(3500.0f));
}

void test_pi_converges_on_first_order_plant_without_exceeding_cap() {
    Limits l = default_limits(); l.max_rpm = 4000.0f;
    DriveController d(l, 0.02f, 0.05f);
    TEST_ASSERT_TRUE(d.set_speed(1500.0f));
    float rpm = 0.0f, maxduty = 0.0f;
    // plant: rpm' = (60*duty - rpm)/tau, steady 60 rpm per % duty, tau 0.5 s
    for (int i = 0; i < 3000; i++) {
        DriveOutput o = d.update(0.01f, rpm, true);
        if (o.duty_pct > maxduty) maxduty = o.duty_pct;
        rpm += (60.0f * o.duty_pct - rpm) / 0.5f * 0.01f;
    }
    TEST_ASSERT_FLOAT_WITHIN(30.0f, 1500.0f, rpm);
    TEST_ASSERT_TRUE(maxduty <= 70.0f + 1e-3f);
}

void test_pi_antiwindup_integrator_bounded_when_saturated() {
    PIController pi(0.02f, 0.5f, 0.0f, 70.0f);
    for (int i = 0; i < 10000; i++) pi.step(5000.0f, 0.0f, 0.01f);   // unreachable setpoint
    TEST_ASSERT_TRUE(pi.integrator() <= 70.0f + 1.0f);
    float out = 0;
    for (int i = 0; i < 20; i++) out = pi.step(0.0f, 5000.0f, 0.01f);  // overshoot case
    TEST_ASSERT_TRUE(out < 70.0f);                                      // recovers quickly, no long windup tail
}

// ---------------- Commands ----------------
static Command cmd(uint32_t id, CmdType t, uint32_t seq, float p = 0) {
    Command c = {};
    c.id = id; c.type = t; c.param = p; c.ttl_ms = 5000; c.age_ms = 0; c.seq = seq; c.authorized = true;
    return c;
}
static CommandContext ctx_hw() { CommandContext c = {SafetyState::OK, true, false}; return c; }

void test_cmd_accept_and_reject_basic() {
    Limits l = default_limits(); l.max_rpm = 3000.0f;
    CommandValidator v(l);
    TEST_ASSERT_EQUAL(AckStatus::ACCEPTED, v.validate(cmd(1, CmdType::SET_SPEED, 1, 1500), ctx_hw()).status);
    Ack a = v.validate(cmd(2, CmdType::SET_SPEED, 2, 9000), ctx_hw());
    TEST_ASSERT_EQUAL(AckStatus::REJECTED, a.status);
    TEST_ASSERT_EQUAL_STRING("RPM_OUT_OF_RANGE", a.reason);
}

void test_cmd_not_commissioned_and_sim_mode() {
    CommandValidator v(default_limits());
    TEST_ASSERT_EQUAL_STRING("NOT_COMMISSIONED", v.validate(cmd(1, CmdType::SET_SPEED, 1, 100), ctx_hw()).reason);
    CommandContext sim = {SafetyState::OK, false, false};
    TEST_ASSERT_EQUAL_STRING("NOT_IN_HARDWARE_CONTROL", v.validate(cmd(2, CmdType::START, 2, 20), sim).reason);
}

void test_cmd_start_duty_range() {
    CommandValidator v(default_limits());
    TEST_ASSERT_EQUAL_STRING("DUTY_OUT_OF_RANGE", v.validate(cmd(1, CmdType::START, 1, 80), ctx_hw()).reason);
    TEST_ASSERT_EQUAL(AckStatus::ACCEPTED, v.validate(cmd(2, CmdType::START, 2, 20), ctx_hw()).status);
}

void test_cmd_expired_and_bad_ttl() {
    CommandValidator v(default_limits());
    Command c = cmd(1, CmdType::HEARTBEAT, 1); c.age_ms = 5000;
    TEST_ASSERT_EQUAL_STRING("EXPIRED", v.validate(c, ctx_hw()).reason);
    c = cmd(2, CmdType::HEARTBEAT, 2); c.ttl_ms = 0;
    TEST_ASSERT_EQUAL_STRING("BAD_TTL", v.validate(c, ctx_hw()).reason);
}

void test_cmd_sequence_and_duplicate_idempotent() {
    CommandValidator v(default_limits());
    TEST_ASSERT_EQUAL(AckStatus::ACCEPTED, v.validate(cmd(1, CmdType::HEARTBEAT, 10), ctx_hw()).status);
    TEST_ASSERT_EQUAL_STRING("OUT_OF_SEQUENCE", v.validate(cmd(2, CmdType::HEARTBEAT, 10), ctx_hw()).reason);
    // duplicate id with a (wrong) different seq still returns the ORIGINAL ack
    Ack dup = v.validate(cmd(1, CmdType::HEARTBEAT, 99), ctx_hw());
    TEST_ASSERT_EQUAL(AckStatus::ACCEPTED, dup.status);
    TEST_ASSERT_EQUAL_UINT32(1, dup.id);
}

void test_cmd_duplicate_flagged_so_it_is_not_reexecuted() {
    CommandValidator v(default_limits());
    v.validate(cmd(1, CmdType::START, 1, 20), ctx_hw());
    TEST_ASSERT_FALSE(v.last_was_duplicate());
    v.validate(cmd(1, CmdType::START, 2, 60), ctx_hw());
    TEST_ASSERT_TRUE(v.last_was_duplicate());
}

void test_cmd_unauthorized_rejected_but_stop_always_accepted() {
    CommandValidator v(default_limits());
    Command c = cmd(1, CmdType::START, 1, 20); c.authorized = false;
    TEST_ASSERT_EQUAL_STRING("UNAUTHORIZED", v.validate(c, ctx_hw()).reason);
    Command s = cmd(2, CmdType::STOP, 0); s.authorized = false; s.age_ms = 999999; s.ttl_ms = 0;
    TEST_ASSERT_EQUAL(AckStatus::ACCEPTED, v.validate(s, ctx_hw()).status);   // stale, unauthenticated STOP still stops
}

void test_cmd_estop_latched_only_allows_heartbeat_reset() {
    CommandValidator v(default_limits());
    CommandContext latched = {SafetyState::EMERGENCY_STOP, true, false};
    TEST_ASSERT_EQUAL_STRING("ESTOP_LATCHED", v.validate(cmd(1, CmdType::START, 1, 20), latched).reason);
    TEST_ASSERT_EQUAL(AckStatus::ACCEPTED, v.validate(cmd(2, CmdType::RESET_ESTOP, 2), latched).status);
    TEST_ASSERT_EQUAL_STRING("NOT_LATCHED", v.validate(cmd(3, CmdType::RESET_ESTOP, 3), ctx_hw()).reason);
}

void test_cmd_rejected_command_does_not_advance_sequence() {
    CommandValidator v(default_limits());
    v.validate(cmd(1, CmdType::START, 5, 99), ctx_hw());     // rejected (duty)
    TEST_ASSERT_EQUAL(AckStatus::ACCEPTED, v.validate(cmd(2, CmdType::HEARTBEAT, 5), ctx_hw()).status);
}

// ---------------- Test executor ----------------
static Limits tlim() { Limits l = default_limits(); l.vib_rms_stop_g = 2.0f; l.max_rpm = 3000.0f; return l; }
static TestTickInput tin(uint32_t now, float rpm = 1000.0f, bool ok = true, bool link = true) {
    TestTickInput t = {now, ok, link, rpm}; return t;
}

void test_exec_rejects_when_vib_limit_unset_or_not_running() {
    TestExecutor e(default_limits());
    TestParams p = {0.7f, 30000, 0};
    TEST_ASSERT_EQUAL_STRING("VIB_LIMIT_NOT_SET", e.start(TestId::T1_SPEED_STEP_DOWN, p, 1500, true, 0));
    TestExecutor f(tlim());
    TEST_ASSERT_EQUAL_STRING("NOT_RUNNING", f.start(TestId::T1_SPEED_STEP_DOWN, p, 0, false, 0));
}

void test_exec_rejects_upward_and_out_of_envelope() {
    TestExecutor e(tlim());
    TestParams up = {1.2f, 30000, 0};
    TEST_ASSERT_EQUAL_STRING("FRACTION_OUT_OF_RANGE", e.start(TestId::T1_SPEED_STEP_DOWN, up, 1500, true, 0));
    TestParams low = {0.1f, 30000, 0};
    TEST_ASSERT_EQUAL_STRING("FRACTION_OUT_OF_RANGE", e.start(TestId::T1_SPEED_STEP_DOWN, low, 1500, true, 0));
    TestParams longhold = {0.7f, 120000, 0};
    TEST_ASSERT_EQUAL_STRING("HOLD_OUT_OF_RANGE", e.start(TestId::T1_SPEED_STEP_DOWN, longhold, 1500, true, 0));
    TestParams t3 = {0, 0, 700000};
    TEST_ASSERT_EQUAL_STRING("DURATION_OUT_OF_RANGE", e.start(TestId::T3_HOLD_AND_OBSERVE, t3, 1500, true, 0));
}

void test_exec_t1_steps_down_then_completes_and_holds() {
    TestExecutor e(tlim());
    TestParams p = {0.7f, 30000, 0};
    TEST_ASSERT_NULL(e.start(TestId::T1_SPEED_STEP_DOWN, p, 1500, true, 1000));
    TestTickOutput o = e.tick(tin(2000));
    TEST_ASSERT_TRUE(o.active);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 1050.0f, o.setpoint_rpm);
    o = e.tick(tin(31000));
    TEST_ASSERT_EQUAL(TestEvent::COMPLETED, o.event);
    TEST_ASSERT_FALSE(o.active);
    TEST_ASSERT_TRUE(o.driver_enable);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 1050.0f, o.setpoint_rpm);   // holds the lower speed
}

void test_exec_second_test_rejected_while_active() {
    TestExecutor e(tlim());
    TestParams p = {0.7f, 30000, 0};
    e.start(TestId::T1_SPEED_STEP_DOWN, p, 1500, true, 0);
    TEST_ASSERT_EQUAL_STRING("TEST_ACTIVE", e.start(TestId::T3_HOLD_AND_OBSERVE, p, 1500, true, 0));
}

void test_exec_link_loss_mid_test_aborts_and_cuts_drive() {
    TestExecutor e(tlim());
    TestParams p = {0.7f, 30000, 0};
    e.start(TestId::T1_SPEED_STEP_DOWN, p, 1500, true, 0);
    e.tick(tin(1000));
    TestTickOutput o = e.tick(tin(2000, 1000, true, false));
    TEST_ASSERT_EQUAL(TestEvent::ABORTED, o.event);
    TEST_ASSERT_EQUAL_STRING("LINK_LOST", o.abort_reason);
    TEST_ASSERT_FALSE(o.driver_enable);
    TEST_ASSERT_FALSE(e.active());
}

void test_exec_safety_trip_aborts() {
    TestExecutor e(tlim());
    TestParams p = {0, 0, 10000};
    e.start(TestId::T3_HOLD_AND_OBSERVE, p, 1500, true, 0);
    TestTickOutput o = e.tick(tin(500, 1500, false, true));
    TEST_ASSERT_EQUAL(TestEvent::ABORTED, o.event);
    TEST_ASSERT_EQUAL_STRING("SAFETY_TRIP", o.abort_reason);
    TEST_ASSERT_FALSE(o.driver_enable);
}

void test_exec_command_abort_holds_current_speed_not_original() {
    TestExecutor e(tlim());
    TestParams p = {0.5f, 30000, 0};
    e.start(TestId::T1_SPEED_STEP_DOWN, p, 2000, true, 0);
    e.tick(tin(1000));
    e.abort("OPERATOR");
    TestTickOutput o = e.tick(tin(1100));
    TEST_ASSERT_EQUAL(TestEvent::ABORTED, o.event);
    TEST_ASSERT_TRUE(o.driver_enable);
    TEST_ASSERT_FLOAT_WITHIN(0.01f, 1000.0f, o.setpoint_rpm);   // 50 % of 2000, not back to 2000
}

void test_exec_t4_coasts_without_driver_and_completes_on_low_rpm() {
    TestExecutor e(tlim());
    TestParams p = {0, 0, 0};
    TEST_ASSERT_NULL(e.start(TestId::T4_COAST_DOWN, p, 1500, true, 0));
    TestTickOutput o = e.tick(tin(1000, 900));
    TEST_ASSERT_FALSE(o.driver_enable);
    TEST_ASSERT_TRUE(o.active);
    o = e.tick(tin(8000, 60));        // below 5 % of 1500 = 75
    TEST_ASSERT_EQUAL(TestEvent::COMPLETED, o.event);
    TEST_ASSERT_FALSE(o.driver_enable);
}

void test_exec_t4_times_out() {
    TestExecutor e(tlim());
    TestParams p = {0, 0, 0};
    e.start(TestId::T4_COAST_DOWN, p, 1500, true, 0);
    TestTickOutput o = e.tick(tin(60000, 500));
    TEST_ASSERT_EQUAL(TestEvent::COMPLETED, o.event);
}

// ---------------- Invariants ----------------
void test_default_limits_match_master_prompt() {
    Limits l = default_limits();
    TEST_ASSERT_EQUAL_FLOAT(30.0f, l.ramp_pct_per_s);
    TEST_ASSERT_EQUAL_FLOAT(70.0f, l.max_duty_pct);
    TEST_ASSERT_EQUAL_FLOAT(4.0f, l.current_stop_a);
    TEST_ASSERT_EQUAL_UINT32(2000, l.current_stop_ms);
    TEST_ASSERT_EQUAL_FLOAT(50.0f, l.temp_warn_c);
    TEST_ASSERT_EQUAL_FLOAT(60.0f, l.temp_stop_c);
    TEST_ASSERT_EQUAL_FLOAT(20.0f, l.volt_min_v);
    TEST_ASSERT_EQUAL_FLOAT(25.5f, l.volt_max_v);
    TEST_ASSERT_EQUAL_UINT32(2000, l.heartbeat_timeout_ms);
    TEST_ASSERT_EQUAL_UINT32(1000, l.rpm_loss_ms);
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_healthy_is_ok);
    RUN_TEST(test_instant_overcurrent_trips_immediately);
    RUN_TEST(test_sustained_overcurrent_needs_2s);
    RUN_TEST(test_overcurrent_timer_resets_on_dip);
    RUN_TEST(test_temperature_warn_and_stop);
    RUN_TEST(test_temp_rise_limit_only_when_configured);
    RUN_TEST(test_voltage_window);
    RUN_TEST(test_rpm_loss_when_driving_without_pulses);
    RUN_TEST(test_no_rpm_loss_when_idle);
    RUN_TEST(test_critical_sensor_invalid_trips_after_500ms);
    RUN_TEST(test_interlock_permits_only_when_everything_is_verified);
    RUN_TEST(test_interlock_blocks_each_unverified_condition_with_its_own_reason);
    RUN_TEST(test_fault_mask_keeps_every_simultaneous_cause_while_reason_keeps_the_first);
    RUN_TEST(test_estop_input_is_unknown_until_configured_and_never_released_when_unconfigured);
    RUN_TEST(test_estop_input_starts_unknown_asserts_immediately_and_releases_only_after_the_debounce);
    RUN_TEST(test_estop_input_treats_an_unreadable_sample_as_asserted_and_a_glitch_restarts_the_debounce);
    RUN_TEST(test_estop_input_debounce_is_wrap_safe);
    RUN_TEST(test_non_finite_critical_signal_is_invalid_and_trips_after_500ms);
    RUN_TEST(test_non_finite_non_critical_signal_does_not_trip_and_cannot_mask_a_real_limit);
    RUN_TEST(test_heartbeat_enforced_only_in_hardware_mode);
    RUN_TEST(test_heartbeat_timer_is_wraparound_safe);
    RUN_TEST(test_external_estop);
    RUN_TEST(test_trip_latches_and_keeps_first_cause);
    RUN_TEST(test_reset_requires_authorization_and_local_button);
    RUN_TEST(test_vibration_limit_disabled_until_commissioned);
    RUN_TEST(test_ramp_limits_slew_rate);
    RUN_TEST(test_drive_open_loop_soft_start_and_cap);
    RUN_TEST(test_drive_safety_override_is_immediate);
    RUN_TEST(test_set_speed_rejected_until_commissioned);
    RUN_TEST(test_pi_converges_on_first_order_plant_without_exceeding_cap);
    RUN_TEST(test_pi_antiwindup_integrator_bounded_when_saturated);
    RUN_TEST(test_cmd_accept_and_reject_basic);
    RUN_TEST(test_cmd_not_commissioned_and_sim_mode);
    RUN_TEST(test_cmd_start_duty_range);
    RUN_TEST(test_cmd_expired_and_bad_ttl);
    RUN_TEST(test_cmd_sequence_and_duplicate_idempotent);
    RUN_TEST(test_cmd_duplicate_flagged_so_it_is_not_reexecuted);
    RUN_TEST(test_cmd_unauthorized_rejected_but_stop_always_accepted);
    RUN_TEST(test_cmd_estop_latched_only_allows_heartbeat_reset);
    RUN_TEST(test_cmd_rejected_command_does_not_advance_sequence);
    RUN_TEST(test_exec_rejects_when_vib_limit_unset_or_not_running);
    RUN_TEST(test_exec_rejects_upward_and_out_of_envelope);
    RUN_TEST(test_exec_t1_steps_down_then_completes_and_holds);
    RUN_TEST(test_exec_second_test_rejected_while_active);
    RUN_TEST(test_exec_link_loss_mid_test_aborts_and_cuts_drive);
    RUN_TEST(test_exec_safety_trip_aborts);
    RUN_TEST(test_exec_command_abort_holds_current_speed_not_original);
    RUN_TEST(test_exec_t4_coasts_without_driver_and_completes_on_low_rpm);
    RUN_TEST(test_exec_t4_times_out);
    RUN_TEST(test_default_limits_match_master_prompt);
    return UNITY_END();
}
