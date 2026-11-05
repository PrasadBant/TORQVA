// See usb_out.h. The guarantee itself (whole line or nothing, never wait) is lib/torqva_core/line_out.h, unit-tested on the host (test/test_line_out).
#include "usb_out.h"

#include <Arduino.h>
#include <stdarg.h>
#include <stdio.h>
#include "line_out.h"

#if defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT
// ---- native USB (Serial = the chip's USB-Serial/JTAG CDC): the host can stop reading at any time while the cable stays plugged in.
#include <esp_log.h>
#include <freertos/semphr.h>

namespace {
// TX ring buffer: the default is 256 bytes, smaller than one status line (~300 B), so a "fits entirely" check could never pass. 4 KB holds ~1.4 s of
// the device's own output (~3 KB/s); a host that reads keeps it near empty (USB full speed drains it far faster than the device writes).
constexpr size_t kTxBuffer = 4096;
// Serial.setTxTimeoutMs(0) is NOT "non-blocking" in arduino-esp32 2.0.17: HWCDC::write's no-progress counter starts at the timeout value and is
// decremented before it is checked, so 0 wraps and the write waits forever for the host. The fits-entirely check below means HWCDC::write never
// reaches that wait; this small non-zero value only bounds it (and the tx_lock wait) for any writer that bypasses usb_out.
constexpr uint32_t kTxTimeoutMs = 2;
constexpr size_t kLogLine = 160;               // ESP-IDF log lines (runs on the logging task's stack: kept small; longer messages are cut, they are diagnostics)

SemaphoreHandle_t g_mu = nullptr;              // makes "check room, then write" one step across tasks; taken with a zero wait (busy = drop)
torqva::LineOutStats g_stats = {0, 0};

bool locked_write(const uint8_t* buf, size_t n) {
    if (!g_mu || xSemaphoreTake(g_mu, 0) != pdTRUE) { g_stats.dropped++; return false; }
    const bool ok = torqva::write_buffer_nonblocking(Serial, buf, n, g_stats);
    xSemaphoreGive(g_mu);
    return ok;
}

// ESP-IDF logging (esp_log_write) normally ends in vprintf -> the console, which the SDK mirrors to the USB-Serial/JTAG FIFO
// (CONFIG_ESP_CONSOLE_SECONDARY_USB_SERIAL_JTAG=1), from inside the Wi-Fi / TLS / WebSocket tasks. Routed here instead: same text, never waits.
int idf_log_vprintf(const char* fmt, va_list ap) {
    char buf[kLogLine + 2];
    const int r = vsnprintf(buf, kLogLine, fmt, ap);
    if (r <= 0) return r;
    size_t n = torqva::bounded_len(buf, kLogLine);
    while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == '\r')) n--;
    if (n == 0) return r;
    buf[n] = '\r';
    buf[n + 1] = '\n';
    locked_write(reinterpret_cast<const uint8_t*>(buf), n + 2);
    return r;
}
}  // namespace

void usb_out_begin(unsigned long baud) {
    Serial.setTxBufferSize(kTxBuffer);         // before begin(): begin() creates its 256-byte default only when no buffer exists yet
    Serial.begin(baud);
    Serial.setTxTimeoutMs(kTxTimeoutMs);
    g_mu = xSemaphoreCreateMutex();
    esp_log_set_vprintf(&idf_log_vprintf);
}

bool usb_out_line(const char* line) {
    if (!line) { g_stats.dropped++; return false; }
    const size_t n = torqva::bounded_len(line, torqva::kLineOutMax);
    if (n >= torqva::kLineOutMax) { g_stats.dropped++; return false; }
    uint8_t buf[torqva::kLineOutMax + 2];
    memcpy(buf, line, n);
    buf[n] = '\r';
    buf[n + 1] = '\n';
    return locked_write(buf, n + 2);
}

uint32_t usb_out_dropped() { return g_stats.dropped; }

#else
// ---- UART builds (env:esp32s3_uart: Serial = UART0 through the board's USB-UART bridge chip). A UART shifts bytes out at its baud rate whether or not
// anyone listens, so a write is bounded by the line length and never waits on a host: behaviour unchanged from 1.1.1.
namespace { uint32_t g_dropped = 0; }

void usb_out_begin(unsigned long baud) { Serial.begin(baud); }

bool usb_out_line(const char* line) {
    if (!line) { g_dropped++; return false; }
    Serial.println(line);
    return true;
}

uint32_t usb_out_dropped() { return g_dropped; }
#endif
