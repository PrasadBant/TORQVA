// Which outbound queue a device line belongs to on the Wi-Fi link (src/communication/wifi_link.cpp). Header-only so the host tests cover it.
//
// The backend's DeviceModel treats a sequence number that goes BACKWARDS as a device restart, and a restart ends the authenticated session. So every line
// that carries a real "seq" (telemetry, status, ota, ota_info, wifi_state) must leave the board in the order it was produced: they share ONE queue.
// Only lines outside that sequence may overtake them: no "seq" at all (ack, auth_ch / auth_ok / auth_err, cfg_ack) or "seq":0 (log, net_info, link_diag,
// wifi_net, wifi_scan_end).
#pragma once
#include <string.h>

namespace torqva {

enum class LinkClass { PRIORITY, ORDERED_TELEMETRY, ORDERED_OTHER };

// fast / slow / accel: periodic telemetry, the only lines that may be dropped (oldest first) under backpressure.
inline bool link_is_telemetry(const char* line) {
    return line && (strncmp(line, "{\"t\":\"fast\"", 11) == 0 || strncmp(line, "{\"t\":\"slow\"", 11) == 0 || strncmp(line, "{\"t\":\"accel\"", 12) == 0);
}

inline LinkClass link_classify(const char* line) {
    if (!line) return LinkClass::PRIORITY;
    // "seq" is always the second key (protocol.cpp, ota.cpp, wifi_trial.cpp); look for it only near the start, so a message text can never match.
    const char* s = strstr(line, "\"seq\":");
    if (!s || s - line > 32) return LinkClass::PRIORITY;
    s += 6;
    if (s[0] == '0' && (s[1] == ',' || s[1] == '}')) return LinkClass::PRIORITY;
    return link_is_telemetry(line) ? LinkClass::ORDERED_TELEMETRY : LinkClass::ORDERED_OTHER;
}

}  // namespace torqva
