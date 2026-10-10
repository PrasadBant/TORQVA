#include "device.h"
#include <string.h>

namespace torqva {

static const uint32_t kFastPeriodMs = 100;
static const uint32_t kSlowPeriodMs = 1000;
static const uint32_t kStatusPeriodMs = 1000;
static const uint32_t kResetWindowMs = 10000;
// A sensor snapshot older than this is stale for start purposes. ASSUMPTION: the control loop runs at >= 100 Hz, so 250 ms is 25 missed cycles. Review during commissioning.
static const uint32_t kFreshMs = 250;

Device::Device(const Limits& l, const DeviceConfig& c)
    : cfg_(c), lim_(l), safety_(l), drive_(l, c.kp, c.ki), validator_(l), tests_(l),
      last_in_(), have_in_(false), watchdog_active_(false), session_active_(false), last_step_ms_(0), stepped_(false), last_hb_ms_(0), hb_seen_(false), seq_(0),
      last_fast_ms_(0), last_slow_ms_(0), last_status_ms_(0),
      last_state_(SafetyState::OK), last_reason_(TripReason::NONE),
      test_cmd_id_(0), test_cmd_valid_(false), reset_cmd_id_(0), reset_pending_(false),
      reset_deadline_ms_(0), last_out_(), last_dt_s_(0.01f),
      q_head_(0), q_tail_(0), q_count_(0), dropped_(0) {
    memset(q_, 0, sizeof(q_));
    last_out_.driver_enable = false; last_out_.duty_pct = 0; last_out_.relay_on = false;
}

void Device::set_limits(const Limits& l) {
    lim_ = l;
    safety_.set_limits(l);
    drive_.set_limits(l);
    validator_.set_limits(l);
    tests_.set_limits(l);
}

void Device::queue_line(const char* s, size_t len) {
    if (len == 0) return;
    if (q_count_ >= kQ) { dropped_++; return; }     // telemetry may be dropped; safety never depends on the queue
    if (len >= (size_t)kLine) len = kLine - 1;
    memcpy(q_[q_tail_], s, len);
    q_[q_tail_][len] = 0;
    q_tail_ = (q_tail_ + 1) % kQ;
    q_count_++;
}

void Device::queue_ack(const Ack& a) {
    char b[kLine];
    queue_line(b, encode_ack(b, sizeof(b), a, cfg_.device_id));
}

bool Device::pop_line(char* buf, size_t n) {
    if (q_count_ == 0 || n == 0) return false;
    strncpy(buf, q_[q_head_], n - 1);
    buf[n - 1] = 0;
    q_head_ = (q_head_ + 1) % kQ;
    q_count_--;
    return true;
}

CommandContext Device::ctx() const {
    CommandContext c;
    c.safety_state = safety_.state();
    c.hardware_control_mode = cfg_.control_enabled;
    c.test_active = tests_.active();
    return c;
}

void Device::on_line(const char* line, uint32_t now_ms) {
    ParsedCommand pc;
    const char* err = parse_command(line, &pc);
    if (err) {
        // Unparseable: we have no id to ack against; report as an id-0 rejection.
        Ack a = {0, AckStatus::REJECTED, err};
        queue_ack(a);
        return;
    }
    pc.cmd.authorized = (pc.key[0] != 0) && (strncmp(pc.key, cfg_.key, sizeof(cfg_.key)) == 0);

    Ack ack = validator_.validate(pc.cmd, ctx());
    if (ack.status == AckStatus::ACCEPTED && !validator_.last_was_duplicate()) {
        // Execution may still refuse (e.g. test envelope). Then the ONLY ack sent is the final REJECTED one.
        const char* why = execute(pc.cmd, now_ms);
        if (why) {
            ack.status = AckStatus::REJECTED;
            ack.reason = why;
            validator_.update_cached(ack.id, ack.status, ack.reason);
        }
    }
    queue_ack(ack);
    if (ack.status == AckStatus::ACCEPTED && pc.cmd.type == CmdType::STOP && !validator_.last_was_duplicate()) {
        Ack done = {pc.cmd.id, AckStatus::COMPLETED, "STOPPED"};
        validator_.update_cached(done.id, done.status, done.reason);
        queue_ack(done);
    }
}

void Device::set_secure_session(bool v) {
    if (session_active_ && !v) { drive_.stop(); tests_.abort("SESSION_LOST"); }      // fail safe: no session, no motion
    session_active_ = v;
}

const char* Device::start_blocked_reason(uint32_t now_ms) const {
    StartInterlockInputs s;
    s.initialized = have_in_;
    s.limits_approved = cfg_.limits_approved;
    s.transport_secured = cfg_.transport_secured;
    s.session_active = session_active_;
    s.estop_input_wired = cfg_.estop_input_wired;
    s.estop_active = have_in_ && last_in_.external_estop;
    s.watchdog_active = watchdog_active_;
    s.safety_state = safety_.state();
    s.required_sensors_valid = have_in_ &&
        last_in_.current_valid && finite_f(last_in_.current_a) && last_in_.voltage_valid && finite_f(last_in_.voltage_v) &&
        last_in_.housing_valid && finite_f(last_in_.housing_c) && last_in_.rpm_valid && finite_f(last_in_.rpm);
    s.telemetry_fresh = have_in_ && (uint32_t)(now_ms - last_in_.now_ms) <= kFreshMs;      // wrap-safe
    s.link_ok = hb_seen_ && (uint32_t)(now_ms - last_hb_ms_) < lim_.heartbeat_timeout_ms;
    return start_interlock_reason(s);
}

const char* Device::execute(const Command& c, uint32_t now_ms) {
    // Motor-energising commands need every interlock verified. STOP, HEARTBEAT, ABORT_TEST and RESET_ESTOP are never blocked here.
    if (!cfg_.relaxed_interlocks &&
        (c.type == CmdType::START || c.type == CmdType::SET_SPEED || c.type == CmdType::RUN_TEST)) {
        if (const char* why = start_blocked_reason(now_ms)) return why;
    }
    switch (c.type) {
        case CmdType::HEARTBEAT:
            if (c.authorized) { safety_.heartbeat(now_ms); last_hb_ms_ = now_ms; hb_seen_ = true; }
            break;
        case CmdType::STOP: {
            drive_.stop();
            tests_.abort("STOP_CMD");
            break;
        }
        case CmdType::SET_SPEED:
            if (!drive_.set_speed(c.param)) return "RPM_OUT_OF_RANGE";
            break;
        case CmdType::START:
            drive_.start_open_loop(c.param);
            break;
        case CmdType::RUN_TEST: {
            TestParams p;
            p.target_fraction = c.param2;
            p.hold_ms = (uint32_t)c.param3;
            p.duration_ms = (uint32_t)c.param2;
            const float sp = drive_.target_rpm();
            const bool running = drive_.mode() == DriveMode::CLOSED_LOOP;
            const char* why = tests_.start((TestId)(uint8_t)c.param, p, sp, running, now_ms);
            if (why) return why;
            test_cmd_id_ = c.id; test_cmd_valid_ = true;
            break;
        }
        case CmdType::ABORT_TEST:
            tests_.abort("COMMAND");
            break;
        case CmdType::RESET_ESTOP:
            reset_cmd_id_ = c.id; reset_pending_ = true; reset_deadline_ms_ = now_ms + kResetWindowMs;
            break;
        case CmdType::REQUEST_RAW_BURST:
            break;   // raw bursts are produced by the vibration task (not implemented in this layer)
        default:
            break;
    }
    return nullptr;
}

HalOut Device::step(const HalIn& in) {
    float dt = stepped_ ? (float)(uint32_t)(in.now_ms - last_step_ms_) / 1000.0f : 0.01f;
    if (dt < 0.001f) dt = 0.001f;
    if (dt > 0.1f) dt = 0.1f;
    stepped_ = true;
    last_in_ = in; have_in_ = true;
    last_step_ms_ = in.now_ms;
    last_dt_s_ = dt;

    // Local-button reset of a latched trip (needs a prior authorized RESET_ESTOP command).
    if (reset_pending_) {
        if ((int32_t)(in.now_ms - reset_deadline_ms_) > 0) {
            reset_pending_ = false;
            Ack a = {reset_cmd_id_, AckStatus::ABORTED, "RESET_TIMEOUT"};
            validator_.update_cached(a.id, a.status, a.reason);
            queue_ack(a);
        } else if (safety_.state() == SafetyState::EMERGENCY_STOP && in.button_pressed &&
                   safety_.reset_trip(true, true)) {
            reset_pending_ = false;
            drive_.stop();
            Ack a = {reset_cmd_id_, AckStatus::COMPLETED, "RESET"};
            validator_.update_cached(a.id, a.status, a.reason);
            queue_ack(a);
        }
    }

    SafetyInputs si;
    si.now_ms = in.now_ms;
    si.current_a = in.current_a;   si.current_valid = in.current_valid;
    si.voltage_v = in.voltage_v;   si.voltage_valid = in.voltage_valid;
    si.housing_c = in.housing_c;   si.housing_valid = in.housing_valid;
    si.ambient_c = in.ambient_c;   si.ambient_valid = in.ambient_valid;
    si.rpm = in.rpm;               si.rpm_valid = in.rpm_valid;
    si.rpm_pulse_seen_recently = in.pulse_recent;
    si.vib_rms_g = in.vib_rms_g;   si.vib_valid = in.vib_valid;
    si.duty_pct = drive_.duty();
    si.hardware_control_mode = cfg_.control_enabled;
    si.external_estop_active = in.external_estop;
    SafetyOutput so = safety_.update(si);

    // Diagnostic test executor: setpoint override, runs on-device.
    const bool link_ok = hb_seen_ && (uint32_t)(in.now_ms - last_hb_ms_) < lim_.heartbeat_timeout_ms;
    if (tests_.active()) {
        TestTickInput ti = {in.now_ms, so.drive_allowed, link_ok, in.rpm};
        TestTickOutput to = tests_.tick(ti);
        if (to.driver_enable) drive_.set_speed(to.setpoint_rpm); else drive_.stop();
        if (to.event != TestEvent::NONE && test_cmd_valid_) {
            AckStatus s = to.event == TestEvent::COMPLETED ? AckStatus::COMPLETED : AckStatus::ABORTED;
            const char* why = to.event == TestEvent::COMPLETED ? "TEST_DONE" : to.abort_reason;
            Ack a = {test_cmd_id_, s, why};
            validator_.update_cached(a.id, a.status, a.reason);
            queue_ack(a);
            test_cmd_valid_ = false;
        }
    }

    DriveOutput d = drive_.update(dt, in.rpm, so.drive_allowed);

    HalOut out;
    out.driver_enable = so.drive_allowed && d.driver_enable;
    out.duty_pct = out.driver_enable ? d.duty_pct : 0.0f;
    out.relay_on = so.drive_allowed && drive_.mode() != DriveMode::IDLE;
    last_out_ = out;

    emit_frames(in);
    return out;
}

void Device::emit_frames(const HalIn& in) {
    char b[kLine];
    uint8_t q = 0;
    if (in.current_valid) q |= Q_CURRENT;
    if (in.voltage_valid) q |= Q_VOLTAGE;
    if (in.housing_valid) q |= Q_HOUSING;
    if (in.ambient_valid) q |= Q_AMBIENT;
    if (in.rpm_valid) q |= Q_RPM;
    if (in.vib_valid) q |= Q_VIB;

    const bool changed = safety_.state() != last_state_ || safety_.reason() != last_reason_;
    if (stepped_ && ((uint32_t)(in.now_ms - last_fast_ms_) >= kFastPeriodMs || seq_ == 0)) {
        last_fast_ms_ = in.now_ms;
        FastFrame f = {seq_++, in.now_ms, in.rpm, drive_.target_rpm(), last_out_.duty_pct,
                       in.voltage_v, in.current_a, in.voltage_v * in.current_a, q};
        queue_line(b, encode_fast(b, sizeof(b), f));
    }
    if ((uint32_t)(in.now_ms - last_slow_ms_) >= kSlowPeriodMs) {
        last_slow_ms_ = in.now_ms;
        SlowFrame f = {seq_++, in.now_ms, in.housing_c, in.ambient_c, q};
        queue_line(b, encode_slow(b, sizeof(b), f));
    }
    if (changed || (uint32_t)(in.now_ms - last_status_ms_) >= kStatusPeriodMs) {
        last_status_ms_ = in.now_ms;
        last_state_ = safety_.state(); last_reason_ = safety_.reason();
        const DriveMode m = drive_.mode();
        StatusFrame f = {seq_++, in.now_ms, cfg_.fw_version, cfg_.wiring_id, lim_.version,
                         safety_.state(), safety_.reason(), cfg_.mode,
                         m == DriveMode::IDLE ? "IDLE" : (m == DriveMode::OPEN_LOOP ? "OPEN_LOOP" : "CLOSED_LOOP"),
                         cfg_.control_enabled, hb_seen_ ? (uint32_t)(in.now_ms - last_hb_ms_) : 0xFFFFFFFFu,
                         tests_.active() ? (uint8_t)tests_.id() : (uint8_t)0};
        queue_line(b, encode_status(b, sizeof(b), f));
    }
}

}  // namespace torqva
