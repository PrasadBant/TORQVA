// Staged Wi-Fi network changes: the trial state machine (wifi_trial.h) and the Device's authenticated wifi_stage / wifi_commit / wifi_scan frames, against hooks that
// record what the real platform would have been asked to do. No hardware, no network, no flash.
#include <unity.h>
#include <string>
#include <stdio.h>
#include <string.h>
#include "shared/device.h"
#include "communication/wifi_trial.h"
#include "shared/sha256.h"

using namespace torqva;

void setUp() {}
void tearDown() {}

// ------------------------------------------------------------------------------------------------ trial state machine
void test_trial_length_is_clamped_and_defaults() {
    TEST_ASSERT_EQUAL_UINT32(WifiTrial::kDefaultTrialS, WifiTrial::clamp_trial_s(0));
    TEST_ASSERT_EQUAL_UINT32(WifiTrial::kMinTrialS, WifiTrial::clamp_trial_s(1));
    TEST_ASSERT_EQUAL_UINT32(WifiTrial::kMaxTrialS, WifiTrial::clamp_trial_s(100000));
    TEST_ASSERT_EQUAL_UINT32(90, WifiTrial::clamp_trial_s(90));
}

void test_trial_expires_exactly_once_and_is_wrap_safe() {
    WifiTrial t;
    TEST_ASSERT_FALSE(t.active());
    TEST_ASSERT_FALSE(t.expired(1000000));                              // never active: never expires
    const uint32_t start = 0xFFFFFF00u;                                  // millis() about to wrap
    t.start(start, 60);
    TEST_ASSERT_TRUE(t.active());
    TEST_ASSERT_EQUAL_UINT32(60, t.remaining_s(start));
    TEST_ASSERT_FALSE(t.expired(start + 59999u));
    TEST_ASSERT_EQUAL_UINT32(1, t.remaining_s(start + 59000u));
    TEST_ASSERT_TRUE(t.expired(start + 60000u));                         // crosses the 2^32 boundary
    TEST_ASSERT_EQUAL_UINT32(0, t.remaining_s(start + 60001u));
    TEST_ASSERT_TRUE(t.finish());
    TEST_ASSERT_FALSE(t.finish());                                       // already ended
    TEST_ASSERT_FALSE(t.expired(start + 70000u));
}

void test_boot_trials_are_bounded() {
    TEST_ASSERT_TRUE(WifiTrial::boot_trial_allowed(0));
    TEST_ASSERT_TRUE(WifiTrial::boot_trial_allowed(WifiTrial::kMaxBootTries - 1));
    TEST_ASSERT_FALSE(WifiTrial::boot_trial_allowed(WifiTrial::kMaxBootTries));       // a boot loop abandons the staged network
}

void test_stage_arguments_are_validated() {
    const char* base = "https://192.168.1.50:8443";
    TEST_ASSERT_NULL(wifi_stage_check("HomeNet", "password1", base, 0));
    TEST_ASSERT_NULL(wifi_stage_check("HomeNet", "password1", "", 120));             // empty base keeps the current backend address
    TEST_ASSERT_EQUAL_STRING("BAD_SSID", wifi_stage_check("", "password1", base, 0));
    TEST_ASSERT_EQUAL_STRING("BAD_SSID", wifi_stage_check("a\"b", "password1", base, 0));
    TEST_ASSERT_EQUAL_STRING("BAD_SSID", wifi_stage_check("this-name-is-way-longer-than-32-bytes", "password1", base, 0));
    TEST_ASSERT_EQUAL_STRING("BAD_PASSPHRASE", wifi_stage_check("HomeNet", "short", base, 0));
    TEST_ASSERT_EQUAL_STRING("BAD_PASSPHRASE", wifi_stage_check("HomeNet", "tab\tinside1", base, 0));
    TEST_ASSERT_EQUAL_STRING("BAD_BASE_URL", wifi_stage_check("HomeNet", "password1", "http://192.168.1.50:8443", 0));
    TEST_ASSERT_EQUAL_STRING("BAD_BASE_URL", wifi_stage_check("HomeNet", "password1", "https://has space", 0));
    TEST_ASSERT_EQUAL_STRING("BAD_TRIAL", wifi_stage_check("HomeNet", "password1", base, 5));
    TEST_ASSERT_EQUAL_STRING("BAD_TRIAL", wifi_stage_check("HomeNet", "password1", base, 99999));
}

