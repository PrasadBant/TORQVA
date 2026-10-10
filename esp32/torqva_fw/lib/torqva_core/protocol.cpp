#include "protocol.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace torqva {

// Finds `"name":` and returns a pointer to the first char of the value (after optional spaces).
static const char* find_value(const char* line, const char* name) {
    char pat[24];
    int n = snprintf(pat, sizeof(pat), "\"%s\"", name);
    if (n <= 0 || n >= (int)sizeof(pat)) return nullptr;
    const char* p = line;
    while ((p = strstr(p, pat)) != nullptr) {
        const char* q = p + n;
        while (*q == ' ') q++;
        if (*q == ':') {
            q++;
            while (*q == ' ') q++;
            return q;
        }
        p += n;
    }
    return nullptr;
}

static bool get_num(const char* line, const char* name, double* out) {
    const char* v = find_value(line, name);
    if (!v) return false;
    char* end = nullptr;
    double d = strtod(v, &end);
    if (end == v) return false;
    *out = d;
    return true;
}

static bool get_str(const char* line, const char* name, char* out, size_t cap) {
    const char* v = find_value(line, name);
    if (!v || *v != '"') return false;
    v++;
    size_t i = 0;
    while (*v && *v != '"') {
        if (i + 1 >= cap) return false;        // too long
        out[i++] = *v++;
    }
    if (*v != '"') return false;
    out[i] = 0;
    return true;
}

const char* cmd_type_name(CmdType t) {
    switch (t) {
        case CmdType::HEARTBEAT: return "HEARTBEAT";
        case CmdType::SET_SPEED: return "SET_SPEED";
        case CmdType::STOP: return "STOP";
        case CmdType::START: return "START";
        case CmdType::RUN_TEST: return "RUN_TEST";
        case CmdType::ABORT_TEST: return "ABORT_TEST";
        case CmdType::REQUEST_RAW_BURST: return "REQUEST_RAW_BURST";
        case CmdType::RESET_ESTOP: return "RESET_ESTOP";
        default: return "UNKNOWN";
    }
}

const char* ack_status_name(AckStatus s) {
    switch (s) {
        case AckStatus::ACCEPTED: return "ACCEPTED";
        case AckStatus::REJECTED: return "REJECTED";
        case AckStatus::COMPLETED: return "COMPLETED";
        case AckStatus::ABORTED: return "ABORTED";
    }
    return "REJECTED";
}

static CmdType type_from_name(const char* s) {
    static const CmdType all[] = {CmdType::HEARTBEAT, CmdType::SET_SPEED, CmdType::STOP, CmdType::START,
                                  CmdType::RUN_TEST, CmdType::ABORT_TEST, CmdType::REQUEST_RAW_BURST,
                                  CmdType::RESET_ESTOP};
    for (size_t i = 0; i < sizeof(all) / sizeof(all[0]); i++)
        if (strcmp(s, cmd_type_name(all[i])) == 0) return all[i];
    return CmdType::UNKNOWN;
}

const char* parse_command(const char* line, ParsedCommand* out) {
    if (!line || !out) return "NULL";
    memset(out, 0, sizeof(*out));
    const char* s = line;
    while (*s == ' ') s++;
    if (*s != '{') return "NOT_JSON_OBJECT";
    if (strlen(s) > 256) return "LINE_TOO_LONG";

    double id, ttl, seq;
    char tname[24];
    if (!get_num(s, "id", &id) || id < 0 || id > 4294967295.0) return "BAD_ID";
    if (!get_str(s, "type", tname, sizeof(tname))) return "BAD_TYPE";
    if (!get_num(s, "ttl", &ttl) || ttl < 0 || ttl > 4294967295.0) return "BAD_TTL";
    if (!get_num(s, "seq", &seq) || seq < 0 || seq > 4294967295.0) return "BAD_SEQ";

    out->cmd.id = (uint32_t)id;
    out->cmd.type = type_from_name(tname);
    out->cmd.ttl_ms = (uint32_t)ttl;
    out->cmd.seq = (uint32_t)seq;

    double d;
    out->cmd.param = get_num(s, "p", &d) ? (float)d : 0.0f;
    out->cmd.param2 = get_num(s, "p2", &d) ? (float)d : 0.0f;
    out->cmd.param3 = get_num(s, "p3", &d) ? (float)d : 0.0f;
    out->cmd.age_ms = (get_num(s, "age", &d) && d >= 0 && d < 4294967295.0) ? (uint32_t)d : 0;
    if (!get_str(s, "k", out->key, sizeof(out->key))) out->key[0] = 0;
    if (!get_str(s, "sid", out->sid, sizeof(out->sid))) out->sid[0] = 0;
    if (!get_str(s, "m", out->mac, sizeof(out->mac))) out->mac[0] = 0;
    out->cmd.authorized = false;   // set by the device after key comparison, never by the sender
    return nullptr;
}

