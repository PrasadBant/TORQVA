#include "communication/wifi_trial.h"

#include <stdio.h>
#include <string.h>

namespace torqva {

static bool plain(const char* s, size_t lo, size_t hi, bool no_quote) {
    const size_t n = s ? strlen(s) : 0;
    if (n < lo || n > hi) return false;
    for (size_t i = 0; i < n; i++) {
        const unsigned char c = (unsigned char)s[i];
        if (c < 0x20 || c == 0x7f) return false;
        if (no_quote && (c == '"' || c == '\\')) return false;
    }
    return true;
}

const char* wifi_stage_check(const char* ssid, const char* pass, const char* base, uint32_t trial_s) {
    if (!plain(ssid, 1, 32, true)) return "BAD_SSID";
    if (!plain(pass, 8, 63, false)) return "BAD_PASSPHRASE";
    if (base && base[0]) {
        if (strncmp(base, "https://", 8) != 0 || !plain(base, 9, 128, true) || strchr(base, ' ')) return "BAD_BASE_URL";
    }
    if (trial_s != 0 && (trial_s < WifiTrial::kMinTrialS || trial_s > WifiTrial::kMaxTrialS)) return "BAD_TRIAL";
    return nullptr;
}

size_t encode_wifi_state(char* buf, size_t n, uint32_t seq, uint32_t ts_ms, bool supported, bool trial, uint32_t left_s, const char* active_ssid) {
    char act[40];
    size_t j = 0;
    for (size_t i = 0; active_ssid && active_ssid[i] && j + 1 < sizeof(act); i++) {       // the name is echoed into JSON: anything that could break the frame becomes '?'
        const unsigned char c = (unsigned char)active_ssid[i];
        act[j++] = (c < 0x20 || c == '"' || c == '\\' || c == 0x7f) ? '?' : (char)c;
    }
    act[j] = 0;
    const int w = snprintf(buf, n, "{\"t\":\"wifi_state\",\"seq\":%lu,\"ts\":%lu,\"wst\":%u,\"trial\":%u,\"left\":%lu,\"act\":\"%s\"}",
                           (unsigned long)seq, (unsigned long)ts_ms, supported ? 1u : 0u, trial ? 1u : 0u, (unsigned long)left_s, act);
    return (w > 0 && (size_t)w < n) ? (size_t)w : 0;
}

}  // namespace torqva
