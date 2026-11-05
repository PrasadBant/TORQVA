// Firmware 1.1.2 regression: USB serial output must never wait on the USB host (docs/TORQVA_OTA_LED_BENCH_TEST.md section 11).
// Host tests of lib/torqva_core/line_out.h against a fake port that models the ESP32-S3 USB-Serial/JTAG TX buffer, plus a static guard that no
// firmware source writes to Serial except src/usb_out.cpp.
#include <unity.h>
#include <stdio.h>
#include <string.h>
#include <string>
#include <vector>
#include "line_out.h"

using namespace torqva;

// A TX ring buffer of `cap` bytes that only the "host" empties (drain()). A host that never reads = room only ever shrinks.
struct FakePort {
    size_t cap, used = 0;
    int avail_calls = 0, write_calls = 0;
    bool short_write = false, negative_room = false;
    std::string wire;                                   // everything accepted, in order
    explicit FakePort(size_t c) : cap(c) {}
    int availableForWrite() { avail_calls++; return negative_room ? -1 : (int)(cap - used); }
    size_t write(const uint8_t* b, size_t n) {
        write_calls++;
        size_t take = n <= cap - used ? n : cap - used;  // a real port would block here for the rest; the code under test must never get here
        if (short_write && take > 0) take--;
        wire.append(reinterpret_cast<const char*>(b), take);
        used += take;
        return take;
    }
    void drain() { used = 0; }
};

static LineOutStats fresh() { LineOutStats s = {0, 0}; return s; }

static std::string status_line(int seq) {           // a realistic ~300-byte status frame (longer than the core's default 256-byte TX buffer)
    char b[320];
    snprintf(b, sizeof(b), "{\"t\":\"status\",\"seq\":%d,\"ts\":822004,\"fw\":\"1.1.2\",\"wiring\":\"W1-LEGACYMAP-UNVERIFIED\",\"limits_v\":1,\"state\":\"OK\","
             "\"reason\":\"NONE\",\"mode\":\"HW\",\"drive\":\"IDLE\",\"ctl\":0,\"hb_age\":4294967295,\"test\":0,\"proto\":1,\"dev\":\"RIG-1\","
             "\"blk\":\"ESTOP_INPUT_NOT_VERIFIED\",\"fm\":0,\"cfg\":1,\"es\":1}", seq);
    return b;
}

void setUp() {}
void tearDown() {}

void test_a_line_that_fits_is_written_whole_with_crlf_in_one_write() {
    FakePort p(4096); LineOutStats s = fresh();
    TEST_ASSERT_TRUE(write_line_nonblocking(p, "{\"t\":\"fast\",\"seq\":1}", s));
    TEST_ASSERT_EQUAL_STRING("{\"t\":\"fast\",\"seq\":1}\r\n", p.wire.c_str());
    TEST_ASSERT_EQUAL(1, p.write_calls);
    TEST_ASSERT_EQUAL_UINT32(1, s.written); TEST_ASSERT_EQUAL_UINT32(0, s.dropped);
}

void test_no_room_drops_the_line_without_writing_anything() {
    FakePort p(64); p.used = 64; LineOutStats s = fresh();
    TEST_ASSERT_FALSE(write_line_nonblocking(p, "{\"t\":\"fast\",\"seq\":1}", s));
    TEST_ASSERT_EQUAL(0, p.write_calls);                // never calls into the (blocking) port write
    TEST_ASSERT_EQUAL_UINT32(1, s.dropped);
}

void test_room_one_byte_short_drops_rather_than_writing_a_partial_line() {
    const std::string l = status_line(7);
    FakePort p(4096); p.used = 4096 - (l.size() + 1); LineOutStats s = fresh();   // room for the line and '\r' but not '\n'
    TEST_ASSERT_FALSE(write_line_nonblocking(p, l.c_str(), s));
    TEST_ASSERT_EQUAL(0, p.write_calls);
    TEST_ASSERT_TRUE(p.wire.empty());
}

