// Speed control: slew-rate limiter, PI controller with anti-windup, drive controller.
// Pure logic. Stopping = driver disabled and coast (never active braking: INA219 26 V limit).
#pragma once
#include <stdint.h>
#include "safety/torqva_limits.h"

namespace torqva {

class RampLimiter {
public:
    explicit RampLimiter(float rate_per_s) : up_(rate_per_s), down_(rate_per_s), value_(0.0f) {}
    void reset(float v = 0.0f) { value_ = v; }
    float step(float target, float dt_s);
    float value() const { return value_; }
    void set_rates(float up, float down) { up_ = up; down_ = down; }
    void set_rate(float r) { set_rates(r, r); }
    float up_rate() const { return up_; }
    float down_rate() const { return down_; }
private:
    float up_, down_, value_;
};

class PIController {
public:
    PIController(float kp, float ki, float out_min, float out_max)
        : kp_(kp), ki_(ki), min_(out_min), max_(out_max), integ_(0.0f) {}
    void reset() { integ_ = 0.0f; }
    // Conditional integration anti-windup: integrator frozen while saturated in the error direction.
    float step(float setpoint, float measured, float dt_s);
    float integrator() const { return integ_; }
private:
    float kp_, ki_, min_, max_, integ_;
};

enum class DriveMode : uint8_t { IDLE = 0, OPEN_LOOP = 1, CLOSED_LOOP = 2 };

struct DriveOutput {
    float duty_pct;       // applied duty after ramp and cap
    bool driver_enable;   // false -> EN low, coast
};

class DriveController {
public:
    DriveController(const Limits& l, float kp, float ki);
    void set_limits(const Limits& l);
    void stop();                              // go IDLE, driver disabled, coast
    void start_open_loop(float duty_pct);     // commissioning: duty is capped to limits
    bool set_speed(float rpm);                // false if not commissioned / out of range
    // dt_s: loop period. drive_allowed comes from SafetyMonitor and overrides everything.
    DriveOutput update(float dt_s, float measured_rpm, bool drive_allowed);
    DriveMode mode() const { return mode_; }
    float target_rpm() const { return target_rpm_; }
    void set_ramp(float up, float down) { ramp_.set_rates(up, down); }
    float ramp_up() const { return ramp_.up_rate(); }
    float ramp_down() const { return ramp_.down_rate(); }
    float target_duty() const { return target_duty_; }
    float duty() const { return ramp_.value(); }

private:
    Limits lim_;
    RampLimiter ramp_;
    PIController pi_;
    float kp_, ki_;
    DriveMode mode_;
    float target_duty_, target_rpm_;
};

}  // namespace torqva
