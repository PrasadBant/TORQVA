// JSON-lines wire protocol (device <-> host). Minimal, allocation-free, host-testable.
// Commands are flat JSON objects; frames are flat JSON objects. One object per line.
//
// Command:  {"id":7,"type":"SET_SPEED","p":1500,"p2":0,"p3":0,"ttl":5000,"age":0,"seq":12,"k":"key"}
// Ack:      {"t":"ack","id":7,"status":"ACCEPTED","reason":"OK"}
// Frames:   t = fast | slow | status   (each has seq, ts)
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "commands.h"
#include "safety.h"

namespace torqva {

struct ParsedCommand {
    Command cmd;
    char key[32];
    char sid[33];     // session id the command claims to belong to ("" if absent); checked against the live session by Device::on_line
};

// Returns nullptr on success, else a static error string. Never reads past the NUL terminator.
const char* parse_command(const char* line, ParsedCommand* out);

const char* cmd_type_name(CmdType t);
const char* ack_status_name(AckStatus s);

// Encoders return the number of bytes written (excluding NUL), or 0 if the buffer was too small.
// dev: optional device identity echoed as "dev" so the receiver can bind the acknowledgement to ONE device (nullptr or "" omits it).
size_t encode_ack(char* buf, size_t n, const Ack& a, const char* dev = nullptr, const char* sid = nullptr);

enum SignalBits : uint8_t {
    Q_CURRENT = 1 << 0, Q_VOLTAGE = 1 << 1, Q_HOUSING = 1 << 2,
    Q_AMBIENT = 1 << 3, Q_RPM = 1 << 4, Q_VIB = 1 << 5
};

struct FastFrame {
    uint32_t seq, ts_ms;
    float rpm, setpoint_rpm, duty_pct, bus_v, current_a, power_w;
    uint8_t quality;      // SignalBits: bit set = VALID
};
struct SlowFrame {
    uint32_t seq, ts_ms;
    float housing_c, ambient_c;
    uint8_t quality;
};
struct StatusFrame {
    uint32_t seq, ts_ms;
    const char* fw_version;
    const char* wiring_id;
    uint16_t limits_version;
    SafetyState state;
    TripReason reason;
    const char* mode;     // "SIM" or "HW"
    const char* drive;    // IDLE / OPEN_LOOP / CLOSED_LOOP
    bool control_enabled;
    uint32_t heartbeat_age_ms;
    uint8_t test_id;      // 0 = none
};

size_t encode_fast(char* buf, size_t n, const FastFrame& f);
size_t encode_slow(char* buf, size_t n, const SlowFrame& f);
size_t encode_status(char* buf, size_t n, const StatusFrame& f);

}  // namespace torqva