void test_wifi_state_frame_is_bounded_and_escapes_the_name() {
    char b[160];
    const size_t n = encode_wifi_state(b, sizeof(b), 7, 1234, true, true, 42, "My\"Net\\x");
    TEST_ASSERT_TRUE(n > 0);
    TEST_ASSERT_NOT_NULL(strstr(b, "\"wst\":1"));
    TEST_ASSERT_NOT_NULL(strstr(b, "\"trial\":1"));
    TEST_ASSERT_NOT_NULL(strstr(b, "\"left\":42"));
    TEST_ASSERT_NOT_NULL(strstr(b, "\"act\":\"My?Net?x\""));
    char tiny[20];
    TEST_ASSERT_EQUAL_UINT32(0, (uint32_t)encode_wifi_state(tiny, sizeof(tiny), 1, 1, true, false, 0, "x"));   // never a truncated frame
}

// ------------------------------------------------------------------------------------------------ Device frames
static uint32_t g_rng = 11;
static uint32_t rnd() { g_rng = g_rng * 1103515245u + 12345u; return g_rng; }
static std::string drain(Device& d) { char b[320]; std::string o; while (d.pop_line(b, sizeof(b))) o += std::string(b) + "\n"; return o; }
static std::string field(const std::string& l, const char* name, size_t len) { std::string k = std::string("\"") + name + "\":\""; size_t p = l.find(k); return p == std::string::npos ? "" : l.substr(p + k.size(), len); }
static std::string hmachex(const uint8_t* key, const std::string& msg, size_t bytes) { uint8_t d[32]; char h[65]; hmac_sha256(key, 32, msg.data(), msg.size(), d); to_hex(d, bytes, h); return h; }

struct Hooks {
    int stage_calls = 0, commit_calls = 0, scan_calls = 0;
    std::string ssid, pass, base; uint32_t trial_s = 0;
    bool stage_ok = true, trial_active = false, scan_ok = true;
};
static Hooks H;
static bool on_stage(const char* s, const char* p, const char* b, uint32_t t, void*) { H.stage_calls++; H.ssid = s; H.pass = p; H.base = b; H.trial_s = t; if (H.stage_ok) H.trial_active = true; return H.stage_ok; }
static bool on_commit(void*) { H.commit_calls++; if (!H.trial_active) return false; H.trial_active = false; return true; }
static bool on_scan(void*) { H.scan_calls++; return H.scan_ok; }

