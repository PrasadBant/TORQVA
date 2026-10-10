// ADXL345 register-level helpers: constants and decoding only (no I2C here), so the decoding is host-testable. The I2C transactions live in src/main.cpp.
// The firmware reports RAW acceleration per axis and the magnitude of the total acceleration vector. The magnitude INCLUDES GRAVITY (about 1 g at rest): it is NOT vibration RMS
// and is never labelled as such.
#pragma once
#include <stdint.h>

namespace torqva {

static const uint8_t ADXL345_I2C_ADDR = 0x53;          // SDO low (the usual breakout default); 0x1D if SDO is high: a wiring fact to confirm
static const uint8_t ADXL345_REG_DEVID = 0x00;
static const uint8_t ADXL345_DEVID = 0xE5;
static const uint8_t ADXL345_REG_POWER_CTL = 0x2D;
static const uint8_t ADXL345_REG_DATA_FORMAT = 0x31;
static const uint8_t ADXL345_REG_DATAX0 = 0x32;
static const uint8_t ADXL345_POWER_MEASURE = 0x08;
static const uint8_t ADXL345_FORMAT_FULL_RES_16G = 0x0B;   // FULL_RES, range +-16 g: 3.9 mg per LSB
static const float ADXL345_G_PER_LSB = 0.0039f;
static const float ADXL345_MAX_ABS_G = 16.5f;              // beyond the configured range a reading is implausible

struct AccelSample {
    float x_g, y_g, z_g;
    float mag_g;        // sqrt(x^2 + y^2 + z^2), gravity included
    bool valid;
};

bool adxl345_devid_ok(uint8_t id);
// raw = the six bytes read from DATAX0 (little-endian int16 per axis). valid=false (and zeroed numbers that MUST NOT be shown) if the data is not plausible.
AccelSample adxl345_decode(const uint8_t raw[6]);

}  // namespace torqva
