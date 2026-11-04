// Over-the-air update: the core state machine (ota_run) against a fake platform port, the first-boot decisions, and the Device's authorisation and
// motion refusal. No hardware, no network, no flash: the fake port records what the real one would have been asked to do.
#include <unity.h>
#include <string>
#include <vector>
#include <stdio.h>
#include <string.h>
#include "device.h"
#include "ota.h"
#include "sha256.h"

using namespace torqva;

void setUp() {}
void tearDown() {}

// ------------------------------------------------------------------------------------------------ helpers
static std::vector<uint8_t> image(size_t n, uint16_t chip = 9, uint8_t magic = 0xE9) {
    std::vector<uint8_t> v(n);
    for (size_t i = 0; i < n; i++) v[i] = (uint8_t)(i * 31 + 7);
    v[0] = magic; v[12] = (uint8_t)(chip & 0xFF); v[13] = (uint8_t)(chip >> 8);
    return v;
}
static std::string sha_hex(const std::vector<uint8_t>& v) { uint8_t d[32]; char h[65]; sha256(v.data(), v.size(), d); to_hex(d, 32, h); return h; }

struct FakePort : OtaPort {
    std::vector<uint8_t> img;
    std::string manifest;
    bool wifi_ok = true, manifest_ok = true, open_ok = true, sig_ok = true, begin_ok = true, select_ok = true;
    long fail_write_at = -1;           // byte offset where flash_write fails
    long cut_at = -1;                  // byte offset where the stream breaks (read returns -1)
    long declared_len = -1;            // Content-Length override
    uint32_t slot = 3342336;           // the inactive partition of the project's partition table (app1, 3264 KB)
    size_t pos = 0;
    std::vector<uint8_t> written;
    bool began = false, selected = false, aborted = false, restarted = false, recorded = false, wifi_off = false;
    std::string signed_msg;
    bool wifi_connect() override { return wifi_ok; }
    void wifi_disconnect() override { wifi_off = true; }
    bool fetch_manifest(const OtaRequest&, char* out, size_t cap) override {
        if (!manifest_ok || manifest.size() + 1 > cap) return false;
        memcpy(out, manifest.c_str(), manifest.size() + 1); return true;
    }
    bool open_image(const OtaRequest&, uint32_t* len) override { if (!open_ok) return false; *len = declared_len >= 0 ? (uint32_t)declared_len : (uint32_t)img.size(); pos = 0; return true; }
    int read_image(uint8_t* buf, size_t n) override {
        if (cut_at >= 0 && (long)pos >= cut_at) return -1;
        size_t left = img.size() - pos; if (!left) return 0;
        size_t k = n < left ? n : left; if (k > 1500) k = 1500;               // network-sized chunks
        if (cut_at >= 0 && (long)(pos + k) > cut_at) k = (size_t)(cut_at - (long)pos);
        memcpy(buf, img.data() + pos, k); pos += k; return (int)k;
    }
    void close_image() override {}
    uint32_t inactive_partition_size() override { return slot; }
    bool flash_begin(uint32_t) override { began = begin_ok; return begin_ok; }
    bool flash_write(const uint8_t* b, size_t n) override {
        if (fail_write_at >= 0 && (long)(written.size() + n) > fail_write_at) return false;
        written.insert(written.end(), b, b + n); return true;
    }
    bool flash_finish_and_select() override { selected = select_ok; return select_ok; }
    void flash_abort() override { aborted = true; }
    bool verify_signature(const char* message, const char*) override { signed_msg = message; return sig_ok; }
    bool record_attempt(const char*, const char*) override { recorded = true; return true; }
    void restart() override { restarted = true; }
};

