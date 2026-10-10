#include "auth.h"
#include <stdio.h>
#include <string.h>
#include "sha256.h"

namespace torqva {

namespace {

bool is_hex(const char* s, size_t n) {
    for (size_t i = 0; i < n; i++) if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
    return s[n] == 0;
}

// Copies the string value of "name":"value" into out (value must be [0-9a-z_] only and at most cap-1 long). False if absent or malformed.
bool str_field(const char* line, const char* name, char* out, size_t cap) {
    char pat[24];
    snprintf(pat, sizeof(pat), "\"%s\":\"", name);
    const char* p = strstr(line, pat);
    if (!p) return false;
    p += strlen(pat);
    size_t i = 0;
    while (*p && *p != '"') {
        if (i + 1 >= cap) return false;
        const char c = *p++;
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || c == '_')) return false;
        out[i++] = c;
    }
    if (*p != '"') return false;
    out[i] = 0;
    return true;
}

bool num_field(const char* line, const char* name, uint32_t* out) {
    char pat[24];
    snprintf(pat, sizeof(pat), "\"%s\":", name);
    const char* p = strstr(line, pat);
    if (!p) return false;
    p += strlen(pat);
    if (*p < '0' || *p > '9') return false;
    uint64_t v = 0; int digits = 0;
    while (*p >= '0' && *p <= '9') { v = v * 10 + (uint64_t)(*p - '0'); if (++digits > 10 || v > 4294967295ull) return false; p++; }
    *out = (uint32_t)v;
    return true;
}

void hmac_hex(const uint8_t* key, const char* msg, size_t bytes, char* out) {
    uint8_t d[32];
    hmac_sha256(key, 32, msg, strlen(msg), d);
    to_hex(d, bytes, out);
}

void reply_err(char* out, size_t n, const char* why) { snprintf(out, n, "{\"t\":\"auth_err\",\"reason\":\"%s\"}", why); }

}  // namespace

SessionAuth::SessionAuth() : cfg_(), pending_(false), pending_deadline_(0), active_(false), expiry_ms_(0), last_seq_(0) {
    memset(&cfg_, 0, sizeof(cfg_)); cn_[0] = dn_[0] = sid_[0] = 0; memset(sk_, 0, sizeof(sk_));
}

SessionAuth::SessionAuth(const AuthConfig& c) : SessionAuth() { cfg_ = c; }

void SessionAuth::end() {
    active_ = false; pending_ = false;
    memset(sk_, 0, sizeof(sk_)); sid_[0] = 0; last_seq_ = 0;
}

