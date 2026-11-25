// Authenticated USB session (host <-> device). Mutual challenge-response with a per-device 32-byte key, a per-session key, per-command HMAC, a strictly increasing command
// counter and session expiry. Integrity AND authenticity of every motion command; a checksum alone would not authenticate anything.
//
//   host   -> {"t":"hello","cn":"<32 hex>"}                                  client nonce
//   device -> {"t":"auth_ch","dn":"<32 hex>","proof":"<64 hex>"}              proof = HMAC(key, "dev|cn|dn|device_id")  (the device proves it holds the key)
//   host   -> {"t":"auth","proof":"<64 hex>","ttl":<ms>}                       proof = HMAC(key, "cli|dn|cn|device_id|ttl")
//   device -> {"t":"auth_ok","sid":"<16 hex>","ttl":<ms>}                      sid = HMAC(key,"sid|cn|dn")[0..8], session key sk = HMAC(key,"sk|cn|dn")
//   command carries "sid", "seq" (> every earlier seq of the session) and "m" = HMAC(sk, canonical)[0..16] over  id|type|p|p2|p3|ttl|seq|age|sid  (numbers as %lu / %.3f)
//
// NOT provided: confidentiality. USB serial remains inside the host's physical trust boundary; this does not make the link private.
// A reboot, a new hello, an expired ttl or a failed proof all end the session; nothing is ever carried over. One guess per hello (a failed proof clears the pending challenge).
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace torqva {

struct AuthConfig {
    bool enabled;                  // false: no key provisioned -> every auth attempt answers NO_KEY and no session can exist
    uint8_t key[32];               // per-device key (provisioned; never compiled in)
    const char* device_id;
    uint32_t (*rand32)();          // entropy source (esp_random on the target)
    uint32_t max_ttl_ms;           // longest session the device will grant
    uint32_t pending_ms;           // how long a challenge stays answerable
};

class SessionAuth {
public:
    SessionAuth();
    explicit SessionAuth(const AuthConfig& c);
    bool enabled() const { return cfg_.enabled; }

    // 0 = not an auth line (caller continues normally); 1 = handled, `out` holds the reply line; 2 = handled and a session now exists (`out` = auth_ok, `sid_out` = its id).
    int handle(const char* line, uint32_t now_ms, char* out, size_t n, char sid_out[33]);

    // nullptr = the command is authentic and fresh. Otherwise a static reason: NO_SECURE_SESSION, SESSION_EXPIRED, WRONG_SESSION, BAD_MAC, REPLAY.
    const char* verify_command(uint32_t id, const char* type, float p, float p2, float p3, uint32_t ttl, uint32_t seq, uint32_t age, const char* sid, const char* mac_hex, uint32_t now_ms);

    // Same checks for any other authenticated message (runtime configuration): live session, matching sid, valid MAC over `canon`, and a counter above every earlier one.
    const char* verify_message(const char* canon, const char* sid, uint32_t seq, const char* mac_hex, uint32_t now_ms);

    bool active() const { return active_; }
    bool expired(uint32_t now_ms) const { return active_ && (int32_t)(now_ms - expiry_ms_) >= 0; }
    void end();

private:
    AuthConfig cfg_;
    bool pending_; char cn_[33], dn_[33]; uint32_t pending_deadline_;
    bool active_; char sid_[17]; uint8_t sk_[32]; uint32_t expiry_ms_; uint32_t last_seq_;
};

}  // namespace torqva