static std::string manifest_for(const std::vector<uint8_t>& img, const char* ver = "3.1.0", const char* rel = "0123456789ab", const char* chip = "esp32s3", long size = -1, const char* sha = nullptr) {
    char b[600];
    snprintf(b, sizeof(b), "{\"rel\":\"%s\",\"ver\":\"%s\",\"size\":%ld,\"sha256\":\"%s\",\"chip\":\"%s\",\"sig\":\"MEUCIQDsig==\"}", rel, ver,
             size >= 0 ? size : (long)img.size(), sha ? sha : sha_hex(img).c_str(), chip);
    return b;
}
static OtaRequest req(const char* ver = "3.1.0", const char* rel = "0123456789ab") {
    OtaRequest r = {}; r.id = 7; r.seq = 9;
    strcpy(r.rel, rel); strcpy(r.ver, ver); strcpy(r.tok, "00112233445566778899aabbccddeeff"); strcpy(r.sid, "aaaaaaaaaaaaaaaa"); strcpy(r.mac, "m");
    return r;
}
struct Log { std::vector<OtaProgress> p; };
static void sink(const OtaProgress& p, void* ctx) { static_cast<Log*>(ctx)->p.push_back(p); }
static bool saw(const Log& l, OtaState s) { for (size_t i = 0; i < l.p.size(); i++) if (l.p[i].state == s) return true; return false; }

static FakePort good_port(size_t n = 200000) { FakePort f; f.img = image(n); f.manifest = manifest_for(f.img); return f; }

// The common failure contract: a reason, a FAILED report, nothing selected, no restart.
static void expect_failed(FakePort& f, const Log& l, const char* got, const char* want) {
    TEST_ASSERT_NOT_NULL(got);
    TEST_ASSERT_EQUAL_STRING(want, got);
    TEST_ASSERT_TRUE(saw(l, OtaState::FAILED));
    TEST_ASSERT_EQUAL_STRING(want, l.p.back().reason);
    TEST_ASSERT_FALSE(f.selected);
    TEST_ASSERT_FALSE(f.restarted);
    TEST_ASSERT_FALSE(saw(l, OtaState::READY));
}

// ------------------------------------------------------------------------------------------------ message parsing
void test_ota_request_parses_strictly_and_canonicalises() {
    OtaRequest r;
    TEST_ASSERT_NULL(parse_ota("{\"t\":\"ota\",\"id\":5,\"rel\":\"0123456789ab\",\"ver\":\"3.1.0\",\"tok\":\"00112233445566778899aabbccddeeff\",\"seq\":12,\"sid\":\"aaaaaaaaaaaaaaaa\",\"m\":\"bb\"}", &r));
    char c[200]; ota_canonical(r, c, sizeof(c));
    TEST_ASSERT_EQUAL_STRING("ota|5|12|aaaaaaaaaaaaaaaa|0123456789ab|3.1.0|00112233445566778899aabbccddeeff", c);
    TEST_ASSERT_EQUAL_STRING("BAD_RELEASE", parse_ota("{\"t\":\"ota\",\"id\":5,\"rel\":\"../etc\",\"ver\":\"3.1.0\",\"tok\":\"00112233445566778899aabbccddeeff\",\"seq\":1,\"sid\":\"a\",\"m\":\"b\"}", &r));
    TEST_ASSERT_EQUAL_STRING("BAD_VERSION", parse_ota("{\"t\":\"ota\",\"id\":5,\"rel\":\"0123456789ab\",\"ver\":\"latest\",\"tok\":\"00112233445566778899aabbccddeeff\",\"seq\":1,\"sid\":\"a\",\"m\":\"b\"}", &r));
    TEST_ASSERT_EQUAL_STRING("BAD_TOKEN", parse_ota("{\"t\":\"ota\",\"id\":5,\"rel\":\"0123456789ab\",\"ver\":\"3.1.0\",\"tok\":\"short\",\"seq\":1,\"sid\":\"a\",\"m\":\"b\"}", &r));
    TEST_ASSERT_EQUAL_STRING("BAD_SEQ", parse_ota("{\"t\":\"ota\",\"id\":5,\"rel\":\"0123456789ab\",\"ver\":\"3.1.0\",\"tok\":\"00112233445566778899aabbccddeeff\",\"seq\":-1,\"sid\":\"a\",\"m\":\"b\"}", &r));
    TEST_ASSERT_TRUE(is_ota_line("{\"t\":\"ota\"}")); TEST_ASSERT_FALSE(is_ota_line("{\"t\":\"cfg\"}"));
}

void test_versions_compare_semantically_and_reject_garbage() {
    TEST_ASSERT_EQUAL(1, version_compare("3.1.0", "3.0.1"));
    TEST_ASSERT_EQUAL(1, version_compare("3.0.10", "3.0.9"));            // numeric, not lexical
    TEST_ASSERT_EQUAL(0, version_compare("3.1.0", "3.1.0"));
    TEST_ASSERT_EQUAL(-1, version_compare("3.1.0-dev", "3.1.0"));        // a suffixed build sorts before its release
    TEST_ASSERT_EQUAL(1, version_compare("3.1.0", "3.0.1-dev"));
    TEST_ASSERT_EQUAL(-2, version_compare("3.1", "3.1.0"));
    TEST_ASSERT_EQUAL(-2, version_compare("v3.1.0", "3.1.0"));
}