void test_test_B_host_never_reads_every_later_line_is_dropped_immediately() {
    // USB plugged in, COM port not open: the buffer fills once, then every line is dropped at once - the caller (loop()) is never held.
    FakePort p(4096); LineOutStats s = fresh();
    int accepted = 0;
    for (int i = 0; i < 2000; i++) if (write_line_nonblocking(p, status_line(i).c_str(), s)) accepted++;
    TEST_ASSERT_TRUE(accepted > 0 && accepted < 20);    // ~4096 / ~300 B
    TEST_ASSERT_EQUAL_UINT32((uint32_t)(2000 - accepted), s.dropped);
    TEST_ASSERT_EQUAL(accepted, p.write_calls);         // no write was attempted for a dropped line
    // every accepted line is complete
    size_t pos = 0; int lines = 0;
    while ((pos = p.wire.find("\r\n", pos)) != std::string::npos) { pos += 2; lines++; }
    TEST_ASSERT_EQUAL(accepted, lines);
    TEST_ASSERT_EQUAL('\n', p.wire[p.wire.size() - 1]);
}

void test_test_D_E_reader_opens_and_closes_repeatedly_output_resumes_and_never_tears_a_line() {
    FakePort p(4096); LineOutStats s = fresh();
    int seq = 0;
    for (int cycle = 0; cycle < 50; cycle++) {
        for (int i = 0; i < 40; i++) write_line_nonblocking(p, status_line(seq++).c_str(), s);   // reader closed: fills, then drops
        p.drain();                                                                                // reader opens: host empties the buffer
        TEST_ASSERT_TRUE(write_line_nonblocking(p, status_line(seq++).c_str(), s));               // ...and the next line goes straight out
    }
    TEST_ASSERT_EQUAL_UINT32((uint32_t)seq, s.written + s.dropped);
    size_t pos = 0, start = 0; int bad = 0;
    while ((pos = p.wire.find("\r\n", start)) != std::string::npos) {
        const std::string one = p.wire.substr(start, pos - start);
        if (one.compare(0, 14, "{\"t\":\"status\",") != 0 || one[one.size() - 1] != '}') bad++;
        start = pos + 2;
    }
    TEST_ASSERT_EQUAL(0, bad);
    TEST_ASSERT_EQUAL(p.wire.size(), start);            // nothing after the last CRLF: no torn line
}

void test_an_over_long_line_is_dropped_not_truncated() {
    std::string big(kLineOutMax, 'x');
    FakePort p(4096); LineOutStats s = fresh();
    TEST_ASSERT_FALSE(write_line_nonblocking(p, big.c_str(), s));
    TEST_ASSERT_EQUAL(0, p.write_calls);
    std::string max(kLineOutMax - 1, 'y');               // the longest line main.cpp can pop (char out[320])
    TEST_ASSERT_TRUE(write_line_nonblocking(p, max.c_str(), s));
    TEST_ASSERT_EQUAL(kLineOutMax + 1, p.wire.size());
}

void test_a_short_write_and_a_negative_room_count_as_dropped() {
    FakePort p(4096); p.short_write = true; LineOutStats s = fresh();
    TEST_ASSERT_FALSE(write_line_nonblocking(p, "abc", s));
    TEST_ASSERT_EQUAL_UINT32(1, s.dropped);
    FakePort q(4096); q.negative_room = true; LineOutStats t = fresh();
    TEST_ASSERT_FALSE(write_line_nonblocking(q, "abc", t));
    TEST_ASSERT_EQUAL(0, q.write_calls);
    TEST_ASSERT_FALSE(write_line_nonblocking(q, nullptr, t));
    TEST_ASSERT_EQUAL_UINT32(2, t.dropped);
}

void test_the_buffer_variant_writes_exactly_the_given_bytes_or_nothing() {
    FakePort p(8); LineOutStats s = fresh();
    const uint8_t b[] = {'E', ' ', 'x', '\r', '\n'};
    TEST_ASSERT_TRUE(write_buffer_nonblocking(p, b, sizeof(b), s));
    TEST_ASSERT_FALSE(write_buffer_nonblocking(p, b, sizeof(b), s));   // 3 bytes of room left: nothing written
    TEST_ASSERT_EQUAL(1, p.write_calls);
    TEST_ASSERT_EQUAL(5, (int)p.wire.size());
}

