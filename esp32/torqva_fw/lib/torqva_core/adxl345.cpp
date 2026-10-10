#include "adxl345.h"
#include <math.h>

namespace torqva {

bool adxl345_devid_ok(uint8_t id) { return id == ADXL345_DEVID; }

AccelSample adxl345_decode(const uint8_t raw[6]) {
    AccelSample s = {0, 0, 0, 0, false};
    const int16_t x = (int16_t)((uint16_t)raw[0] | ((uint16_t)raw[1] << 8));
    const int16_t y = (int16_t)((uint16_t)raw[2] | ((uint16_t)raw[3] << 8));
    const int16_t z = (int16_t)((uint16_t)raw[4] | ((uint16_t)raw[5] << 8));
    const float gx = x * ADXL345_G_PER_LSB, gy = y * ADXL345_G_PER_LSB, gz = z * ADXL345_G_PER_LSB;
    if (fabsf(gx) > ADXL345_MAX_ABS_G || fabsf(gy) > ADXL345_MAX_ABS_G || fabsf(gz) > ADXL345_MAX_ABS_G) return s;
    s.x_g = gx; s.y_g = gy; s.z_g = gz;
    s.mag_g = sqrtf(gx * gx + gy * gy + gz * gz);
    s.valid = true;
    return s;
}

}  // namespace torqva
