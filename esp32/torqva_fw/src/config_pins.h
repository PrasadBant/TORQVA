// Hardware constants for the TORQVA firmware. GPIO assignments live ONLY in lib/torqva_core/pinmap.h (namespace torqva_pins): this file defines no pin.
// The map comes from the operator's legacy sketch (retired from the tree) as the INTENDED wiring and is NOT verified against the physical build: the wiring id reported in every status frame stays
// "UNVERIFIED" until a human confirms the real wiring.
#pragma once
#include "pinmap.h"

#define TORQVA_WIRING_ID   "W1-LEGACYMAP-UNVERIFIED"
#define TORQVA_FW_VERSION  "3.0.1-dev"

// Sensor scaling. INA219 library calibrates for a 0.1 ohm shunt; after the shunt swap set this to 0.05.
#ifndef TORQVA_SHUNT_OHM
#define TORQVA_SHUNT_OHM 0.1f
#endif

#define PWM_FREQ_HZ     20000
#define PWM_RES_BITS    10
#define HALL_MIN_PERIOD_US 12000  // ignore electrical noise faster than 5 000 rpm (motor max is 3 000 rpm)
