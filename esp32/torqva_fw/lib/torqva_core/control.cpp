#include "control.h"

namespace torqva {

static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

float RampLimiter::step(float target, float dt_s) {
    const float maxd = rate_ * dt_s;
    const float d = target - value_;
    if (d > maxd) value_ += maxd;
    else if (d < -maxd) value_ -= maxd;
    else value_ = target;
    return value_;
}

float PIController::step(float setpoint, float measured, float dt_s) {
    const float err = setpoint - measured;
    const float unsat = kp_ * err + integ_;
    const bool sat_hi = unsat >= max_ && err > 0.0f;
    const bool sat_lo = unsat <= min_ && err < 0.0f;
    if (!sat_hi && !sat_lo) integ_ += ki_ * err * dt_s;
    return clampf(kp_ * err + integ_, min_, max_);
}

DriveController::DriveController(const Limits& l, float kp, float ki)
    : lim_(l), ramp_(l.ramp_pct_per_s), pi_(kp, ki, -15.0f, l.max_duty_pct),
      kp_(kp), ki_(ki), mode_(DriveMode::IDLE), target_duty_(0.0f), target_rpm_(0.0f) {}

void DriveController::set_limits(const Limits& l) {
    lim_ = l;
    ramp_.set_rate(l.ramp_pct_per_s);
    pi_ = PIController(kp_, ki_, -15.0f, l.max_duty_pct);
}

void DriveController::stop() {
    mode_ = DriveMode::IDLE;
    target_duty_ = 0.0f;
    target_rpm_ = 0.0f;
    pi_.reset();
    ramp_.reset(0.0f);   // driver is disabled and the motor coasts; no active braking
}

void DriveController::start_open_loop(float duty_pct) {
    mode_ = DriveMode::OPEN_LOOP;
    float d = clampf(duty_pct, 0.0f, lim_.max_duty_pct);
    if (d > 0.0f && d < 10.0f) d = 10.0f;              // minimum breakaway duty floor so motor reliably starts
    target_duty_ = d;
    target_rpm_ = 0.0f;
}

bool DriveController::set_speed(float rpm) {
    if (lim_.max_rpm <= 0.0f) return false;          // not commissioned
    if (rpm < 0.0f || rpm > lim_.max_rpm) return false;
    if (rpm == 0.0f) { stop(); return true; }
    if (mode_ != DriveMode::CLOSED_LOOP) {
        pi_.reset();
    }
    mode_ = DriveMode::CLOSED_LOOP;
    target_rpm_ = rpm;
    return true;
}

DriveOutput DriveController::update(float dt_s, float measured_rpm, bool drive_allowed) {
    DriveOutput out;
    if (!drive_allowed) {                 // safety override: immediate, no ramp
        stop();
        ramp_.reset(0.0f);
        out.duty_pct = 0.0f;
        out.driver_enable = false;
        return out;
    }
    float demand = 0.0f;
    switch (mode_) {
        case DriveMode::IDLE:        demand = 0.0f; break;
        case DriveMode::OPEN_LOOP:   demand = target_duty_; break;
        case DriveMode::CLOSED_LOOP: {
            float base = (target_rpm_ > 0.0f) ? (12.0f + (target_rpm_ / (lim_.max_rpm > 0.0f ? lim_.max_rpm : 3000.0f)) * 30.0f) : 0.0f;
            float pi_out = pi_.step(target_rpm_, measured_rpm, dt_s);
            demand = base + pi_out;
            break;
        }
    }
    demand = clampf(demand, 0.0f, lim_.max_duty_pct);
    const float duty = ramp_.step(demand, dt_s);
    out.duty_pct = duty;
    out.driver_enable = (mode_ != DriveMode::IDLE);   // IDLE = coast
    return out;
}

}  // namespace torqva