void test_image_header_requires_the_esp_magic_and_the_esp32s3_chip_id() {
    std::vector<uint8_t> ok = image(64), esp32 = image(64, 0), junk = image(64, 9, 0x7F);
    TEST_ASSERT_NULL(check_image_header(ok.data(), ok.size()));
    TEST_ASSERT_EQUAL_STRING("WRONG_CHIP", check_image_header(esp32.data(), esp32.size()));
    TEST_ASSERT_EQUAL_STRING("INVALID_IMAGE", check_image_header(junk.data(), junk.size()));
    TEST_ASSERT_EQUAL_STRING("INVALID_IMAGE", check_image_header(ok.data(), 10));
}

// ------------------------------------------------------------------------------------------------ the update state machine
void test_a_valid_signed_update_is_written_hashed_selected_recorded_and_restarted() {
    FakePort f = good_port(); Log l;
    TEST_ASSERT_NULL(ota_run(req(), "3.0.1-dev", f, sink, &l));
    TEST_ASSERT_TRUE(f.written == f.img);                                     // every byte, in order, into the inactive partition
    TEST_ASSERT_TRUE(f.selected); TEST_ASSERT_TRUE(f.recorded); TEST_ASSERT_TRUE(f.restarted); TEST_ASSERT_FALSE(f.aborted);
    TEST_ASSERT_EQUAL_STRING("torqva-fw|1|3.1.0|200000|" , f.signed_msg.substr(0, 25).c_str());   // the signature covers version, size, hash and chip
    TEST_ASSERT_TRUE(f.signed_msg.find(sha_hex(f.img)) != std::string::npos);
    const OtaState order[] = {OtaState::PREPARING, OtaState::WIFI, OtaState::MANIFEST, OtaState::DOWNLOADING, OtaState::VERIFYING, OtaState::READY, OtaState::REBOOTING};
    size_t k = 0;
    for (size_t i = 0; i < l.p.size() && k < 7; i++) if (l.p[i].state == order[k]) k++;
    TEST_ASSERT_EQUAL(7, (int)k);                                             // in this order
    uint32_t last = 0;
    for (size_t i = 0; i < l.p.size(); i++) if (l.p[i].state == OtaState::DOWNLOADING) { TEST_ASSERT_TRUE(l.p[i].bytes >= last); last = l.p[i].bytes; TEST_ASSERT_EQUAL_UINT32(200000, l.p[i].total); }
    TEST_ASSERT_EQUAL_UINT32(200000, last);                                   // progress is the bytes actually written
    TEST_ASSERT_FALSE(saw(l, OtaState::CONFIRMED));                           // a restart is not a confirmation
}

void test_wifi_unavailable_fails_before_anything_is_written() {
    FakePort f = good_port(); f.wifi_ok = false; Log l;
    expect_failed(f, l, ota_run(req(), "3.0.1", f, sink, &l), "WIFI_UNAVAILABLE");
    TEST_ASSERT_FALSE(f.began);
}

void test_server_unavailable_for_the_manifest_or_the_image_fails() {
    FakePort f = good_port(); f.manifest_ok = false; Log l;
    expect_failed(f, l, ota_run(req(), "3.0.1", f, sink, &l), "SERVER_UNAVAILABLE");
    FakePort g = good_port(); g.open_ok = false; Log m;
    expect_failed(g, m, ota_run(req(), "3.0.1", g, sink, &m), "SERVER_UNAVAILABLE");
    TEST_ASSERT_FALSE(g.began);
}

void test_an_interrupted_download_aborts_the_partition() {
    FakePort f = good_port(); f.cut_at = 90000; Log l;
    expect_failed(f, l, ota_run(req(), "3.0.1", f, sink, &l), "DOWNLOAD_INTERRUPTED");
    TEST_ASSERT_TRUE(f.aborted);
}