// ---- static guard: the only Serial writer in the firmware is src/usb_out.cpp (reads in main.cpp are fine: HWCDC::read never waits)
static bool read_file(const char* path, std::string* out) {
    FILE* f = fopen(path, "rb");
    if (!f) return false;
    char b[4096]; size_t n;
    while ((n = fread(b, 1, sizeof(b), f)) > 0) out->append(b, n);
    fclose(f);
    return true;
}

// `w` used as an identifier of its own (not the tail of a longer one: "printf(" must not match "snprintf(").
static bool uses(const std::string& code, const char* w) {
    for (size_t at = code.find(w); at != std::string::npos; at = code.find(w, at + 1)) {
        const char before = at ? code[at - 1] : ' ';
        const bool ident = (before >= 'a' && before <= 'z') || (before >= 'A' && before <= 'Z') || (before >= '0' && before <= '9') || before == '_';
        if (!ident) return true;
    }
    return false;
}

void test_no_firmware_source_writes_to_serial_except_usb_out() {
    const char* files[] = {"src/main.cpp", "src/ota_esp32.cpp", "src/wifi_link.cpp", "lib/torqva_core/device.cpp", "lib/torqva_core/ota.cpp",
                           "lib/torqva_core/control.cpp", "lib/torqva_core/safety.cpp", "lib/torqva_core/protocol.cpp", "lib/torqva_core/auth.cpp",
                           "lib/torqva_core/commands.cpp", "lib/torqva_core/interlock.cpp", "lib/torqva_core/estop.cpp", "lib/torqva_core/testexec.cpp",
                           "lib/torqva_core/runtime_config.cpp", "lib/torqva_core/adxl345.cpp", "lib/torqva_core/sha256.cpp", "lib/torqva_core/simplant.cpp"};
    const char* writers[] = {"Serial.print", "Serial.write", "Serial.flush", "Serial.begin", "Serial.setTx", "printf(", "puts(", "putchar(",
                             "ESP_LOG", "ESP_EARLY_LOG", "log_e(", "log_w(", "log_i(", "log_d(", "log_v(", "log_printf("};
    for (const char* f : files) {
        std::string src;
        char msg[96]; snprintf(msg, sizeof(msg), "cannot read %s (run the tests from esp32/torqva_fw)", f);
        TEST_ASSERT_TRUE_MESSAGE(read_file(f, &src), msg);
        // comments may mention these names; only code counts
        std::string code; bool in_line = false, in_block = false, in_str = false;
        for (size_t i = 0; i < src.size(); i++) {
            const char c = src[i], d = i + 1 < src.size() ? src[i + 1] : 0;
            if (in_line) { if (c == '\n') { in_line = false; code += c; } continue; }
            if (in_block) { if (c == '*' && d == '/') { in_block = false; i++; } continue; }
            if (in_str) { if (c == '\\') { i++; continue; } if (c == '"') in_str = false; continue; }
            if (c == '/' && d == '/') { in_line = true; continue; }
            if (c == '/' && d == '*') { in_block = true; i++; continue; }
            if (c == '"') { in_str = true; continue; }
            code += c;
        }
        for (const char* w : writers) {
            if (uses(code, w)) {
                char m[160]; snprintf(m, sizeof(m), "%s contains %s: route USB output through usb_out_line() (never waits on the host)", f, w);
                TEST_FAIL_MESSAGE(m);
            }
        }
    }
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_a_line_that_fits_is_written_whole_with_crlf_in_one_write);
    RUN_TEST(test_no_room_drops_the_line_without_writing_anything);
    RUN_TEST(test_room_one_byte_short_drops_rather_than_writing_a_partial_line);
    RUN_TEST(test_test_B_host_never_reads_every_later_line_is_dropped_immediately);
    RUN_TEST(test_test_D_E_reader_opens_and_closes_repeatedly_output_resumes_and_never_tears_a_line);
    RUN_TEST(test_an_over_long_line_is_dropped_not_truncated);
    RUN_TEST(test_a_short_write_and_a_negative_room_count_as_dropped);
    RUN_TEST(test_the_buffer_variant_writes_exactly_the_given_bytes_or_nothing);
    RUN_TEST(test_no_firmware_source_writes_to_serial_except_usb_out);
    return UNITY_END();
}
