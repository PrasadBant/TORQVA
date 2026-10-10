#include "commands.h"

namespace torqva {

Ack CommandValidator::remember(const Ack& a) {
    cache_[cache_head_].ack = a;
    cache_[cache_head_].used = true;
    cache_head_ = (cache_head_ + 1) % kCache;
    if (cache_n_ < kCache) cache_n_++;
    return a;
}

void CommandValidator::update_cached(uint32_t id, AckStatus s, const char* reason) {
    for (int i = 0; i < cache_n_; i++)
        if (cache_[i].used && cache_[i].ack.id == id) { cache_[i].ack.status = s; cache_[i].ack.reason = reason; }
}

Ack CommandValidator::validate(const Command& c, const CommandContext& ctx) {
    duplicate_ = false;
    for (int i = 0; i < cache_n_; i++)
        if (cache_[i].used && cache_[i].ack.id == c.id) { duplicate_ = true; return cache_[i].ack; }

    auto rej = [&](const char* why) { Ack a = {c.id, AckStatus::REJECTED, why}; return remember(a); };
    Ack ok = {c.id, AckStatus::ACCEPTED, "OK"};

    if (c.type == CmdType::UNKNOWN) return rej("UNKNOWN_TYPE");

    // STOP is always honoured: no auth, TTL or sequence check can delay a stop.
    if (c.type == CmdType::STOP) return remember(ok);

    if (!c.authorized) return rej("UNAUTHORIZED");
    if (c.ttl_ms == 0 || c.ttl_ms > 30000) return rej("BAD_TTL");
    if (c.age_ms >= c.ttl_ms) return rej("EXPIRED");
    if (seq_seen_ && c.seq <= last_seq_) return rej("OUT_OF_SEQUENCE");

    // Latched emergency stop: only heartbeat and reset are meaningful.
    if (ctx.safety_state == SafetyState::EMERGENCY_STOP &&
        c.type != CmdType::HEARTBEAT && c.type != CmdType::RESET_ESTOP)
        return rej("ESTOP_LATCHED");

    switch (c.type) {
        case CmdType::HEARTBEAT:
        case CmdType::REQUEST_RAW_BURST:
            break;
        case CmdType::SET_SPEED:
            if (!ctx.hardware_control_mode) return rej("NOT_IN_HARDWARE_CONTROL");
            if (lim_.max_rpm <= 0.0f) return rej("NOT_COMMISSIONED");
            if (!(c.param >= 0.0f && c.param <= lim_.max_rpm)) return rej("RPM_OUT_OF_RANGE");
            if (ctx.test_active) return rej("TEST_ACTIVE");
            break;
        case CmdType::START:
            if (!ctx.hardware_control_mode) return rej("NOT_IN_HARDWARE_CONTROL");
            if (!(c.param > 0.0f && c.param <= lim_.max_duty_pct)) return rej("DUTY_OUT_OF_RANGE");
            if (ctx.test_active) return rej("TEST_ACTIVE");
            break;
        case CmdType::RUN_TEST:
            if (!ctx.hardware_control_mode) return rej("NOT_IN_HARDWARE_CONTROL");
            if (ctx.test_active) return rej("TEST_ACTIVE");
            if (!(c.param == 1.0f || c.param == 3.0f || c.param == 4.0f)) return rej("UNKNOWN_TEST");
            break;   // test-specific envelope checked by TestExecutor::start
        case CmdType::ABORT_TEST:
            break;
        case CmdType::RESET_ESTOP:
            if (ctx.safety_state != SafetyState::EMERGENCY_STOP) return rej("NOT_LATCHED");
            break;
        default:
            return rej("UNKNOWN_TYPE");
    }

    seq_seen_ = true;
    last_seq_ = c.seq;
    return remember(ok);
}

}  // namespace torqva