void test_a_short_stream_with_a_clean_end_is_still_interrupted() {
    FakePort f = good_port(); f.img.resize(150000); Log l;                   // server closes early; manifest still says 200000
    f.declared_len = 200000;
    expect_failed(f, l, ota_run(req(), "3.0.1", f, sink, &l), "DOWNLOAD_INTERRUPTED");
    TEST_ASSERT_TRUE(f.aborted);
}

void test_an_invalid_image_or_a_wrong_chip_is_refused_from_its_header() {
    FakePort f; f.img = image(50000, 9, 0x00); f.manifest = manifest_for(f.img); Log l;
    expect_failed(f, l, ota_run(req(), "3.0.1", f, sink, &l), "INVALID_IMAGE"); TEST_ASSERT_TRUE(f.aborted);
    FakePort g; g.img = image(50000, 0); g.manifest = manifest_for(g.img); Log m;
    expect_failed(g, m, ota_run(req(), "3.0.1", g, sink, &m), "WRONG_CHIP");
    FakePort h = good_port(); h.manifest = manifest_for(h.img, "3.1.0", "0123456789ab", "esp32"); Log n;
    expect_failed(h, n, ota_run(req(), "3.0.1", h, sink, &n), "WRONG_CHIP"); TEST_ASSERT_FALSE(h.began);   // refused from the manifest, before downloading
}

void test_a_bad_signature_is_refused_before_download() {
    FakePort f = good_port(); f.sig_ok = false; Log l;
    expect_failed(f, l, ota_run(req(), "3.0.1", f, sink, &l), "SIGNATURE_INVALID");
    TEST_ASSERT_FALSE(f.began);
}

void test_a_checksum_mismatch_aborts_and_never_selects_the_image() {
    FakePort f = good_port(); f.manifest = manifest_for(f.img, "3.1.0", "0123456789ab", "esp32s3", -1, "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"); Log l;
    expect_failed(f, l, ota_run(req(), "3.0.1", f, sink, &l), "CHECKSUM_MISMATCH");
    TEST_ASSERT_TRUE(f.aborted); TEST_ASSERT_TRUE(saw(l, OtaState::VERIFYING));
}

void test_incompatible_releases_are_refused() {
    FakePort a = good_port(); a.manifest = manifest_for(a.img, "3.0.1"); Log la;           // same version as running
    expect_failed(a, la, ota_run(req("3.0.1"), "3.0.1", a, sink, &la), "DOWNGRADE_REFUSED");
    FakePort b = good_port(); b.manifest = manifest_for(b.img, "2.9.0"); Log lb;           // older
    expect_failed(b, lb, ota_run(req("2.9.0"), "3.0.1", b, sink, &lb), "DOWNGRADE_REFUSED");
    FakePort c = good_port(); c.manifest = manifest_for(c.img, "3.2.0"); Log lc;           // manifest is not the release that was authorised
    expect_failed(c, lc, ota_run(req("3.1.0"), "3.0.1", c, sink, &lc), "MANIFEST_MISMATCH");
    FakePort d = good_port(); d.slot = 100000; Log ld;                                     // does not fit the inactive partition
    expect_failed(d, ld, ota_run(req(), "3.0.1", d, sink, &ld), "IMAGE_TOO_LARGE");
    FakePort e = good_port(); e.slot = 0; Log le;                                          // no OTA layout
    expect_failed(e, le, ota_run(req(), "3.0.1", e, sink, &le), "NO_INACTIVE_PARTITION");
    FakePort g = good_port(); g.declared_len = 199999; Log lg;
    expect_failed(g, lg, ota_run(req(), "3.0.1", g, sink, &lg), "SIZE_MISMATCH");
}

void test_flash_failures_abort_and_keep_the_running_image() {
    FakePort a = good_port(); a.fail_write_at = 70000; Log la;
    expect_failed(a, la, ota_run(req(), "3.0.1", a, sink, &la), "FLASH_WRITE_FAILED"); TEST_ASSERT_TRUE(a.aborted);
    FakePort b = good_port(); b.begin_ok = false; Log lb;
    expect_failed(b, lb, ota_run(req(), "3.0.1", b, sink, &lb), "FLASH_BEGIN_FAILED");
    FakePort c = good_port(); c.select_ok = false; Log lc;
    TEST_ASSERT_EQUAL_STRING("BOOT_SELECT_FAILED", ota_run(req(), "3.0.1", c, sink, &lc));
    TEST_ASSERT_FALSE(c.restarted); TEST_ASSERT_TRUE(c.aborted);
}

