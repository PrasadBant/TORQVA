#include "shared/device.h"

#include <string.h>

namespace torqva {

static const uint32_t kFastPeriodMs = 100;
static const uint32_t kSlowPeriodMs = 1000;
static const uint32_t kAccelPeriodMs = 200;
static const uint32_t kStatusPeriodMs = 1000;

void Device::emit_frames(const HalIn& in) {
    char b[kLine];
    uint8_t q = 0;
    if (in.current_valid) q |= Q_CURRENT;
    if (in.voltage_valid) q |= Q_VOLTAGE;
    if (in.housing_valid) q |= Q_HOUSING;
    if (in.ambient_valid) q |= Q_AMBIENT;
    // A Hall input without valid pulse timing cannot distinguish rest from a disconnected sensor.
    if (in.rpm_valid && (strcmp(cfg_.mode, "HW") != 0 || (in.pulse_recent && in.rpm > 0.0f))) q |= Q_RPM;
    if (in.vib_valid) q |= Q_VIB;

    const bool changed = safety_.state() != last_state_ || safety_.reason() != last_reason_;
    if (stepped_ && ((uint32_t)(in.now_ms - last_fast_ms_) >= kFastPeriodMs || seq_ == 0)) {
        last_fast_ms_ = in.now_ms;
        FastFrame f = {seq_++, in.now_ms, in.rpm, drive_.target_rpm(), last_out_.duty_pct,
                       in.voltage_v, in.current_a, in.voltage_v * in.current_a, q, drive_.target_duty(), drive_.ramp_up(), drive_.ramp_down(), stop_reason_};
        queue_line(b, encode_fast(b, sizeof(b), f));
    }
    if (cfg_.accel_supported && (uint32_t)(in.now_ms - last_accel_ms_) >= kAccelPeriodMs) {
        last_accel_ms_ = in.now_ms;
        const bool ok = in.acc_valid && finite_f(in.acc_x_g) && finite_f(in.acc_y_g) && finite_f(in.acc_z_g) && finite_f(in.acc_mag_g);
        AccelFrame f = {seq_++, in.now_ms, ok, ok ? in.acc_x_g : 0.0f, ok ? in.acc_y_g : 0.0f, ok ? in.acc_z_g : 0.0f, ok ? in.acc_mag_g : 0.0f};
        queue_line(b, encode_accel(b, sizeof(b), f));
    }
    if ((uint32_t)(in.now_ms - last_slow_ms_) >= kSlowPeriodMs) {
        last_slow_ms_ = in.now_ms;
        SlowFrame f = {seq_++, in.now_ms, in.housing_c, in.ambient_c, q};
        queue_line(b, encode_slow(b, sizeof(b), f));
    }
    if (changed || (uint32_t)(in.now_ms - last_status_ms_) >= kStatusPeriodMs) {
        last_status_ms_ = in.now_ms;
        last_state_ = safety_.state(); last_reason_ = safety_.reason();
        const DriveMode m = drive_.mode();
        const SafetyState st_out = cfg_.direct_mode ? SafetyState::OK : safety_.state();
        const TripReason rsn_out = cfg_.direct_mode ? TripReason::NONE : safety_.reason();
        const char* blk_out = (cfg_.relaxed_interlocks || cfg_.direct_mode) ? "" : (start_blocked_reason(in.now_ms) ? start_blocked_reason(in.now_ms) : "");
        StatusFrame f = {seq_++, in.now_ms, cfg_.fw_version, cfg_.wiring_id, lim_.version,
                         st_out, rsn_out, cfg_.mode,
                         m == DriveMode::IDLE ? "IDLE" : (m == DriveMode::OPEN_LOOP ? "OPEN_LOOP" : "CLOSED_LOOP"),
                         cfg_.control_enabled, hb_seen_ ? ((int32_t)(in.now_ms - last_hb_ms_) > 0 ? (uint32_t)(in.now_ms - last_hb_ms_) : 0u) : 0xFFFFFFFFu,
                         tests_.active() ? (uint8_t)tests_.id() : (uint8_t)0,
                         cfg_.device_id, blk_out, cfg_.direct_mode ? 0u : safety_.fault_mask(),
                         cfg_version(), cfg_.direct_mode ? (uint8_t)0 : last_in_.estop_state};
        queue_line(b, encode_status(b, sizeof(b), f));
    }
    if (cfg_.wifi_stage_supported && (uint32_t)(in.now_ms - last_wifi_state_ms_) >= 2000) {
        last_wifi_state_ms_ = in.now_ms;
        const size_t w = encode_wifi_state(b, sizeof(b), seq_++, in.now_ms, true, wifi_trial_, wifi_left_s_, wifi_act_);
        if (w) queue_line(b, w);
    }
    if ((uint32_t)(in.now_ms - last_ota_info_ms_) >= kStatusPeriodMs) {
        last_ota_info_ms_ = in.now_ms;
        const char* blk = ota_block_reason(in.now_ms);
        OtaInfo oi = {cfg_.ota_capable, cfg_.ota_capable ? "" : (cfg_.ota_why ? cfg_.ota_why : "OTA_NOT_CONFIGURED"), ota_running_, ota_psz_, ota_pending_verify_,
                      ota_last_, ota_last_ver_, blk ? blk : "", ota_active_, cfg_.ota_led_bench ? "ota_led_bench" : ""};
        queue_line(b, encode_ota_info(b, sizeof(b), oi, seq_++, in.now_ms));
    }
}

}  // namespace torqva
