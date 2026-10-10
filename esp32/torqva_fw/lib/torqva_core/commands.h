// Command validation + idempotency. Pure logic. Validation only: execution is the dispatcher's job.
#pragma once
#include <stdint.h>
#include "torqva_limits.h"
#include "safety.h"

namespace torqva {

enum class CmdType : uint8_t {
    HEARTBEAT = 0, SET_SPEED, STOP, START, RUN_TEST, ABORT_TEST, REQUEST_RAW_BURST, RESET_ESTOP, UNKNOWN
};

enum class AckStatus : uint8_t { ACCEPTED = 0, REJECTED, COMPLETED, ABORTED };

struct Command {
    uint32_t id;
    CmdType type;
    float param;          // SET_SPEED: rpm | START: duty % | RUN_TEST: test id (1,3,4)
    float param2;         // RUN_TEST: T1 target fraction | T3 duration_ms
    float param3;         // RUN_TEST: T1 hold_ms
    uint32_t ttl_ms;
    uint32_t age_ms;      // time already spent in queue/transit, stamped by the bridge
    uint32_t seq;
    bool authorized;      // set by the comms layer after auth check (token/HMAC: Phase 2)
};

struct Ack {
    uint32_t id;
    AckStatus status;
    const char* reason;   // static string
};

struct CommandContext {
    SafetyState safety_state;
    bool hardware_control_mode;
    bool test_active;
};

class CommandValidator {
public:
    explicit CommandValidator(const Limits& l) : lim_(l), last_seq_(0), seq_seen_(false), cache_n_(0), cache_head_(0) {}
    void set_limits(const Limits& l) { lim_ = l; }
    // Duplicate id -> the ORIGINAL ack (idempotent). STOP bypasses seq/TTL checks: it is never refused for staleness.
    Ack validate(const Command& c, const CommandContext& ctx);
    // Record the final result of a command (e.g. COMPLETED/ABORTED) so duplicates return it.
    void update_cached(uint32_t id, AckStatus s, const char* reason);

private:
    static const int kCache = 16;
    struct Entry { Ack ack; bool used; };
    Ack remember(const Ack& a);
    Limits lim_;
    uint32_t last_seq_; bool seq_seen_;
    Entry cache_[kCache];
    int cache_n_, cache_head_;
};

}  // namespace torqva
