# Control configuration

The default RPM and duty envelope is seeded from [device_config.json](../defaults/device_config.json). The authenticated device must accept the active operating limits before motion. Acceleration and deceleration are runtime PWM ramp requests bounded by the firmware's ramp cap in [torqva_limits.h](../../firmware/lib/torqva_core/safety/torqva_limits.h).
