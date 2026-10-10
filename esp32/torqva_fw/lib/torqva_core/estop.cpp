#include "estop.h"

namespace torqva {

EstopState EstopInput::update(uint32_t now_ms, bool sample_valid, bool level_high) {
    if (!cfg_.configured || cfg_.release_debounce_ms == 0) { state_ = EstopState::UNKNOWN; counting_ = false; return state_; }
    const bool asserted = !sample_valid || (cfg_.active_low ? !level_high : level_high);
    if (asserted) { state_ = EstopState::ASSERTED; counting_ = false; return state_; }
    if (!counting_) { counting_ = true; released_since_ = now_ms; }
    if (state_ != EstopState::RELEASED && (uint32_t)(now_ms - released_since_) >= cfg_.release_debounce_ms) state_ = EstopState::RELEASED;   // wrap-safe
    // until the debounce has elapsed the state stays UNKNOWN (initial) or ASSERTED (after an assertion): never RELEASED early
    return state_;
}

}  // namespace torqva