struct Rig {
    Device dev; uint8_t key[32]; uint8_t sk[32]; std::string sid; uint32_t now; uint32_t seq;
    static DeviceConfig cfg(uint8_t* key, bool supported) {
        DeviceConfig c = {};
        c.fw_version = "3.2.0"; c.wiring_id = "W"; c.mode = "HW"; c.control_enabled = true; c.kp = 0.01f; c.ki = 0.03f;
        c.limits_approved = true; c.estop_input_wired = true; c.transport_secured = true; c.relaxed_interlocks = false;
        c.device_id = "RIG-1"; c.auth_enabled = true; c.rand32 = rnd; c.ota_capable = true; c.ota_why = "";
        c.wifi_stage_supported = supported; c.on_wifi_stage = on_stage; c.on_wifi_commit = on_commit; c.on_wifi_scan = on_scan;
        for (int i = 0; i < 32; i++) key[i] = c.auth_key[i] = (uint8_t)(i * 3 + 2);
        return c;
    }
    Rig(uint8_t* k, bool supported = true) : dev(default_limits(), cfg(k, supported)), now(1000), seq(0) { memcpy(key, k, 32); dev.set_watchdog_active(true); H = Hooks(); }
    bool login() {
        const std::string cn = "00112233445566778899aabbccddeeff";
        dev.on_line(("{\"t\":\"hello\",\"cn\":\"" + cn + "\"}").c_str(), now);
        std::string ch = drain(dev); std::string dn = field(ch, "dn", 32);
        if (dn.size() != 32) return false;
        dev.on_line(("{\"t\":\"auth\",\"proof\":\"" + hmachex(key, "cli|" + dn + "|" + cn + "|RIG-1|60000", 32) + "\",\"ttl\":60000}").c_str(), now + 5);
        std::string ok = drain(dev); sid = field(ok, "sid", 16);
        if (sid.size() != 16) return false;
        std::string skm = "sk|" + cn + "|" + dn; hmac_sha256(key, 32, skm.data(), skm.size(), sk);
        return true;
    }
    std::string mac(const std::string& canon, bool good) { std::string m = hmachex(sk, canon, 16); if (!good) m[0] = (m[0] == 'a') ? 'b' : 'a'; return m; }
    std::string stage(const char* ssid = "HomeNet", const char* pass = "password1", const char* base = "https://192.168.1.50:8443", uint32_t tr = 90, bool good_mac = true, const char* use_sid = nullptr, uint32_t use_seq = 0) {
        const uint32_t s = use_seq ? use_seq : ++seq; const std::string si = use_sid ? use_sid : sid; const uint32_t id = 700 + s;
        char canon[320], line[480];
        snprintf(canon, sizeof(canon), "wstage|%lu|%lu|%s|%s|%s|%lu", (unsigned long)id, (unsigned long)s, si.c_str(), ssid, base, (unsigned long)tr);
        snprintf(line, sizeof(line), "{\"t\":\"wifi_stage\",\"id\":%lu,\"seq\":%lu,\"sid\":\"%s\",\"ssid\":\"%s\",\"pass\":\"%s\",\"base\":\"%s\",\"tr\":%lu,\"m\":\"%s\"}",
                 (unsigned long)id, (unsigned long)s, si.c_str(), ssid, pass, base, (unsigned long)tr, mac(canon, good_mac).c_str());
        TEST_ASSERT_TRUE(strlen(line) < 512);                       // the USB line buffer is 512 bytes
        dev.on_line(line, now); return drain(dev);
    }
    std::string simple(const char* type, const char* tag, bool good_mac = true) {
        const uint32_t s = ++seq, id = 800 + s;
        char canon[200], line[300];
        snprintf(canon, sizeof(canon), "%s|%lu|%lu|%s", tag, (unsigned long)id, (unsigned long)s, sid.c_str());
        snprintf(line, sizeof(line), "{\"t\":\"%s\",\"id\":%lu,\"seq\":%lu,\"sid\":\"%s\",\"m\":\"%s\"}", type, (unsigned long)id, (unsigned long)s, sid.c_str(), mac(canon, good_mac).c_str());
        dev.on_line(line, now); return drain(dev);
    }
    std::string commit(bool good_mac = true) { return simple("wifi_commit", "wcommit", good_mac); }
    std::string scan(bool good_mac = true) { return simple("wifi_scan", "wscan", good_mac); }
};
static bool rejected(const std::string& out, const char* why) { return out.find("\"status\":\"REJECTED\"") != std::string::npos && out.find(std::string("\"reason\":\"") + why + "\"") != std::string::npos; }
static bool accepted(const std::string& out) { return out.find("\"status\":\"ACCEPTED\"") != std::string::npos; }

void test_frames_are_refused_when_the_platform_has_no_staging() {
    uint8_t k[32]; Rig r(k, false); TEST_ASSERT_TRUE(r.login());
    TEST_ASSERT_TRUE(rejected(r.stage(), "WIFI_STAGE_UNSUPPORTED"));
    TEST_ASSERT_TRUE(rejected(r.commit(), "WIFI_STAGE_UNSUPPORTED"));
    TEST_ASSERT_TRUE(rejected(r.scan(), "WIFI_STAGE_UNSUPPORTED"));
    TEST_ASSERT_EQUAL_INT(0, H.stage_calls + H.commit_calls + H.scan_calls);
}

void test_frames_need_the_authenticated_session() {
    uint8_t k[32]; Rig r(k);
    r.sid = "0000000000000000"; memset(r.sk, 1, 32);
    TEST_ASSERT_TRUE(rejected(r.stage(), "WRONG_SESSION"));                        // no login yet: there is no live session to belong to
    TEST_ASSERT_TRUE(r.login());
    TEST_ASSERT_TRUE(rejected(r.stage("HomeNet", "password1", "https://192.168.1.50:8443", 90, false), "BAD_MAC"));
    TEST_ASSERT_TRUE(rejected(r.stage("HomeNet", "password1", "https://192.168.1.50:8443", 90, true, "ffffffffffffffff"), "WRONG_SESSION"));
    TEST_ASSERT_TRUE(rejected(r.commit(false), "BAD_MAC"));
    TEST_ASSERT_TRUE(rejected(r.scan(false), "BAD_MAC"));
    TEST_ASSERT_EQUAL_INT(0, H.stage_calls + H.commit_calls + H.scan_calls);       // nothing reached the platform
}

