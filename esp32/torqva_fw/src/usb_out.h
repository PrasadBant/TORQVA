// The firmware's only writer to the USB serial port (firmware 1.1.2; see lib/torqva_core/line_out.h and docs/TORQVA_OTA_LED_BENCH_TEST.md section 11).
//
// Nothing that matters - the safety supervisor, motor control, sensors, Wi-Fi, the WebSocket link, telemetry, OTA - may ever wait on the USB host.
// Every line goes out whole or not at all, at once: when the host is absent, not reading, or slow, the line is dropped (USB is diagnostics and
// recovery; the backend detects any gap from the frame sequence numbers). ESP-IDF's own log output (Wi-Fi / TLS / WebSocket errors, which the SDK
// would otherwise also mirror straight into the USB-Serial/JTAG FIFO from inside those tasks) is routed through the same non-blocking path.
#pragma once
#include <stdint.h>

void usb_out_begin(unsigned long baud);        // replaces Serial.begin(); call once in setup()
bool usb_out_line(const char* line);           // any task (not an ISR); true = queued for the USB host, false = dropped
uint32_t usb_out_dropped();                    // lines dropped since boot (diagnostics)
