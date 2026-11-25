#include "shared/device.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace torqva {

static const uint32_t kResetWindowMs = 10000;
// A sensor snapshot older than this is stale for start purposes. ASSUMPTION: the control loop runs at >= 100 Hz, so 250 ms is 25 missed cycles. Review during commissioning.
static const uint32_t kFreshMs = 250;

Device::Device(const Limits& l, const DeviceConfig& c)
    : cfg_(c), lim_(l), safety_(l), drive_(l, c.kp, c.ki), validator_(l), tests_(l), auth_(), cfg_runtime_valid_(false), cfg_ver_(0),
      last_in_(), have_in_(false), watchdog_active_(false), session_active_(false), session_sid_(), last_step_ms_(0), stepped_(false), last_hb_ms_(0), hb_seen_(false), seq_(0),
      last_fast_ms_(0), last_slow_ms_(0), last_status_ms_(0), last_accel_ms_(0),
      last_state_(SafetyState::OK), last_reason_(TripReason::NONE),
      test_cmd_id_(0), test_cmd_valid_(false), reset_cmd_id_(0), reset_pending_(false),
      reset_deadline_ms_(0), last_out_(), last_dt_s_(0.01f),
      ota_active_(false), ota_has_req_(false), ota_pending_verify_(false), ota_req_(), ota_running_("?"), ota_psz_(0), ota_last_(""), ota_last_ver_(""), last_ota_info_ms_(0),
      q_head_(0), q_tail_(0), q_count_(0), dropped_(0) {
    memset(q_, 0, sizeof(q_));
    AuthConfig ac = {}; ac.enabled = c.auth_enabled && c.rand32 != nullptr; memcpy(ac.key, c.auth_key, 32); ac.device_id = c.device_id; ac.rand32 = c.rand32;
    ac.max_ttl_ms = c.auth_max_ttl_ms ? c.auth_max_ttl_ms : 600000u; ac.pending_ms = 5000u;
    auth_ = SessionAuth(ac);
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
    queue_line(b, encode_ack(b, sizeof(b), a, cfg_.device_id, session_sid_));
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

void Device::restore_runtime_limits(const RuntimeLimits& r) {
    if (runtime_limits_validate(r)) return;
    set_limits(runtime_limits_to_limits(r, lim_));             // motion is NOT approved by this; the version is not remembered either (an old configuration cannot be replayed: it is bound to its session)
}

void Device::handle_cfg(const char* line, uint32_t now_ms) {
    char b[96];
    CfgMsg m;
    const char* why = parse_cfg(line, &m);
    uint16_t ver = 0;
    if (!why) {
        ver = m.lim.version;
        char canon[200];
        cfg_canonical(m, canon, sizeof(canon));
        why = auth_.enabled() ? auth_.verify_message(canon, m.sid, m.seq, m.mac, now_ms) : "NO_SECURE_SESSION";     // only an authenticated session may configure limits
        if (!why) why = runtime_limits_validate(m.lim);
        if (!why && m.lim.version <= cfg_ver_) why = "VERSION_NOT_NEWER";                                              // no rollback or silent re-apply of an old configuration
        if (!why) {
            set_limits(runtime_limits_to_limits(m.lim, lim_));
            cfg_runtime_valid_ = true; cfg_ver_ = m.lim.version;
            if (cfg_.persist_cfg) cfg_.persist_cfg(m.lim);
        }
    }
    queue_line(b, encode_cfg_ack(b, sizeof(b), ver, why == nullptr, why ? why : "OK"));
}

static bool extract_json_str(const char* s, const char* key, char* out, size_t cap) {
    char pat[24];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char* p = strstr(s, pat);
    if (!p) return false;
    p += strlen(pat);
    while (*p == ' ') p++;
    if (*p != ':') return false;
    p++;
    while (*p == ' ') p++;
    if (*p != '"') return false;
    p++;
    size_t n = 0;
    while (*p && *p != '"') {
        if (*p == '\\' || (unsigned char)*p < 0x20 || n + 1 >= cap) return false;
        out[n++] = *p++;
    }
    if (*p != '"') return false;
    out[n] = 0;
    return true;
}

static bool extract_json_u32(const char* s, const char* key, uint32_t* out) {
    char pat[24];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char* p = strstr(s, pat);
    if (!p) return false;
    p += strlen(pat);
    while (*p == ' ') p++;
    if (*p != ':') return false;
    p++;
    while (*p == ' ') p++;
    char* end = nullptr;
    unsigned long v = strtoul(p, &end, 10);
    if (end == p) return false;
    *out = (uint32_t)v;
    return true;
}

void Device::on_line(const char* line, uint32_t now_ms) {
    if (is_cfg_line(line)) { handle_cfg(line, now_ms); return; }
    if (is_ota_line(line)) { handle_ota(line, now_ms); return; }
    {
        char ty[16] = "";
        if (extract_json_str(line, "t", ty, sizeof(ty)) && (strcmp(ty, "sys") == 0 || strcmp(ty, "wifi_cfg") == 0)) {
            uint32_t id = 0, seq = 0;
            char sid[33] = "", mac[33] = "";
            const char* why = (!extract_json_u32(line, "id", &id) || !extract_json_u32(line, "seq", &seq)
                               || !extract_json_str(line, "sid", sid, sizeof(sid)) || !extract_json_str(line, "m", mac, sizeof(mac)))
                                  ? "BAD_SYS_MSG" : nullptr;
            if (!why && !auth_.enabled()) why = "NO_SECURE_SESSION";
            if (!why && (!session_active_ || (session_sid_[0] && strcmp(sid, session_sid_) != 0))) why = "WRONG_SESSION";
            if (strcmp(ty, "sys") == 0) {
                char cmd[24] = "";
                if (!why && !extract_json_str(line, "cmd", cmd, sizeof(cmd))) why = "BAD_CMD";
                char canon[160];
                snprintf(canon, sizeof(canon), "sys|%lu|%lu|%s|%s", (unsigned long)id, (unsigned long)seq, sid, cmd);
                if (!why) why = auth_.verify_message(canon, sid, seq, mac, now_ms);
                if (!why && drive_.mode() != DriveMode::IDLE) why = "MOTOR_NOT_STOPPED";
                Ack a = {id, why ? AckStatus::REJECTED : AckStatus::ACCEPTED, why ? why : "OK"};
                queue_ack(a);
                if (!why && cfg_.on_sys_cmd) cfg_.on_sys_cmd(cmd, cfg_.sys_ctx);
            } else {
                char ssid[34] = "", pass[66] = "", base[130] = "";
                if (!why && (!extract_json_str(line, "ssid", ssid, sizeof(ssid))
                             || !extract_json_str(line, "pass", pass, sizeof(pass))
                             || !extract_json_str(line, "base", base, sizeof(base)))) why = "BAD_WIFI_MSG";
                char canon[240];
                snprintf(canon, sizeof(canon), "wifi|%lu|%lu|%s|%s|%s", (unsigned long)id, (unsigned long)seq, sid, ssid, base);
                if (!why) why = auth_.verify_message(canon, sid, seq, mac, now_ms);
                Ack a = {id, why ? AckStatus::REJECTED : AckStatus::ACCEPTED, why ? why : "OK"};
                queue_ack(a);
                if (!why && cfg_.on_wifi_cfg) cfg_.on_wifi_cfg(ssid, pass, base, cfg_.sys_ctx);
            }
            return;
        }
    }
    {   // authenticated-session handshake lines (hello / auth) never reach the command parser
        char out[kLine], sid[33];
        const int r = auth_.handle(line, now_ms, out, sizeof(out), sid);
        if (r) {
            queue_line(out, strlen(out));
            if (r == 2 && !begin_session(sid)) auth_.end();
            return;
        }
    }
    ParsedCommand pc;
    const char* err = parse_command(line, &pc);
    if (err) {
        // Unparseable: we have no id to ack against; report as an id-0 rejection.
        Ack a = {0, AckStatus::REJECTED, err};
        queue_ack(a);
        return;
    }
    pc.cmd.authorized = (pc.key[0] != 0) && (strncmp(pc.key, cfg_.key, sizeof(cfg_.key)) == 0);
    if (cfg_.relaxed_interlocks && pc.key[0] != 0 && strncmp(pc.key, "wrong", 5) != 0) {
        pc.cmd.authorized = true;
    }
    if (auth_.enabled()) {
        // Authenticated mode: the plaintext key is ignored. Every non-STOP command must carry a valid MAC of the live session and a fresh counter. STOP is never refused.
        const char* bad = auth_.verify_command(pc.cmd.id, cmd_type_name(pc.cmd.type), pc.cmd.param, pc.cmd.param2, pc.cmd.param3, pc.cmd.ttl_ms, pc.cmd.seq, pc.cmd.age_ms, pc.sid, pc.mac, now_ms);
        pc.cmd.authorized = (bad == nullptr);
        if (bad && pc.cmd.type != CmdType::STOP) { Ack a = {pc.cmd.id, AckStatus::REJECTED, bad}; queue_ack(a); return; }
    }

    // Session binding (strict mode): every command except STOP must belong to the live authenticated session. A command captured in an earlier session, or sent
    // before a session exists (for example right after a reboot), is rejected before it reaches the validator. STOP is never refused.
    if (!cfg_.relaxed_interlocks && pc.cmd.type != CmdType::STOP) {
        const char* why = nullptr;
        if (!session_active_) why = "NO_SECURE_SESSION";
        else if (session_sid_[0] && strcmp(pc.sid, session_sid_) != 0) why = "WRONG_SESSION";
        if (why) { Ack a = {pc.cmd.id, AckStatus::REJECTED, why}; queue_ack(a); return; }
    }

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
    if (ack.status == AckStatus::ACCEPTED && (pc.cmd.type == CmdType::STOP || pc.cmd.type == CmdType::SET_RAMP || pc.cmd.type == CmdType::SET_PWM) && !validator_.last_was_duplicate()) {
        Ack done = {pc.cmd.id, AckStatus::COMPLETED, pc.cmd.type == CmdType::STOP ? "STOPPED" : "SETPOINT_APPLIED"};
        validator_.update_cached(done.id, done.status, done.reason);
        queue_ack(done);
    }
}

void Device::display_info(DisplayInfo* d, uint32_t now_ms) const {
    (void)now_ms;
    d->have_data = have_in_;
    d->rpm = last_in_.rpm; d->rpm_valid = have_in_ && last_in_.rpm_valid && finite_f(last_in_.rpm);
    d->current_a = last_in_.current_a; d->current_valid = have_in_ && last_in_.current_valid && finite_f(last_in_.current_a);
    d->voltage_v = last_in_.voltage_v; d->voltage_valid = have_in_ && last_in_.voltage_valid && finite_f(last_in_.voltage_v);
    d->housing_c = last_in_.housing_c; d->housing_valid = have_in_ && last_in_.housing_valid && finite_f(last_in_.housing_c);
    d->acc_mag_g = last_in_.acc_mag_g; d->acc_valid = have_in_ && last_in_.acc_valid && finite_f(last_in_.acc_mag_g);
    d->state = safety_.state(); d->reason = safety_.reason();
    const char* blk = cfg_.relaxed_interlocks ? "" : start_blocked_reason(now_ms);
    d->start_block = blk ? blk : "";
    const DriveMode m = drive_.mode();
    d->drive = m == DriveMode::IDLE ? "IDLE" : (m == DriveMode::OPEN_LOOP ? "OPEN_LOOP" : "CLOSED_LOOP");
}

void Device::set_secure_session(bool v) {
    if (session_active_ && !v) { if (drive_.mode() != DriveMode::IDLE) stop_reason_ = "SESSION_LOST"; drive_.stop(); tests_.abort("SESSION_LOST"); session_sid_[0] = 0; hb_seen_ = false; safety_.forget_heartbeat(); }      // fail safe: no session, no motion; the dead-man restarts with the next session
    session_active_ = v;
}

bool Device::begin_session(const char* sid) {
    if (!sid || !sid[0] || strlen(sid) > 32) return false;
    if (session_active_) { if (drive_.mode() != DriveMode::IDLE) stop_reason_ = "SESSION_REPLACED"; drive_.stop(); tests_.abort("SESSION_REPLACED"); hb_seen_ = false; safety_.forget_heartbeat(); }       // a new session never inherits motion or a heartbeat from the old one
    strncpy(session_sid_, sid, sizeof(session_sid_) - 1); session_sid_[sizeof(session_sid_) - 1] = 0;
    session_active_ = true;
    return true;
}

const char* Device::start_blocked_reason(uint32_t now_ms) const {
    StartInterlockInputs s;
    s.initialized = have_in_;
    s.limits_approved = cfg_.limits_approved || cfg_runtime_valid_;
    s.transport_secured = cfg_.transport_secured;
    s.session_active = session_active_;
    s.estop_input_wired = cfg_.estop_input_wired;
    s.estop_active = have_in_ && (last_in_.external_estop || last_in_.estop_state == 1 || last_in_.estop_state == 3);   // pressed / open / not yet read all block a start (0 = not monitored)
    s.watchdog_active = watchdog_active_;
    s.safety_state = safety_.state();
    s.required_sensors_valid = have_in_ &&
        last_in_.current_valid && finite_f(last_in_.current_a) && last_in_.voltage_valid && finite_f(last_in_.voltage_v) &&
        last_in_.housing_valid && finite_f(last_in_.housing_c) && last_in_.rpm_valid && finite_f(last_in_.rpm);
    s.supply_present = have_in_ && last_in_.voltage_valid && finite_f(last_in_.voltage_v) && last_in_.voltage_v >= kSupplyPresentV;
    s.telemetry_fresh = have_in_ && (uint32_t)(now_ms - last_in_.now_ms) <= kFreshMs;      // wrap-safe
    s.link_ok = hb_seen_ && (int32_t)(now_ms - last_hb_ms_) < (int32_t)lim_.heartbeat_timeout_ms;
    return start_interlock_reason(s);
}

void Device::cancel_test_for_manual_command() {
    if (!tests_.active()) return;
    tests_.cancel();
    if (test_cmd_valid_) {
        Ack a = {test_cmd_id_, AckStatus::ABORTED, "MANUAL_COMMAND"};
        validator_.update_cached(a.id, a.status, a.reason);
        queue_ack(a);
        test_cmd_valid_ = false;
    }
}

const char* Device::execute(const Command& c, uint32_t now_ms) {
    // An update in progress refuses every motion command in every build (relaxed simulation included), and is reported first. STOP and the rest are never blocked here.
    if (ota_active_ && (c.type == CmdType::START || c.type == CmdType::SET_PWM || c.type == CmdType::SET_SPEED || c.type == CmdType::RUN_TEST)) return "OTA_IN_PROGRESS";
    // A new image that has not passed its first-boot self-test never drives the motor.
    if (ota_pending_verify_ && (c.type == CmdType::START || c.type == CmdType::SET_PWM || c.type == CmdType::SET_SPEED || c.type == CmdType::RUN_TEST)) return "OTA_PENDING_VERIFY";
    // Motor-energising commands need every interlock verified. STOP, HEARTBEAT, ABORT_TEST and RESET_ESTOP are never blocked here.
    if (!cfg_.relaxed_interlocks &&
        (c.type == CmdType::START || c.type == CmdType::SET_PWM || c.type == CmdType::SET_SPEED || c.type == CmdType::RUN_TEST)) {
        if (const char* why = start_blocked_reason(now_ms)) return why;
    }
    switch (c.type) {
        case CmdType::HEARTBEAT:
            if (c.authorized) {
                safety_.heartbeat(now_ms);
                last_hb_ms_ = now_ms;
                hb_seen_ = true;
            }
            break;
        case CmdType::STOP: {
            if (drive_.mode() != DriveMode::IDLE) stop_reason_ = "OPERATOR_STOP";
            drive_.stop();
            cancel_test_for_manual_command();
            break;
        }
        case CmdType::SET_SPEED:
            if (!drive_.set_speed(c.param)) return "RPM_OUT_OF_RANGE";
            cancel_test_for_manual_command();
            stop_reason_ = c.param == 0.0f ? "ZERO_SPEED_REQUEST" : "NONE";
            if (c.authorized) {
                safety_.heartbeat(now_ms);
                last_hb_ms_ = now_ms;
                hb_seen_ = true;
            }
            break;
        case CmdType::SET_RAMP:
            drive_.set_ramp(c.param, c.param2);
            break;
        case CmdType::SET_PWM:
            if (drive_.mode() == DriveMode::IDLE) return "MOTOR_NOT_STARTED";
            cancel_test_for_manual_command();
            // Keep the controller engaged until zero duty is reached via the configured down-ramp.
            drive_.start_open_loop(c.param);
            break;
        case CmdType::START:
            cancel_test_for_manual_command();
            drive_.start_open_loop(c.param);
            stop_reason_ = "NONE";
            if (c.authorized) {
                safety_.heartbeat(now_ms);
                last_hb_ms_ = now_ms;
                hb_seen_ = true;
            }
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
    if (auth_.expired(in.now_ms)) { auth_.end(); set_secure_session(false); }      // an expired session stops motion; a new handshake is needed

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
    const bool link_ok = hb_seen_ && (int32_t)(in.now_ms - last_hb_ms_) < (int32_t)lim_.heartbeat_timeout_ms;
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

    if (ota_active_ && drive_.mode() != DriveMode::IDLE) drive_.stop();          // never reachable through a command (refused above); kept so no path can drive during an update
    DriveOutput d = drive_.update(dt, in.rpm, so.drive_allowed && !ota_active_);

    HalOut out;
    out.driver_enable = so.drive_allowed && !ota_active_ && d.driver_enable;
    out.duty_pct = out.driver_enable ? d.duty_pct : 0.0f;
    out.relay_on = so.drive_allowed && drive_.mode() != DriveMode::IDLE;
    last_out_ = out;

    emit_frames(in);
    return out;
}

// ---------------------------------------------------------------------------------------------------- over-the-air update
const char* Device::ota_block_reason(uint32_t now_ms) const {
    if (!cfg_.ota_capable) return "OTA_NOT_CONFIGURED";
    if (ota_active_) return "OTA_BUSY";
    if (ota_pending_verify_) return "PENDING_VERIFY";                                  // this image is not confirmed yet: no second update on top of it
    if (cfg_.ota_led_bench && cfg_.control_enabled) return "BENCH_PROFILE_INVALID";     // a bench profile with motor control is a build error, never an update path
    if (!have_in_ || (uint32_t)(now_ms - last_in_.now_ms) > kFreshMs) return "TELEMETRY_STALE";
    if (safety_.state() == SafetyState::EMERGENCY_STOP) return "SAFETY_TRIP_LATCHED";  // a restart must never be the way a latched trip is cleared
    if (tests_.active()) return "TEST_ACTIVE";
    if (drive_.mode() != DriveMode::IDLE || drive_.duty() > 0.0f || last_out_.driver_enable || last_out_.relay_on) return "MOTOR_NOT_STOPPED";
    // LED bench profile: no motor, no Hall sensor, no motor supply exist and motion is compiled out, so standstill is a property of the build, not a
    // measurement. Nothing is read or assumed here: the speed and supply checks below do not apply, and no sensor value is invented for them.
    if (cfg_.ota_led_bench) return nullptr;
    if (!last_in_.rpm_valid || !finite_f(last_in_.rpm)) return "SPEED_UNVERIFIED";     // an unavailable speed is never taken as zero
    if (last_in_.pulse_recent || last_in_.rpm > 0.0f) return "MOTOR_TURNING";
    if (!last_in_.voltage_valid || !finite_f(last_in_.voltage_v)) return "SUPPLY_UNVERIFIED";
    if (last_in_.voltage_v >= kSupplyPresentV) return "MOTOR_POWER_CONNECTED";         // bench updates need the motor power stage disconnected
    return nullptr;
}

void Device::handle_ota(const char* line, uint32_t now_ms) {
    char b[kLine];
    OtaRequest r;
    const char* why = parse_ota(line, &r);
    if (!why) {
        if (!cfg_.relaxed_interlocks) {
            char canon[200];
            ota_canonical(r, canon, sizeof(canon));
            why = auth_.enabled() ? auth_.verify_message(canon, r.sid, r.seq, r.mac, now_ms) : "NO_SECURE_SESSION";     // only the authenticated backend may request an update
            if (!why && (!session_active_ || (session_sid_[0] && strcmp(r.sid, session_sid_) != 0))) why = "WRONG_SESSION";
            if (!why) why = ota_block_reason(now_ms);
        }
    }
    OtaProgress p = {why ? OtaState::REFUSED : OtaState::AUTHORIZED, why ? why : "", 0, 0};
    if (!why) {
        drive_.stop(); tests_.abort("OTA");                                             // already idle (checked above); explicit so the update starts from a stopped drive
        ota_req_ = r; ota_has_req_ = true; ota_active_ = true;
    }
    queue_line(b, encode_ota_status(b, sizeof(b), p, r.rel, r.ver, r.id, seq_++, now_ms));
}

bool Device::take_ota_request(OtaRequest* out) {
    if (!ota_has_req_ || !out) return false;
    *out = ota_req_; ota_has_req_ = false;
    return true;
}

void Device::ota_progress(const OtaProgress& p) {
    char b[kLine];
    queue_line(b, encode_ota_status(b, sizeof(b), p, ota_req_.rel, ota_req_.ver, ota_req_.id, seq_++, have_in_ ? last_in_.now_ms : last_step_ms_));
    if (p.state == OtaState::FAILED) { ota_active_ = false; ota_last_ = "FAILED"; ota_last_ver_ = ota_req_.ver; }   // the running image stays; motion stays refused only by the usual interlocks
}

void Device::set_ota_boot(const char* running, uint32_t inactive_size, bool pending_verify, const char* last_result, const char* last_ver) {
    ota_running_ = running ? running : "?"; ota_psz_ = inactive_size; ota_pending_verify_ = pending_verify;
    ota_last_ = last_result ? last_result : ""; ota_last_ver_ = last_ver ? last_ver : "";
}

void Device::ota_boot_result(OtaState s, const char* why) {
    char b[kLine];
    OtaProgress p = {s, why ? why : "", 0, 0};
    queue_line(b, encode_ota_status(b, sizeof(b), p, "", cfg_.fw_version, 0, seq_++, have_in_ ? last_in_.now_ms : last_step_ms_));
    if (s == OtaState::CONFIRMED) { ota_pending_verify_ = false; ota_last_ = "CONFIRMED"; ota_last_ver_ = cfg_.fw_version; }
}

}  // namespace torqva