// ------------------------------------------------------------------------------------------------ first boot: confirm or roll back
void test_the_new_image_is_confirmed_only_when_every_self_test_passes() {
    SelfTestInputs ok = {true, true, true, true, true, true, true, true, true};
    TEST_ASSERT_NULL(ota_selftest(ok));
    struct { bool SelfTestInputs::*f; const char* why; } cases[] = {
        {&SelfTestInputs::device_initialised, "DEVICE_INIT"}, {&SelfTestInputs::outputs_disabled, "OUTPUTS_NOT_DISABLED"},
        {&SelfTestInputs::safety_initialised, "SAFETY_INIT"}, {&SelfTestInputs::watchdog_active, "WATCHDOG"}, {&SelfTestInputs::estop_input_read, "ESTOP_INPUT"},
        {&SelfTestInputs::sensors_initialised, "SENSORS"}, {&SelfTestInputs::identity_and_key, "IDENTITY"}, {&SelfTestInputs::ota_healthy, "OTA_CONFIG"},
        {&SelfTestInputs::host_link, "HOST_LINK"}};
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        SelfTestInputs s = ok; s.*(cases[i].f) = false;
        TEST_ASSERT_EQUAL_STRING(cases[i].why, ota_selftest(s));
    }
}

void test_boot_outcome_distinguishes_self_test_confirmed_and_rolled_back() {
    TEST_ASSERT_EQUAL((int)BootOutcome::NONE, (int)ota_boot_outcome(false, "", "3.0.1", false));
    TEST_ASSERT_EQUAL((int)BootOutcome::SELF_TEST, (int)ota_boot_outcome(true, "3.1.0", "3.1.0", true));
    TEST_ASSERT_EQUAL((int)BootOutcome::CONFIRMED, (int)ota_boot_outcome(true, "3.1.0", "3.1.0", false));
    TEST_ASSERT_EQUAL((int)BootOutcome::ROLLED_BACK, (int)ota_boot_outcome(true, "3.1.0", "3.0.1", false));   // restart before confirmation, or a failed self-test
}

// ------------------------------------------------------------------------------------------------ the Device: authorisation, eligibility, no motion
static uint32_t g_rng = 11;
static uint32_t rnd() { g_rng = g_rng * 1103515245u + 12345u; return g_rng; }
static std::string drain(Device& d) { char b[320]; std::string o; while (d.pop_line(b, sizeof(b))) o += std::string(b) + "\n"; return o; }
static std::string field(const std::string& l, const char* name, size_t len) { std::string k = std::string("\"") + name + "\":\""; size_t p = l.find(k); return p == std::string::npos ? "" : l.substr(p + k.size(), len); }
static std::string hmachex(const uint8_t* key, const std::string& msg, size_t bytes) { uint8_t d[32]; char h[65]; hmac_sha256(key, 32, msg.data(), msg.size(), d); to_hex(d, bytes, h); return h; }

