// Abstract emergency-stop INPUT interpretation. Pure logic, host-testable. It does NOT choose a pin or a polarity and it is NOT an emergency stop:
// an independent physical mechanism that inhibits drive without the ESP32 is still required (docs/TORQVA_HARDWARE_READINESS.md). This only defines how the firmware
// must READ whatever input the approved hardware design provides: anything unknown, unreadable or recently asserted blocks operation.
#pragma once
#include <stdint.h>

namespace torqva {

enum class EstopState : uint8_t { UNKNOWN = 0, ASSERTED = 1, RELEASED = 2 };

struct EstopConfig {
    bool configured;               // false until the hardware design is approved and the values below are supplied
    bool active_low;               // electrical polarity of the ASSERTED level (supplied by the design; no default is assumed)
    uint32_t release_debounce_ms;  // the input must read released continuously this long before RELEASED (must be > 0)
};

class EstopInput {
public:
    explicit EstopInput(const EstopConfig& c) : cfg_(c), state_(EstopState::UNKNOWN), released_since_(0), counting_(false) {}
    // sample_valid=false means the pin could not be read / the circuit reports a fault: treated as ASSERTED. Assertion is immediate; release needs the debounce.
    EstopState update(uint32_t now_ms, bool sample_valid, bool level_high);
    EstopState state() const { return state_; }
    bool blocks_operation() const { return state_ != EstopState::RELEASED; }   // UNKNOWN blocks, like ASSERTED
private:
    EstopConfig cfg_;
    EstopState state_;
    uint32_t released_since_;
    bool counting_;
};

}  // namespace torqva
