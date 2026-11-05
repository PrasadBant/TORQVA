// Non-blocking line output to a port that can be back-pressured indefinitely.
//
// Why this exists (firmware 1.1.2, docs/TORQVA_OTA_LED_BENCH_TEST.md section 11): on the ESP32-S3 the USB-Serial/JTAG CDC port (Arduino `Serial` with
// ARDUINO_USB_CDC_ON_BOOT=1) stays "connected" while the cable is plugged into a host, even when no program on the host has the COM port open. Its
// HWCDC::write() then waits for the host to drain the buffer; with Serial.setTxTimeoutMs(0) (arduino-esp32 2.0.17) its no-progress counter starts at
// 0 and wraps, so it waits FOREVER. On RIG-1 that froze loop() and with it the Wi-Fi link's telemetry until someone opened COM10.
//
// The rule enforced here: a line is written whole (plus CRLF, the bytes Serial.println sends) in ONE write, and only when the port reports room for all
// of it right now. Otherwise the line is dropped and counted. Never waits, never retries, never writes a partial line, never truncates.
//
// Host-testable: Port is any type with  int availableForWrite()  and  size_t write(const uint8_t*, size_t)  (Arduino Print/Stream signatures).
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace torqva {

constexpr size_t kLineOutMax = 320;            // longest device line incl. its terminator (Device::pop_line buffer; main.cpp `char out[320]`)

struct LineOutStats {
    uint32_t written;
    uint32_t dropped;
};

inline size_t bounded_len(const char* s, size_t max) {
    size_t n = 0;
    while (n < max && s[n]) n++;
    return n;
}

// Writes `n` ready-made bytes (already CRLF-terminated) in one write, or drops them. True when all of them were handed to the port.
template <class Port>
bool write_buffer_nonblocking(Port& port, const uint8_t* buf, size_t n, LineOutStats& st) {
    const int room = port.availableForWrite();
    if (room < 0 || (size_t)room < n) { st.dropped++; return false; }             // host absent / not reading / buffer full: drop, never wait for it
    const size_t w = port.write(buf, n);
    if (w != n) { st.dropped++; return false; }
    st.written++;
    return true;
}

// Returns true when the whole line (plus CRLF) was handed to the port; false when it was dropped (no room right now, over-long, or a short write).
template <class Port>
bool write_line_nonblocking(Port& port, const char* line, LineOutStats& st) {
    if (!line) { st.dropped++; return false; }
    const size_t n = bounded_len(line, kLineOutMax);
    if (n >= kLineOutMax) { st.dropped++; return false; }                       // over-long: dropped, never truncated (pop_line already bounds it)
    uint8_t buf[kLineOutMax + 2];
    memcpy(buf, line, n);
    buf[n] = '\r';
    buf[n + 1] = '\n';
    return write_buffer_nonblocking(port, buf, n + 2, st);
}

}  // namespace torqva