struct OtaRig {
    Device dev; uint8_t key[32]; uint8_t sk[32]; std::string sid; uint32_t now; uint32_t seq;
    static DeviceConfig cfg(uint8_t* key, bool capable) {
        DeviceConfig c = {};
        c.fw_version = "3.0.1"; c.wiring_id = "W"; c.mode = "HW"; c.control_enabled = true; c.kp = 0.01f; c.ki = 0.03f;
        c.limits_approved = true; c.estop_input_wired = true; c.transport_secured = true; c.relaxed_interlocks = false;
        c.device_id = "RIG-1"; c.auth_enabled = true; c.rand32 = rnd; c.ota_capable = capable; c.ota_why = capable ? "" : "NO_OTA_PARTITIONS";
        for (int i = 0; i < 32; i++) key[i] = c.auth_key[i] = (uint8_t)(i * 3 + 2);
        return c;
    }
    OtaRig(uint8_t* k, bool capable = true) : dev(default_limits(), cfg(k, capable)), now(1000), seq(0) { memcpy(key, k, 32); dev.set_watchdog_active(true); }
    // A bench snapshot: shaft still and measured (Hall valid, 0 rpm, no recent pulse), motor supply measured as absent.
    HalIn bench(float rpm = 0, bool rpm_valid = true, bool pulse = false, float volts = 0.05f, bool v_valid = true) {
        HalIn in = {}; in.now_ms = now;
        in.current_a = 0.01f; in.current_valid = true; in.voltage_v = volts; in.voltage_valid = v_valid;
        in.housing_c = 24; in.housing_valid = true; in.ambient_c = 23; in.ambient_valid = true; in.rpm = rpm; in.rpm_valid = rpm_valid; in.pulse_recent = pulse;
        in.estop_state = 2;
        return in;
    }
    HalOut step(const HalIn& in) { HalOut o = dev.step(in); return o; }
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
    std::string ota(const char* ver = "3.1.0", bool good_mac = true, const char* use_sid = nullptr) {
        seq++;
        const std::string s = use_sid ? use_sid : sid;
        char canon[220], line[300];
        snprintf(canon, sizeof(canon), "ota|%lu|%lu|%s|0123456789ab|%s|00112233445566778899aabbccddeeff", (unsigned long)(500 + seq), (unsigned long)seq, s.c_str(), ver);
        uint8_t d[32]; char m[33]; hmac_sha256(sk, 32, canon, strlen(canon), d); to_hex(d, 16, m); if (!good_mac) m[0] = (m[0] == 'a') ? 'b' : 'a';
        snprintf(line, sizeof(line), "{\"t\":\"ota\",\"id\":%lu,\"rel\":\"0123456789ab\",\"ver\":\"%s\",\"tok\":\"00112233445566778899aabbccddeeff\",\"seq\":%lu,\"sid\":\"%s\",\"m\":\"%s\"}",
                 (unsigned long)(500 + seq), ver, (unsigned long)seq, s.c_str(), m);
        dev.on_line(line, now); return drain(dev);
    }
    std::string cmd(const char* type, float p) {
        seq++;
        char canon[200], line[300];
        snprintf(canon, sizeof(canon), "%lu|%s|%.3f|%.3f|%.3f|%lu|%lu|%lu|%s", (unsigned long)(100 + seq), type, (double)p, 0.0, 0.0, 5000ul, (unsigned long)seq, 0ul, sid.c_str());
        uint8_t d[32]; char m[33]; hmac_sha256(sk, 32, canon, strlen(canon), d); to_hex(d, 16, m);
        snprintf(line, sizeof(line), "{\"id\":%lu,\"type\":\"%s\",\"p\":%.3f,\"p2\":0.000,\"p3\":0.000,\"ttl\":5000,\"age\":0,\"seq\":%lu,\"sid\":\"%s\",\"m\":\"%s\"}",
                 (unsigned long)(100 + seq), type, (double)p, (unsigned long)seq, sid.c_str(), m);
        dev.on_line(line, now); return drain(dev);
    }
};

static bool refused(const std::string& out, const char* why) { return out.find("\"st\":\"REFUSED\"") != std::string::npos && out.find(std::string("\"why\":\"") + why + "\"") != std::string::npos; }

void test_an_update_request_needs_the_authenticated_session() {
    uint8_t k[32]; OtaRig r(k); r.step(r.bench()); drain(r.dev);
    TEST_ASSERT_TRUE(refused(r.ota(), "NO_SECURE_SESSION"));                 // before login: verify_message has no session
    TEST_ASSERT_TRUE(r.login()); r.step(r.bench()); drain(r.dev);
    TEST_ASSERT_TRUE(refused(r.ota("3.1.0", false), "BAD_MAC"));
    TEST_ASSERT_TRUE(refused(r.ota("3.1.0", true, "ffffffffffffffff"), "WRONG_SESSION"));
    OtaRequest got;
    TEST_ASSERT_FALSE(r.dev.take_ota_request(&got));                        // nothing was authorised
}

void test_a_device_without_ota_support_refuses_every_request() {
    uint8_t k[32]; OtaRig r(k, false); TEST_ASSERT_TRUE(r.login()); r.step(r.bench()); drain(r.dev);
    TEST_ASSERT_TRUE(refused(r.ota(), "OTA_NOT_CONFIGURED"));
    r.now += 1100; std::string info = (r.step(r.bench()), drain(r.dev));
    TEST_ASSERT_TRUE(info.find("\"t\":\"ota_info\",\"seq\":") != std::string::npos && info.find("\"cap\":0,\"why\":\"NO_OTA_PARTITIONS\"") != std::string::npos);
}

