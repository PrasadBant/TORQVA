// Firmware-in-the-loop CLI: runs the REAL torqva_core::Device against the deterministic SimPlant on the host.
// Used by backend/tests/test_torqva_conformance.py to prove the Python SimDevice behaves like the C++ firmware.
//
// stdin  : one JSON line per input.
//   protocol command lines (see protocol.h)      -> fed to Device::on_line
//   {"tick":<ms>,"button":0|1,"estop":0|1,"hall_dead":0|1}  -> advance simulated time (10 ms steps)
// stdout : every line the device emitted, then a line containing only "#".
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "device.h"
#include "simplant.h"

using namespace torqva;

static void drain(Device& d) {
    char b[256];
    while (d.pop_line(b, sizeof(b))) puts(b);
    puts("#");
    fflush(stdout);
}

int main(int argc, char** argv) {
    bool control = true, strict = false, approved = false, estop_wired = false, secured = false, wdt = true;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--no-control") == 0) control = false;
        else if (strcmp(argv[i], "--strict") == 0) strict = true;
        else if (strcmp(argv[i], "--approved") == 0) approved = true;
        else if (strcmp(argv[i], "--estop-wired") == 0) estop_wired = true;
        else if (strcmp(argv[i], "--secured") == 0) secured = true;
        else if (strcmp(argv[i], "--no-wdt") == 0) wdt = false;
    }

    Limits l = default_limits();
    l.max_rpm = 3000.0f;
    l.vib_rms_stop_g = 2.0f;
    DeviceConfig c = {};
    c.fw_version = "fitl"; c.wiring_id = "SIM"; c.mode = "SIM";
    strcpy(c.key, "sim-key");
    c.control_enabled = control; c.kp = 0.01f; c.ki = 0.03f;
    // Strict mode (--strict) exercises the real start interlocks; --approved / --estop-wired declare the two human commissioning decisions.
    c.relaxed_interlocks = !strict; c.limits_approved = approved; c.estop_input_wired = estop_wired; c.transport_secured = secured;
    Device dev(l, c);
    dev.set_watchdog_active(wdt);
    SimPlant plant;
    HalOut act = {false, 0.0f, false};
    uint32_t now = 0;

    char line[512];
    while (fgets(line, sizeof(line), stdin)) {
        size_t n = strlen(line);
        while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
        if (n == 0) continue;
        if (strstr(line, "\"tick\"")) {
            const char* p = strstr(line, "\"tick\":");
            uint32_t ms = (uint32_t)atol(p + 7);
            const char* bp = strstr(line, "\"button\":");
            bool button = bp && atoi(bp + 9) != 0;
            const char* ep = strstr(line, "\"estop\":");
            plant.faults.estop_pressed = ep && atoi(ep + 8) != 0;
            const char* hp = strstr(line, "\"hall_dead\":");
            plant.faults.hall_dead = hp && atoi(hp + 12) != 0;
            for (uint32_t t = 0; t < ms; t += 10) {
                HalIn in = plant.step(10, act, button);
                now = in.now_ms;
                act = dev.step(in);
            }
        } else {
            dev.on_line(line, now);
        }
        drain(dev);
    }
    return 0;
}