void test_a_valid_stage_reaches_the_platform_with_its_arguments_and_cannot_be_replayed() {
    uint8_t k[32]; Rig r(k); TEST_ASSERT_TRUE(r.login());
    std::string out = r.stage("Home Net", "password1", "https://192.168.1.50:8443", 90);
    TEST_ASSERT_TRUE(accepted(out));
    TEST_ASSERT_EQUAL_INT(1, H.stage_calls);
    TEST_ASSERT_EQUAL_STRING("Home Net", H.ssid.c_str());
    TEST_ASSERT_EQUAL_STRING("password1", H.pass.c_str());
    TEST_ASSERT_EQUAL_STRING("https://192.168.1.50:8443", H.base.c_str());
    TEST_ASSERT_EQUAL_UINT32(90, H.trial_s);
    // The same sequence number again (a captured frame replayed): the authenticated layer refuses it before the platform is asked.
    out = r.stage("Home Net", "password1", "https://192.168.1.50:8443", 90, true, nullptr, r.seq);
    TEST_ASSERT_FALSE(accepted(out));
    TEST_ASSERT_EQUAL_INT(1, H.stage_calls);
}

void test_invalid_arguments_and_platform_failure_are_reported_not_applied() {
    uint8_t k[32]; Rig r(k); TEST_ASSERT_TRUE(r.login());
    TEST_ASSERT_TRUE(rejected(r.stage("HomeNet", "short", "https://192.168.1.50:8443", 90), "BAD_PASSPHRASE"));
    TEST_ASSERT_TRUE(rejected(r.stage("HomeNet", "password1", "http://192.168.1.50:8443", 90), "BAD_BASE_URL"));
    TEST_ASSERT_TRUE(rejected(r.stage("HomeNet", "password1", "https://192.168.1.50:8443", 5), "BAD_TRIAL"));
    TEST_ASSERT_EQUAL_INT(0, H.stage_calls);
    H.stage_ok = false;
    TEST_ASSERT_TRUE(rejected(r.stage(), "WIFI_STAGE_FAILED"));
    TEST_ASSERT_EQUAL_INT(1, H.stage_calls);
}

void test_commit_needs_an_active_trial_and_scan_reports_busy() {
    uint8_t k[32]; Rig r(k); TEST_ASSERT_TRUE(r.login());
    TEST_ASSERT_TRUE(rejected(r.commit(), "NO_TRIAL"));
    TEST_ASSERT_TRUE(accepted(r.stage()));
    TEST_ASSERT_TRUE(accepted(r.commit()));
    TEST_ASSERT_TRUE(rejected(r.commit(), "NO_TRIAL"));                           // already committed
    TEST_ASSERT_TRUE(accepted(r.scan()));
    H.scan_ok = false;
    TEST_ASSERT_TRUE(rejected(r.scan(), "SCAN_BUSY"));
}