void test_eligibility_never_takes_an_unavailable_reading_as_safe() {
    uint8_t k[32];
    { OtaRig r(k); TEST_ASSERT_TRUE(r.login()); r.step(r.bench(0, false)); drain(r.dev); TEST_ASSERT_TRUE(refused(r.ota(), "SPEED_UNVERIFIED")); }
    { OtaRig r(k); TEST_ASSERT_TRUE(r.login()); r.step(r.bench(0, true, true)); drain(r.dev); TEST_ASSERT_TRUE(refused(r.ota(), "MOTOR_TURNING")); }
    { OtaRig r(k); TEST_ASSERT_TRUE(r.login()); r.step(r.bench(120)); drain(r.dev); TEST_ASSERT_TRUE(refused(r.ota(), "MOTOR_TURNING")); }
    { OtaRig r(k); TEST_ASSERT_TRUE(r.login()); r.step(r.bench(0, true, false, 0, false)); drain(r.dev); TEST_ASSERT_TRUE(refused(r.ota(), "SUPPLY_UNVERIFIED")); }
    { OtaRig r(k); TEST_ASSERT_TRUE(r.login()); r.step(r.bench(0, true, false, 24.0f)); drain(r.dev); TEST_ASSERT_TRUE(refused(r.ota(), "MOTOR_POWER_CONNECTED")); }
    { OtaRig r(k); TEST_ASSERT_TRUE(r.login()); r.step(r.bench()); r.now += 1000; drain(r.dev); TEST_ASSERT_TRUE(refused(r.ota(), "TELEMETRY_STALE")); }
    { OtaRig r(k); TEST_ASSERT_TRUE(r.login()); r.dev.latch_boot_fault(TripReason::RESET_FAULT); r.step(r.bench()); drain(r.dev);
      TEST_ASSERT_TRUE(refused(r.ota(), "SAFETY_TRIP_LATCHED")); }                                      // a restart must never clear a latched trip
}

void test_an_authorised_update_refuses_motion_keeps_stop_and_outputs_off_until_it_ends() {
    uint8_t k[32]; OtaRig r(k); TEST_ASSERT_TRUE(r.login()); r.step(r.bench()); drain(r.dev);
    std::string a = r.ota();
    TEST_ASSERT_TRUE(a.find("\"st\":\"AUTHORIZED\"") != std::string::npos);
    TEST_ASSERT_TRUE(r.dev.ota_active());
    OtaRequest got; TEST_ASSERT_TRUE(r.dev.take_ota_request(&got)); TEST_ASSERT_EQUAL_STRING("3.1.0", got.ver);
    TEST_ASSERT_FALSE(r.dev.take_ota_request(&got));                         // handed over once
    TEST_ASSERT_TRUE(refused(r.ota("3.2.0"), "OTA_BUSY"));
    TEST_ASSERT_TRUE(r.cmd("START", 20).find("OTA_IN_PROGRESS") != std::string::npos);
    std::string sp = r.cmd("SET_SPEED", 600);
    TEST_ASSERT_TRUE(sp.find("REJECTED") != std::string::npos && sp.find("ACCEPTED") == std::string::npos);   // refused (validator: no commissioned speed limit; execution: OTA_IN_PROGRESS)
    TEST_ASSERT_TRUE(r.cmd("STOP", 0).find("ACCEPTED") != std::string::npos);     // STOP is never refused
    for (int i = 0; i < 50; i++) { r.now += 10; HalOut o = r.step(r.bench()); TEST_ASSERT_FALSE(o.driver_enable); TEST_ASSERT_EQUAL_FLOAT(0.0f, o.duty_pct); TEST_ASSERT_FALSE(o.relay_on); }
    OtaProgress p = {OtaState::DOWNLOADING, "", 4096, 200000};
    r.dev.ota_progress(p);
    std::string s = drain(r.dev);
    TEST_ASSERT_TRUE(s.find("\"st\":\"DOWNLOADING\",\"rel\":\"0123456789ab\",\"ver\":\"3.1.0\",\"b\":4096,\"n\":200000") != std::string::npos);
    OtaProgress f = {OtaState::FAILED, "CHECKSUM_MISMATCH", 4096, 200000};
    r.dev.ota_progress(f); drain(r.dev);
    TEST_ASSERT_FALSE(r.dev.ota_active());                                   // a failure ends the update
    TEST_ASSERT_TRUE(r.cmd("START", 20).find("OTA_IN_PROGRESS") == std::string::npos);      // motion is back to the ordinary interlocks' decision (never permitted by OTA)
}