size_t encode_ack(char* buf, size_t n, const Ack& a, const char* dev, const char* sid) {
    int w = snprintf(buf, n, "{\"t\":\"ack\",\"id\":%lu,\"status\":\"%s\",\"reason\":\"%s\"",
                     (unsigned long)a.id, ack_status_name(a.status), a.reason ? a.reason : "");
    if (w <= 0 || (size_t)w >= n) return 0;
    size_t used = (size_t)w;
    if (dev && dev[0]) {                      // device identity and session id, when known, bind the acknowledgement to ONE device and ONE session
        w = snprintf(buf + used, n - used, ",\"dev\":\"%s\"", dev);
        if (w <= 0 || (size_t)w >= n - used) return 0;
        used += (size_t)w;
    }
    if (sid && sid[0]) {
        w = snprintf(buf + used, n - used, ",\"sid\":\"%s\"", sid);
        if (w <= 0 || (size_t)w >= n - used) return 0;
        used += (size_t)w;
    }
    w = snprintf(buf + used, n - used, "}");
    return (w > 0 && (size_t)w < n - used) ? used + (size_t)w : 0;
}

size_t encode_accel(char* buf, size_t n, const AccelFrame& f) {
    int w;
    if (f.ok)
        w = snprintf(buf, n, "{\"t\":\"accel\",\"seq\":%lu,\"ts\":%lu,\"ok\":1,\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,\"mag\":%.3f}",
                     (unsigned long)f.seq, (unsigned long)f.ts_ms, f.x_g, f.y_g, f.z_g, f.mag_g);
    else
        w = snprintf(buf, n, "{\"t\":\"accel\",\"seq\":%lu,\"ts\":%lu,\"ok\":0}", (unsigned long)f.seq, (unsigned long)f.ts_ms);
    return (w > 0 && (size_t)w < n) ? (size_t)w : 0;
}

size_t encode_fast(char* buf, size_t n, const FastFrame& f) {
    int w = snprintf(buf, n,
        "{\"t\":\"fast\",\"seq\":%lu,\"ts\":%lu,\"rpm\":%.1f,\"sp\":%.1f,\"duty\":%.1f,"
        "\"v\":%.2f,\"i\":%.3f,\"p\":%.2f,\"q\":%u}",
        (unsigned long)f.seq, (unsigned long)f.ts_ms, f.rpm, f.setpoint_rpm, f.duty_pct,
        f.bus_v, f.current_a, f.power_w, (unsigned)f.quality);
    return (w > 0 && (size_t)w < n) ? (size_t)w : 0;
}

size_t encode_slow(char* buf, size_t n, const SlowFrame& f) {
    int w = snprintf(buf, n,
        "{\"t\":\"slow\",\"seq\":%lu,\"ts\":%lu,\"housing\":%.2f,\"ambient\":%.2f,\"q\":%u}",
        (unsigned long)f.seq, (unsigned long)f.ts_ms, f.housing_c, f.ambient_c, (unsigned)f.quality);
    return (w > 0 && (size_t)w < n) ? (size_t)w : 0;
}

size_t encode_status(char* buf, size_t n, const StatusFrame& f) {
    const char* st = f.state == SafetyState::OK ? "OK" : (f.state == SafetyState::WARN ? "WARN" : "EMERGENCY_STOP");
    int w = snprintf(buf, n,
        "{\"t\":\"status\",\"seq\":%lu,\"ts\":%lu,\"fw\":\"%s\",\"wiring\":\"%s\",\"limits_v\":%u,"
        "\"state\":\"%s\",\"reason\":\"%s\",\"mode\":\"%s\",\"drive\":\"%s\",\"ctl\":%u,"
        "\"hb_age\":%lu,\"test\":%u,\"proto\":%u,\"dev\":\"%s\",\"blk\":\"%s\",\"fm\":%lu,\"cfg\":%u,\"es\":%u}",
        (unsigned long)f.seq, (unsigned long)f.ts_ms, f.fw_version, f.wiring_id, (unsigned)f.limits_version,
        st, trip_reason_name(f.reason), f.mode, f.drive, f.control_enabled ? 1u : 0u,
        (unsigned long)f.heartbeat_age_ms, (unsigned)f.test_id, kWireProtocol, f.device_id ? f.device_id : "", f.start_block ? f.start_block : "",
        (unsigned long)f.fault_mask, (unsigned)f.cfg_version, (unsigned)f.estop_state);
    return (w > 0 && (size_t)w < n) ? (size_t)w : 0;
}

}  // namespace torqva
