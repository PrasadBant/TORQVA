#include "runtime_config.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace torqva {

static bool finite_num(float v) { return !isnan(v) && !isinf(v); }

const char* runtime_limits_validate(const RuntimeLimits& r) {
    if (r.version == 0) return "BAD_VERSION";
    if (!finite_num(r.max_current_a) || !(r.max_current_a > 0.0f) || r.max_current_a > kAbsMaxCurrentA) return "CURRENT_OUT_OF_RANGE";
    if (!finite_num(r.volt_min_v) || !finite_num(r.volt_max_v) || !(r.volt_min_v > 0.0f) || !(r.volt_max_v > r.volt_min_v) || r.volt_max_v > kAbsMaxVoltageV) return "VOLTAGE_OUT_OF_RANGE";
    if (!finite_num(r.max_temp_c) || !(r.max_temp_c > 0.0f) || r.max_temp_c > kAbsMaxTempC) return "TEMPERATURE_OUT_OF_RANGE";
    if (!finite_num(r.max_rpm) || !(r.max_rpm > 0.0f) || r.max_rpm > kAbsMaxRpm) return "RPM_OUT_OF_RANGE";
    if (!finite_num(r.max_duty_pct) || !(r.max_duty_pct > 0.0f) || r.max_duty_pct > 100.0f) return "DUTY_OUT_OF_RANGE";
    return nullptr;
}

Limits runtime_limits_to_limits(const RuntimeLimits& r, const Limits& base) {
    Limits l = base;
    l.version = r.version;
    l.current_stop_a = r.max_current_a;
    l.current_inst_a = r.max_current_a * kInstantCurrentFactor;
    l.volt_min_v = r.volt_min_v;
    l.volt_max_v = r.volt_max_v;
    l.temp_stop_c = r.max_temp_c;
    l.temp_warn_c = r.max_temp_c > 20.0f ? r.max_temp_c - 10.0f : r.max_temp_c * 0.8f;
    l.max_rpm = r.max_rpm;
    l.max_duty_pct = r.max_duty_pct;
    return l;
}

// ---- parsing (flat JSON, same conventions as protocol.cpp; values are validated after parsing)
static bool str_field(const char* line, const char* name, char* out, size_t cap) {
    char pat[16];
    snprintf(pat, sizeof(pat), "\"%s\":\"", name);
    const char* p = strstr(line, pat);
    if (!p) return false;
    p += strlen(pat);
    size_t i = 0;
    while (*p && *p != '"') {
        const char c = *p++;
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || c == '_') || i + 1 >= cap) return false;
        out[i++] = c;
    }
    if (*p != '"') return false;
    out[i] = 0;
    return true;
}

static bool num_field(const char* line, const char* name, double* out) {
    char pat[16];
    snprintf(pat, sizeof(pat), "\"%s\":", name);
    const char* p = strstr(line, pat);
    if (!p) return false;
    p += strlen(pat);
    if (!((*p >= '0' && *p <= '9') || *p == '-' || *p == '.')) return false;
    char* end = nullptr;
    const double v = strtod(p, &end);
    if (end == p) return false;
    *out = v;
    return true;
}

bool is_cfg_line(const char* line) {
    char t[8];
    return line && str_field(line, "t", t, sizeof(t)) && strcmp(t, "cfg") == 0;
}

const char* parse_cfg(const char* line, CfgMsg* out) {
    if (!line || !out) return "NULL";
    memset(out, 0, sizeof(*out));
    if (strlen(line) > 240) return "LINE_TOO_LONG";
    double ver, id, seq, ci, vl, vh, ct, rp, dp;
    if (!num_field(line, "ver", &ver) || ver < 1 || ver > 65535 || ver != floor(ver)) return "BAD_VERSION";
    if (!num_field(line, "id", &id) || id < 0 || id > 4294967295.0) return "BAD_ID";
    if (!num_field(line, "seq", &seq) || seq < 0 || seq > 4294967295.0) return "BAD_SEQ";
    if (!str_field(line, "sid", out->sid, sizeof(out->sid)) || !str_field(line, "m", out->mac, sizeof(out->mac))) return "BAD_AUTH_FIELDS";
    if (!num_field(line, "ci", &ci) || !num_field(line, "vl", &vl) || !num_field(line, "vh", &vh) || !num_field(line, "ct", &ct) || !num_field(line, "rp", &rp) || !num_field(line, "dp", &dp)) return "INCOMPLETE";
    out->id = (uint32_t)id; out->seq = (uint32_t)seq;
    out->lim.version = (uint16_t)ver;
    out->lim.max_current_a = (float)ci; out->lim.volt_min_v = (float)vl; out->lim.volt_max_v = (float)vh;
    out->lim.max_temp_c = (float)ct; out->lim.max_rpm = (float)rp; out->lim.max_duty_pct = (float)dp;
    return nullptr;
}

void cfg_canonical(const CfgMsg& m, char* out, size_t n) {
    snprintf(out, n, "cfg|%u|%lu|%lu|%s|%.3f|%.3f|%.3f|%.3f|%.3f|%.3f", (unsigned)m.lim.version, (unsigned long)m.id, (unsigned long)m.seq, m.sid,
             (double)m.lim.max_current_a, (double)m.lim.volt_min_v, (double)m.lim.volt_max_v, (double)m.lim.max_temp_c, (double)m.lim.max_rpm, (double)m.lim.max_duty_pct);
}

size_t encode_cfg_ack(char* buf, size_t n, uint16_t ver, bool ok, const char* reason) {
    const int w = snprintf(buf, n, "{\"t\":\"cfg_ack\",\"ver\":%u,\"ok\":%u,\"reason\":\"%s\"}", (unsigned)ver, ok ? 1u : 0u, reason ? reason : "");
    return (w > 0 && (size_t)w < n) ? (size_t)w : 0;
}

}  // namespace torqva
