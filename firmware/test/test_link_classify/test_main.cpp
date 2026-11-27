// Wi-Fi link queue classification (lib/torqva_core/communication/link_classify.h). Every line with a real sequence number must stay in ONE ordered queue:
// the backend reads a backwards seq as a device restart and ends the authenticated session. Real encoder output is classified, not hand-written strings.
#include <unity.h>
#include <stdio.h>
#include "communication/link_classify.h"
#include "communication/protocol.h"

using namespace torqva;

void setUp() {}
void tearDown() {}

static void test_real_telemetry_and_status_lines_are_ordered() {
    char b[400];
    FastFrame f = {};
    f.seq = 41; f.ts_ms = 1000;
    TEST_ASSERT_TRUE(encode_fast(b, sizeof(b), f) > 0);
    TEST_ASSERT_TRUE(link_classify(b) == LinkClass::ORDERED_TELEMETRY);
    SlowFrame s = {};
    s.seq = 42;
    TEST_ASSERT_TRUE(encode_slow(b, sizeof(b), s) > 0);
    TEST_ASSERT_TRUE(link_classify(b) == LinkClass::ORDERED_TELEMETRY);
    // status carries the same seq counter: it must NOT overtake queued telemetry
    TEST_ASSERT_TRUE(link_classify("{\"t\":\"status\",\"seq\":43,\"ts\":5,\"fw\":\"1.2.0\"}") == LinkClass::ORDERED_OTHER);
    TEST_ASSERT_TRUE(link_classify("{\"t\":\"ota\",\"seq\":44,\"ts\":5,\"id\":1}") == LinkClass::ORDERED_OTHER);
    TEST_ASSERT_TRUE(link_classify("{\"t\":\"wifi_state\",\"seq\":10,\"ts\":5}") == LinkClass::ORDERED_OTHER);
    TEST_ASSERT_TRUE(link_classify("{\"t\":\"ota_info\",\"seq\":100,\"ts\":5}") == LinkClass::ORDERED_OTHER);
}

static void test_lines_outside_the_sequence_are_priority() {
    char b[200];
    const Ack a = {7, AckStatus::ACCEPTED, ""};
    TEST_ASSERT_TRUE(encode_ack(b, sizeof(b), a, "RIG-1", "0123456789abcdef") > 0);
    TEST_ASSERT_TRUE(link_classify(b) == LinkClass::PRIORITY);
    TEST_ASSERT_TRUE(link_classify("{\"t\":\"auth_ch\",\"dn\":\"00\",\"proof\":\"11\"}") == LinkClass::PRIORITY);
    TEST_ASSERT_TRUE(link_classify("{\"t\":\"log\",\"seq\":0,\"ts\":5,\"lvl\":\"INFO\",\"msg\":\"x\"}") == LinkClass::PRIORITY);
    TEST_ASSERT_TRUE(link_classify("{\"t\":\"net_info\",\"seq\":0,\"ts\":5}") == LinkClass::PRIORITY);
    TEST_ASSERT_TRUE(link_classify("{\"t\":\"link_diag\",\"seq\":0,\"ts\":5}") == LinkClass::PRIORITY);
    TEST_ASSERT_TRUE(link_classify(nullptr) == LinkClass::PRIORITY);
}

static void test_seq_zero_prefix_is_not_mistaken_and_message_text_cannot_match() {
    TEST_ASSERT_TRUE(link_classify("{\"t\":\"status\",\"seq\":0123,\"ts\":5}") == LinkClass::ORDERED_OTHER);   // "0" followed by a digit is not seq 0
    TEST_ASSERT_TRUE(link_classify("{\"t\":\"ack\",\"id\":1,\"status\":\"REJECTED\",\"reason\":\"padding padding padding \\\"seq\\\":5\"}") == LinkClass::PRIORITY);
}

static void test_only_fast_slow_accel_are_droppable_telemetry() {
    TEST_ASSERT_TRUE(link_is_telemetry("{\"t\":\"accel\",\"seq\":1,\"ts\":1,\"ok\":0}"));
    TEST_ASSERT_FALSE(link_is_telemetry("{\"t\":\"status\",\"seq\":1}"));
    TEST_ASSERT_FALSE(link_is_telemetry(nullptr));
}

int main(int, char**) {
    UNITY_BEGIN();
    RUN_TEST(test_real_telemetry_and_status_lines_are_ordered);
    RUN_TEST(test_lines_outside_the_sequence_are_priority);
    RUN_TEST(test_seq_zero_prefix_is_not_mistaken_and_message_text_cannot_match);
    RUN_TEST(test_only_fast_slow_accel_are_droppable_telemetry);
    return UNITY_END();
}
