// Staged Wi-Fi network changes ("trial" configuration). Hardware-agnostic so the policy is exercised by host tests.
//
// The working network stored in NVS is never overwritten to *try* a new one. A new network is staged (RAM, or NVS keys n_* written over USB provisioning), tried for a bounded
// time, and only committed - by an authenticated host request made over the NEW network after it paired and showed fresh telemetry. If the commit does not arrive
// before the trial ends, or the board restarts too many times while a trial is staged, the previous network is used again. Nothing here touches a motor output.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace torqva {

// Why a staged configuration is not acceptable (static string); nullptr = acceptable. trial_s == 0 means "use the default".
// ssid 1..32 bytes without control characters, quote or backslash; passphrase 8..63 bytes without control characters;
// base empty (keep the current backend address) or an https:// address of at most 128 characters without spaces or control characters.
const char* wifi_stage_check(const char* ssid, const char* pass, const char* base, uint32_t trial_s);

class WifiTrial {
public:
    static const uint32_t kDefaultTrialS = 120;
    static const uint32_t kMinTrialS = 30;
    static const uint32_t kMaxTrialS = 600;
    static const uint8_t kMaxBootTries = 3;          // boots that may start a staged trial before it is abandoned (a boot loop must not strand the board)

    static uint32_t clamp_trial_s(uint32_t s) { return s == 0 ? kDefaultTrialS : (s < kMinTrialS ? kMinTrialS : (s > kMaxTrialS ? kMaxTrialS : s)); }
    // May a staged configuration left in NVS be tried again, given how many boots already tried it?
    static bool boot_trial_allowed(uint8_t tries_so_far) { return tries_so_far < kMaxBootTries; }

    WifiTrial() : active_(false), start_ms_(0), trial_ms_(0) {}
    void start(uint32_t now_ms, uint32_t trial_s) { active_ = true; start_ms_ = now_ms; trial_ms_ = clamp_trial_s(trial_s) * 1000u; }
    bool active() const { return active_; }
    // True once the trial window has elapsed (wrap-safe). Does not change state: the platform reverts, then calls finish().
    bool expired(uint32_t now_ms) const { return active_ && (uint32_t)(now_ms - start_ms_) >= trial_ms_; }
    // Ends the trial (commit or revert). True when one was active.
    bool finish() { const bool was = active_; active_ = false; return was; }
    uint32_t remaining_s(uint32_t now_ms) const {
        if (!active_) return 0;
        const uint32_t el = (uint32_t)(now_ms - start_ms_);
        return el >= trial_ms_ ? 0u : (trial_ms_ - el + 999u) / 1000u;
    }

private:
    bool active_;
    uint32_t start_ms_, trial_ms_;
};

// "wifi_state" frame (device -> host): wst = this firmware supports staged changes, trial = a staged network is being tried, left = seconds left, act = the committed network name.
size_t encode_wifi_state(char* buf, size_t n, uint32_t seq, uint32_t ts_ms, bool supported, bool trial, uint32_t left_s, const char* active_ssid);

}  // namespace torqva