void test_an_unconfirmed_image_refuses_another_update_until_confirmed() {
    uint8_t k[32]; OtaRig r(k); r.dev.set_ota_boot("ota_1", 3342336, true, "", "3.1.0");
    TEST_ASSERT_TRUE(r.login()); r.step(r.bench()); drain(r.dev);
    TEST_ASSERT_TRUE(refused(r.ota("3.2.0"), "PENDING_VERIFY"));
    TEST_ASSERT_TRUE(r.cmd("START", 20).find("OTA_PENDING_VERIFY") != std::string::npos);      // an unconfirmed image never drives
    TEST_ASSERT_TRUE(r.cmd("STOP", 0).find("ACCEPTED") != std::string::npos);
    r.dev.ota_boot_result(OtaState::CONFIRMED, "");
    std::string s = drain(r.dev);
    TEST_ASSERT_TRUE(s.find("\"st\":\"CONFIRMED\"") != std::string::npos && s.find("\"ver\":\"3.0.1\"") != std::string::npos);   // the running firmware's own version
    r.now += 10; r.step(r.bench()); drain(r.dev);
    TEST_ASSERT_TRUE(r.ota("3.2.0").find("AUTHORIZED") != std::string::npos);
}

void test_ota_info_reports_capability_partition_and_the_current_blocker() {
    uint8_t k[32]; OtaRig r(k); r.dev.set_ota_boot("ota_0", 3342336, false, "ROLLED_BACK", "3.1.0");
    r.now = 2000; r.step(r.bench(0, true, false, 24.0f));
    std::string s = drain(r.dev);
    TEST_ASSERT_TRUE(s.find("\"t\":\"ota_info\",\"seq\":") != std::string::npos && s.find(",\"ts\":2000,\"cap\":1,") != std::string::npos);    // the shared frame counter and the device clock
    TEST_ASSERT_TRUE(s.find("\"cap\":1,\"why\":\"\",\"run\":\"ota_0\",\"psz\":3342336,\"pend\":0,\"last\":\"ROLLED_BACK\",\"lver\":\"3.1.0\",\"blk\":\"MOTOR_POWER_CONNECTED\",\"busy\":0}") != std::string::npos);
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_ota_request_parses_strictly_and_canonicalises);
    RUN_TEST(test_versions_compare_semantically_and_reject_garbage);
    RUN_TEST(test_image_header_requires_the_esp_magic_and_the_esp32s3_chip_id);
    RUN_TEST(test_a_valid_signed_update_is_written_hashed_selected_recorded_and_restarted);
    RUN_TEST(test_wifi_unavailable_fails_before_anything_is_written);
    RUN_TEST(test_server_unavailable_for_the_manifest_or_the_image_fails);
    RUN_TEST(test_an_interrupted_download_aborts_the_partition);
    RUN_TEST(test_a_short_stream_with_a_clean_end_is_still_interrupted);
    RUN_TEST(test_an_invalid_image_or_a_wrong_chip_is_refused_from_its_header);
    RUN_TEST(test_a_bad_signature_is_refused_before_download);
    RUN_TEST(test_a_checksum_mismatch_aborts_and_never_selects_the_image);
    RUN_TEST(test_incompatible_releases_are_refused);
    RUN_TEST(test_flash_failures_abort_and_keep_the_running_image);
    RUN_TEST(test_the_new_image_is_confirmed_only_when_every_self_test_passes);
    RUN_TEST(test_boot_outcome_distinguishes_self_test_confirmed_and_rolled_back);
    RUN_TEST(test_an_update_request_needs_the_authenticated_session);
    RUN_TEST(test_a_device_without_ota_support_refuses_every_request);
    RUN_TEST(test_eligibility_never_takes_an_unavailable_reading_as_safe);
    RUN_TEST(test_an_authorised_update_refuses_motion_keeps_stop_and_outputs_off_until_it_ends);
    RUN_TEST(test_an_unconfirmed_image_refuses_another_update_until_confirmed);
    RUN_TEST(test_ota_info_reports_capability_partition_and_the_current_blocker);
    return UNITY_END();
}