int SessionAuth::handle(const char* line, uint32_t now_ms, char* out, size_t n, char sid_out[33]) {
    char t[12];
    if (!line || !str_field(line, "t", t, sizeof(t))) return 0;
    const bool hello = strcmp(t, "hello") == 0, auth = strcmp(t, "auth") == 0;
    if (!hello && !auth) return 0;
    if (strlen(line) > 200) { reply_err(out, n, "LINE_TOO_LONG"); return 1; }
    if (!cfg_.enabled || !cfg_.rand32) { reply_err(out, n, "NO_KEY"); return 1; }
    const char* dev = cfg_.device_id ? cfg_.device_id : "";

    if (hello) {
        char cn[33];
        if (!str_field(line, "cn", cn, sizeof(cn)) || strlen(cn) != 32 || !is_hex(cn, 32)) { reply_err(out, n, "BAD_HELLO"); return 1; }
        end();                                                  // a new hello always ends the previous session: nothing is inherited
        uint8_t raw[16];
        for (int i = 0; i < 4; i++) { const uint32_t r = cfg_.rand32(); raw[4 * i] = (uint8_t)(r >> 24); raw[4 * i + 1] = (uint8_t)(r >> 16); raw[4 * i + 2] = (uint8_t)(r >> 8); raw[4 * i + 3] = (uint8_t)r; }
        to_hex(raw, 16, dn_);
        memcpy(cn_, cn, 33);
        pending_ = true; pending_deadline_ = now_ms + cfg_.pending_ms;
        char msg[120], proof[65];
        snprintf(msg, sizeof(msg), "dev|%s|%s|%s", cn_, dn_, dev);
        hmac_hex(cfg_.key, msg, 32, proof);
        snprintf(out, n, "{\"t\":\"auth_ch\",\"dn\":\"%s\",\"proof\":\"%s\"}", dn_, proof);
        return 1;
    }

    // auth
    char proof[65]; uint32_t ttl;
    const bool live = pending_ && (int32_t)(now_ms - pending_deadline_) < 0;
    pending_ = false;                                           // one guess per challenge
    if (!live) { reply_err(out, n, "NO_CHALLENGE"); return 1; }
    if (!str_field(line, "proof", proof, sizeof(proof)) || strlen(proof) != 64 || !is_hex(proof, 64) || !num_field(line, "ttl", &ttl)) { reply_err(out, n, "BAD_AUTH"); return 1; }
    if (ttl < 1000 || ttl > cfg_.max_ttl_ms) { reply_err(out, n, "BAD_TTL"); return 1; }
    char msg[160], want[65];
    snprintf(msg, sizeof(msg), "cli|%s|%s|%s|%lu", dn_, cn_, dev, (unsigned long)ttl);
    hmac_hex(cfg_.key, msg, 32, want);
    if (!ct_equal(want, proof)) { reply_err(out, n, "BAD_PROOF"); return 1; }
    snprintf(msg, sizeof(msg), "sid|%s|%s", cn_, dn_);
    hmac_hex(cfg_.key, msg, 8, sid_);
    snprintf(msg, sizeof(msg), "sk|%s|%s", cn_, dn_);
    hmac_sha256(cfg_.key, 32, msg, strlen(msg), sk_);
    active_ = true; expiry_ms_ = now_ms + ttl; last_seq_ = 0;
    memcpy(sid_out, sid_, 17); sid_out[16] = 0;
    snprintf(out, n, "{\"t\":\"auth_ok\",\"sid\":\"%s\",\"ttl\":%lu}", sid_, (unsigned long)ttl);
    return 2;
}

const char* SessionAuth::verify_command(uint32_t id, const char* type, float p, float p2, float p3, uint32_t ttl, uint32_t seq, uint32_t age, const char* sid, const char* mac_hex, uint32_t now_ms) {
    if (!active_) return "NO_SECURE_SESSION";
    if (expired(now_ms)) return "SESSION_EXPIRED";
    if (!sid || strcmp(sid, sid_) != 0) return "WRONG_SESSION";
    if (!mac_hex || strlen(mac_hex) != 32 || !is_hex(mac_hex, 32)) return "BAD_MAC";
    char canon[160];
    snprintf(canon, sizeof(canon), "%lu|%s|%.3f|%.3f|%.3f|%lu|%lu|%lu|%s", (unsigned long)id, type, (double)p, (double)p2, (double)p3, (unsigned long)ttl, (unsigned long)seq, (unsigned long)age, sid);
    return verify_message(canon, sid, seq, mac_hex, now_ms);
}

const char* SessionAuth::verify_message(const char* canon, const char* sid, uint32_t seq, const char* mac_hex, uint32_t now_ms) {
    if (!active_) return "NO_SECURE_SESSION";
    if (expired(now_ms)) return "SESSION_EXPIRED";
    if (!sid || strcmp(sid, sid_) != 0) return "WRONG_SESSION";
    if (!mac_hex || strlen(mac_hex) != 32 || !is_hex(mac_hex, 32)) return "BAD_MAC";
    char want[33];
    uint8_t d[32];
    hmac_sha256(sk_, 32, canon, strlen(canon), d);
    to_hex(d, 16, want);
    if (!ct_equal(want, mac_hex)) return "BAD_MAC";
    if (seq <= last_seq_) return "REPLAY";                      // checked AFTER the MAC so an unauthenticated sender cannot move the counter
    last_seq_ = seq;
    return nullptr;
}

}  // namespace torqva