void test_staging_is_refused_while_the_motor_is_running_but_commit_and_scan_are_not() {
    uint8_t k[32];
    DeviceConfig c = Rig::cfg(k, true);
    c.direct_mode = true; c.relaxed_interlocks = true;                              // the project's direct-control mode: a plain SET_PWM starts the drive
    Rig r(k);                                                                      // (only for its key material; the device under test is built below)
    Device dev(default_limits(), c);
    dev.set_watchdog_active(true);
    H = Hooks();
    uint32_t now = 1000;
    HalIn in = {}; in.now_ms = now; in.voltage_v = 12; in.voltage_valid = true; in.current_valid = true; in.housing_valid = true; in.housing_c = 25; in.rpm_valid = true;
    dev.step(in);
    dev.on_line("{\"id\":9,\"type\":\"START\",\"p\":30,\"p2\":0,\"p3\":0,\"ttl\":5000,\"age\":0,\"seq\":1,\"k\":\"sim-key\"}", now);
    for (int i = 0; i < 20; i++) { now += 10; in.now_ms = now; dev.step(in); }
    drain(dev);
    TEST_ASSERT_TRUE(dev.drive().mode() != DriveMode::IDLE);                       // the premise: the drive really is running
    // An authenticated session in this device: replay the handshake with this device's own key.
    const std::string cn = "00112233445566778899aabbccddeeff";
    dev.on_line(("{\"t\":\"hello\",\"cn\":\"" + cn + "\"}").c_str(), now);
    std::string dn = field(drain(dev), "dn", 32);
    dev.on_line(("{\"t\":\"auth\",\"proof\":\"" + hmachex(k, "cli|" + dn + "|" + cn + "|RIG-1|60000", 32) + "\",\"ttl\":60000}").c_str(), now + 5);
    const std::string sid = field(drain(dev), "sid", 16);
    TEST_ASSERT_EQUAL_UINT32(16, (uint32_t)sid.size());
    uint8_t sk[32]; std::string skm = "sk|" + cn + "|" + dn; hmac_sha256(k, 32, skm.data(), skm.size(), sk);
    auto send = [&](const std::string& canon, const std::string& body) { dev.on_line(body.c_str(), now); return drain(dev); (void)canon; };
    auto M = [&](const std::string& canon) { return hmachex(sk, canon, 16); };
    std::string canon = "wstage|71|71|" + sid + "|HomeNet|https://192.168.1.50:8443|90";
    std::string out = send(canon, "{\"t\":\"wifi_stage\",\"id\":71,\"seq\":71,\"sid\":\"" + sid + "\",\"ssid\":\"HomeNet\",\"pass\":\"password1\",\"base\":\"https://192.168.1.50:8443\",\"tr\":90,\"m\":\"" + M(canon) + "\"}");
    TEST_ASSERT_TRUE(rejected(out, "MOTOR_NOT_STOPPED"));
    TEST_ASSERT_EQUAL_INT(0, H.stage_calls);
    canon = "wscan|72|72|" + sid;                                                     // scanning does not drop the link, so it is allowed while running
    out = send(canon, "{\"t\":\"wifi_scan\",\"id\":72,\"seq\":72,\"sid\":\"" + sid + "\",\"m\":\"" + M(canon) + "\"}");
    TEST_ASSERT_TRUE(accepted(out));
    TEST_ASSERT_EQUAL_INT(1, H.scan_calls);
}

void test_wifi_state_is_reported_only_by_platforms_that_support_staging() {
    uint8_t k[32];
    {
        Rig r(k, false); r.dev.step(HalIn{}); HalIn in = {}; in.now_ms = 5000; r.dev.step(in);
        TEST_ASSERT_NULL(strstr(drain(r.dev).c_str(), "wifi_state"));
    }
    Rig r(k); r.dev.set_wifi_state(true, 77, "HomeNet");
    HalIn in = {}; in.now_ms = 5000; r.dev.step(in);
    const std::string out = drain(r.dev);
    TEST_ASSERT_TRUE(out.find("\"t\":\"wifi_state\"") != std::string::npos);
    TEST_ASSERT_TRUE(out.find("\"trial\":1") != std::string::npos);
    TEST_ASSERT_TRUE(out.find("\"left\":77") != std::string::npos);
    TEST_ASSERT_TRUE(out.find("\"act\":\"HomeNet\"") != std::string::npos);
}

int main() {
    UNITY_BEGIN();
    RUN_TEST(test_trial_length_is_clamped_and_defaults);
    RUN_TEST(test_trial_expires_exactly_once_and_is_wrap_safe);
    RUN_TEST(test_boot_trials_are_bounded);
    RUN_TEST(test_stage_arguments_are_validated);
    RUN_TEST(test_wifi_state_frame_is_bounded_and_escapes_the_name);
    RUN_TEST(test_frames_are_refused_when_the_platform_has_no_staging);
    RUN_TEST(test_frames_need_the_authenticated_session);
    RUN_TEST(test_a_valid_stage_reaches_the_platform_with_its_arguments_and_cannot_be_replayed);
    RUN_TEST(test_invalid_arguments_and_platform_failure_are_reported_not_applied);
    RUN_TEST(test_commit_needs_an_active_trial_and_scan_reports_busy);
    RUN_TEST(test_staging_is_refused_while_the_motor_is_running_but_commit_and_scan_are_not);
    RUN_TEST(test_wifi_state_is_reported_only_by_platforms_that_support_staging);
    return UNITY_END();
}
