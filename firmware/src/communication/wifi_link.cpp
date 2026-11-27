// See wifi_link.h. Built only with TORQVA_WIFI_LINK=1; empty otherwise.
//
// Link architecture (each choice is tied to a bench measurement or a library fact, see docs/reports/WIFI_LINK_RELIABILITY.md):
//   * Wi-Fi modem sleep is OFF by default (TORQVA_WIFI_PS=1 restores the Arduino default). With modem sleep the radio only wakes at the AP's DTIM beacon,
//     so the TCP acknowledgements the sender waits for arrive late; the link reports the mode it really runs ("ps" in link_diag).
//   * TCP_NODELAY is set on the link socket. The WebSocket transport writes the frame header and the payload as two TLS records; with Nagle on, the second
//     waits for the peer's (delayed) ACK of the first. "nd" in link_diag reports whether it was applied.
//   * The WebSocket client's own task only COPIES received messages into a queue (on_event). Parsing, the device lock, NVS writes and system commands run on
//     the link task, so they can never hold the client's internal lock while a send is waiting for it.
//   * Two outbound queues (lib/torqva_core/communication/link_classify.h): priority (lines outside the sequence: acks, the handshake, logs, network info)
//     and ordered (every line with a real "seq": telemetry, status, ota, wifi_state; one queue, because the backend reads a backwards seq as a device
//     restart and ends the session). Priority lines go first. Ordered lines are batched into one WebSocket message (newline-separated, < LINK_MAX_MSG) at
//     most every kTelemetryTickMs, and under backpressure only periodic telemetry is dropped (oldest first). Every drop is counted and reported.
//   * One bounded send per message (kSendWaitMs). A send that fails closes the link: a partly written TLS stream cannot be resumed, and retrying with a
//     longer wait only hides a stall (it is not done).
#include "wifi_link.h"

#if defined(TORQVA_WIFI_LINK) && TORQVA_WIFI_LINK
#include <WiFi.h>
#include <ESPmDNS.h>
#include <esp_websocket_client.h>
#include <esp_wifi.h>
#include <freertos/queue.h>
#include <esp_system.h>
#include <errno.h>
#include <lwip/sockets.h>
#include "ota_esp32.h"
#include "usb_out.h"
#include "communication/link_classify.h"

#ifndef TORQVA_DEVICE_ID
#define TORQVA_DEVICE_ID "RIG-1"
#endif
#ifndef TORQVA_FW_VERSION
#define TORQVA_FW_VERSION "1.1.2"
#endif
#ifndef TORQVA_WIFI_PS
#define TORQVA_WIFI_PS 0                      // 0 = modem sleep off (low latency); 1 = the Arduino default (WIFI_PS_MIN_MODEM), kept only for A/B measurement
#endif

using namespace torqva;

namespace {
constexpr size_t kLine = 320;                 // device lines are < 320 bytes (Device::pop_line buffer)
constexpr size_t kRx = 1024;                  // the backend's own limit per message is 1024 bytes (device_link.py)
constexpr size_t kFrame = 960;                // one outbound message carries several lines, always below the backend's 1024-byte limit
constexpr uint32_t kWifiWaitMs = 20000;
constexpr uint32_t kWsConnectWaitMs = 15000;
// One bounded write per message. Measured on RIG-1 (27 Nov, 15-minute run on the phone hotspot): 33 TCP stalls in 15 min, the longest 3.7 s, at RSSI -34 to
// -56 dBm. A stall that starts DURING a write made the WebSocket client abort a healthy link at the old 1 s budget. 4 s is above the worst measured stall and
// half the 8 s after which both this board (kStallDeadMs) and the backend (LINK_SILENT_S) declare a link dead, so a dead link is still detected as before.
constexpr uint32_t kSendWaitMs = 4000;
constexpr uint32_t kTelemetryTickMs = 100;
constexpr uint32_t kStallDeadMs = 8000;       // no send-buffer room for this long = dead link (matches the backend's LINK_SILENT_S)    // telemetry-only messages at most this often (priority lines never wait for it)
constexpr uint32_t kBackoffMinMs = 1000, kBackoffMaxMs = 8000, kStableMs = 10000;
constexpr UBaseType_t kPrioDepth = 16, kTeleDepth = 24, kRxDepth = 10;   // inbound: ~1 KB per slot; holds the post-handshake burst (auth, limits, heartbeats, a command) during a 1 s send

struct RxItem { uint16_t len; char d[kRx + 1]; };

Device* g_dev = nullptr;
SemaphoreHandle_t g_mu = nullptr;
QueueHandle_t g_pq = nullptr, g_tq = nullptr, g_rq = nullptr;
volatile bool g_up = false, g_closed = false, g_mdns_ok = false, g_reconnect_req = false;
String g_uri;
uint16_t g_port = 443;
const char* g_ca = nullptr;
RxItem g_rx;                                  // assembled by the WebSocket task only (on_event), then copied into g_rq

// Link diagnostics, reported over Wi-Fi alone (no USB log needed). net_info keeps its original fields; link_diag carries the measurements below.
enum CloseCause : uint8_t { CC_NONE = 0, CC_SEND_FAIL = 1, CC_WS_ERROR = 2, CC_PEER_CLOSED = 3, CC_NOT_CONNECTED = 4, CC_RECONNECT_REQ = 5, CC_TRIAL = 6, CC_STALL = 7 };
// Where the link task is right now, and since when (link_diag "ph" / "pa", reported by the LOOP task, so a link task that is stuck is still visible).
enum Phase : uint8_t { PH_START = 0, PH_WIFI_JOIN = 1, PH_WS_CONNECT = 2, PH_LINK = 3, PH_WS_STOP = 4, PH_BACKOFF = 5 };
volatile uint8_t g_phase = PH_START;
volatile uint32_t g_phase_t0 = 0;
void phase(Phase p) { g_phase = p; g_phase_t0 = millis(); }
volatile bool g_connecting = false;           // a station connect is in progress: nothing else may start a connect or a scan meanwhile
bool g_sta_ready = false;
int g_link_fd = -1;                           // the link's socket (found by apply_nodelay); used to wait for send-buffer room instead of blocking in a write
volatile uint32_t g_stalls = 0, g_stall_max_ms = 0, g_lock_waits = 0, g_absent_scans = 0;
bool g_scan_busy();
extern volatile bool g_scan_done_evt;
void hook_scan_done();
volatile uint8_t g_close_cause = CC_NONE;
volatile int32_t g_close_err = 0;             // transport errno reported by the WebSocket client for the last error
volatile uint16_t g_close_code = 0;           // WebSocket close code the peer sent (4409 = the backend refused or replaced the link)
volatile bool g_ws_error = false;
volatile uint32_t g_links = 0, g_last_up_s = 0, g_max_send_ms = 0;
volatile int g_close_rssi = 0;
volatile uint32_t g_tele_drop = 0, g_prio_drop = 0, g_rx_drop = 0;
volatile uint8_t g_wifi_reason = 0;           // last station disconnect reason (wifi_err_reason_t: 2 auth expired, 8 assoc leave, 15 4-way timeout, 200 beacon timeout, 201 no AP...)
volatile uint32_t g_wifi_drops = 0;
uint32_t g_frames = 0, g_send_sum_ms = 0, g_send_hist[5] = {0, 0, 0, 0, 0};   // per link: < 20, < 100, < 300, < 1000, >= 1000 ms
uint32_t g_rx_max_ms = 0, g_link_t0 = 0;
UBaseType_t g_pq_hw = 0, g_tq_hw = 0;
int g_nodelay = 0;                            // sockets TCP_NODELAY was applied to on this link (0 = not applied)

void start_mdns() {
    if (g_mdns_ok) return;
    String host = String("torqva-") + TORQVA_DEVICE_ID;
    host.toLowerCase();
    if (MDNS.begin(host.c_str())) {
        MDNS.addService("torqva", "tcp", 80);
        MDNS.addServiceTxt("torqva", "tcp", "dev", TORQVA_DEVICE_ID);
        MDNS.addServiceTxt("torqva", "tcp", "fw", TORQVA_FW_VERSION);
        MDNS.addServiceTxt("torqva", "tcp", "proto", "1");
        g_mdns_ok = true;
    }
}

void enqueue_prio(const char* line) {
    char item[kLine];
    strncpy(item, line, kLine - 1); item[kLine - 1] = 0;
    if (xQueueSend(g_pq, item, 0) != pdTRUE) g_prio_drop++;
}

// Network info and link measurements go over BOTH transports: while USB holds the session and Wi-Fi is on standby the backend reads only USB, and while
// Wi-Fi is down USB is the only way to say why (wrong password, network not found...).
void emit_diag(const char* line) {
    if (g_up) enqueue_prio(line);
    usb_out_line(line);
}

void send_net_info() {
    char buf[300];
    const int w = snprintf(buf, sizeof(buf),
        "{\"t\":\"net_info\",\"seq\":0,\"ts\":%lu,\"ip\":\"%s\",\"ssid\":\"%s\",\"rssi\":%d,\"mac\":\"%s\",\"heap\":%lu,\"up_s\":%lu,\"rr\":%d,\"lc\":%u,\"le\":%ld,\"lu\":%lu,\"ln\":%lu,\"lr\":%d,\"sm\":%lu}",
        (unsigned long)millis(), WiFi.localIP().toString().c_str(), WiFi.SSID().c_str(),
        (int)WiFi.RSSI(), WiFi.macAddress().c_str(), (unsigned long)ESP.getFreeHeap(), (unsigned long)(millis() / 1000),
        (int)esp_reset_reason(), (unsigned)g_close_cause, (long)g_close_err, (unsigned long)g_last_up_s, (unsigned long)g_links, g_close_rssi, (unsigned long)g_max_send_ms);
    if (w > 0 && (size_t)w < sizeof(buf)) emit_diag(buf);
}

UBaseType_t stack_free(const char* task) {
    TaskHandle_t t = xTaskGetHandle(task);
    return t ? uxTaskGetStackHighWaterMark(t) : 0;   // bytes left at the deepest point so far (ESP-IDF reports bytes)
}

void send_link_diag() {
    wifi_ps_type_t ps = WIFI_PS_NONE;
    esp_wifi_get_ps(&ps);
    char buf[kLine];
    const int w = snprintf(buf, sizeof(buf),
        "{\"t\":\"link_diag\",\"seq\":0,\"ts\":%lu,\"ps\":%d,\"nd\":%d,\"wdr\":%u,\"wdn\":%lu,\"mh\":%lu,\"pq\":%u,\"tq\":%u,\"td\":%lu,\"pd\":%lu,\"rd\":%lu,"
        "\"fr\":%lu,\"sa\":%lu,\"sh\":[%lu,%lu,%lu,%lu,%lu],\"rx\":%lu,\"cc\":%u,\"lu\":%lu,\"sl\":%u,\"so\":%u,\"ph\":%u,\"pa\":%lu,\"st\":%lu,\"sx\":%lu,\"lw\":%lu,\"as\":%lu}",
        (unsigned long)millis(), (int)ps, g_nodelay, (unsigned)g_wifi_reason, (unsigned long)g_wifi_drops, (unsigned long)ESP.getMinFreeHeap(),
        (unsigned)g_pq_hw, (unsigned)g_tq_hw, (unsigned long)g_tele_drop, (unsigned long)g_prio_drop, (unsigned long)g_rx_drop,
        (unsigned long)g_frames, (unsigned long)(g_frames ? g_send_sum_ms / g_frames : 0),
        (unsigned long)g_send_hist[0], (unsigned long)g_send_hist[1], (unsigned long)g_send_hist[2], (unsigned long)g_send_hist[3], (unsigned long)g_send_hist[4],
        (unsigned long)g_rx_max_ms, (unsigned)g_close_code, (unsigned long)((millis() - g_link_t0) / 1000),
        (unsigned)stack_free("link"), (unsigned)stack_free("oled"), (unsigned)g_phase, (unsigned long)((millis() - g_phase_t0) / 1000),
        (unsigned long)g_stalls, (unsigned long)g_stall_max_ms, (unsigned long)g_lock_waits, (unsigned long)g_absent_scans);
    if (w > 0 && (size_t)w < sizeof(buf)) emit_diag(buf);
}

void feed_lines(char* buf, size_t n) {
    buf[n] = 0;
    char* p = buf;
    while (p && *p) {
        char* nl = strchr(p, '\n');
        if (nl) *nl = 0;
        const size_t len = strlen(p);
        if (len > 0 && len < 512 && xSemaphoreTake(g_mu, pdMS_TO_TICKS(200)) == pdTRUE) {
            g_dev->on_line(p, millis());
            xSemaphoreGive(g_mu);
        }
        p = nl ? nl + 1 : nullptr;
    }
}

// Runs on the WebSocket client's task. It only records state and copies a complete text message into g_rq: nothing here waits, locks the device or
// touches NVS, so the client's internal lock is never held behind TORQVA work.
void on_event(void*, esp_event_base_t, int32_t id, void* data) {
    auto* d = static_cast<esp_websocket_event_data_t*>(data);
    switch (id) {
        case WEBSOCKET_EVENT_CONNECTED: g_rx.len = 0; g_up = true; break;
        case WEBSOCKET_EVENT_ERROR:
            g_ws_error = true;
            g_close_err = (int32_t)errno;                       // the WebSocket task's errno at the moment of the error (this IDF has no error_handle)
            g_up = false; g_closed = true; break;
        case WEBSOCKET_EVENT_DISCONNECTED: case WEBSOCKET_EVENT_CLOSED: g_up = false; g_closed = true; break;
        case WEBSOCKET_EVENT_DATA:
            if (d->op_code == 0x8) {                                             // close frame: keep the peer's close code (why the backend ended or refused the link)
                if (d->data_len >= 2 && d->data_ptr) g_close_code = (uint16_t)(((uint8_t)d->data_ptr[0] << 8) | (uint8_t)d->data_ptr[1]);
                break;
            }
            if (d->op_code != 0x1 && d->op_code != 0x0) break;                   // text (and its continuation) only; ping / pong are the client's own
            if (d->payload_offset == 0) g_rx.len = 0;
            if (d->payload_len > (int)kRx || g_rx.len + (size_t)d->data_len > kRx) { g_rx.len = 0; break; }   // oversized: dropped, never truncated into a command
            memcpy(g_rx.d + g_rx.len, d->data_ptr, (size_t)d->data_len); g_rx.len += (uint16_t)d->data_len;
            if (d->payload_offset + d->data_len >= d->payload_len) {
                g_rx.d[g_rx.len] = 0;
                if (xQueueSend(g_rq, &g_rx, 0) != pdTRUE) g_rx_drop++;          // the link task drains this every few ms; a full queue is counted, never waited on
                g_rx.len = 0;
            }
            break;
        default: break;
    }
}

void on_wifi_disconnected(arduino_event_id_t, arduino_event_info_t info) {
    g_wifi_reason = info.wifi_sta_disconnected.reason;
    g_wifi_drops++;
}

// TCP_NODELAY on the link's socket. esp_websocket_client (IDF 4.4) does not expose its socket, so the lwIP sockets are scanned for the one whose peer is the
// gateway port; setting the option on any other socket to that port (an OTA download to the same gateway) is harmless.
int apply_nodelay() {
    int n = 0;
    for (int fd = LWIP_SOCKET_OFFSET; fd < LWIP_SOCKET_OFFSET + CONFIG_LWIP_MAX_SOCKETS; fd++) {
        struct sockaddr_in a;
        socklen_t l = sizeof(a);
        if (getpeername(fd, (struct sockaddr*)&a, &l) != 0 || a.sin_family != AF_INET || ntohs(a.sin_port) != g_port) continue;
        int one = 1;
        if (setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one)) == 0) { n++; g_link_fd = fd; }
    }
    return n;
}

// True when the link socket can take a message without the write blocking (lwIP reports "writable" only with at least TCP_SNDLOWAT bytes of send buffer
// free, more than one message of <= 1 KB). esp_websocket_client (IDF 4.4) ABORTS the whole connection when one write times out (measured on RIG-1: every
// standby drop on 27 Nov had a ~1000 ms send right before it), so a transient stall is waited out here, before the write, not inside it.
bool sock_writable() {
    if (g_link_fd < 0) return true;
    fd_set w; FD_ZERO(&w); FD_SET(g_link_fd, &w);
    struct timeval tv = {0, 0};
    return select(g_link_fd + 1, nullptr, &w, nullptr, &tv) > 0;
}

// One owner of the Wi-Fi station: this task. Measured on RIG-1 (27 Nov): with the saved network absent, 3.2.0 panicked in the Wi-Fi driver's connect scan
// (ieee80211_sta_connect -> scan_start -> clear_bss_queue, LoadStoreError) every ~15 s, while Arduino's own event-task reconnect (disconnect + begin on every
// STA_DISCONNECTED) and this task's begin / power-save calls both drove the driver. Now: Arduino auto-reconnect off, power save set once before the station
// starts, and a connect that did not finish is stopped before the next one starts.
void sta_init_once() {
    if (g_sta_ready) return;
    WiFi.persistent(false);                   // TORQVA keeps its own network settings (torqva_ota); the driver no longer rewrites nvs.net80211 on every join
    WiFi.setAutoReconnect(false);
    WiFi.setSleep(TORQVA_WIFI_PS ? true : false);   // stored now, applied by mode() when the station starts: never changed during a connect or a scan
    WiFi.mode(WIFI_STA);
    g_sta_ready = true;
}

// Joins (or stays on) the network the CURRENT configuration names. Already being associated is not enough: after a staged change or a revert the configured
// SSID differs from the one joined, and the link must move to it.
// Root cause measured on RIG-1 (27 Nov; 4 captured panics on 3.2.0-3.2.4, reproduced automatically with a staged non-existent network): when the saved network
// is absent, the IDF 4.4.7 Wi-Fi driver panics INSIDE its connect command (cnx_sta_connect_cmd -> its own scan -> scan_build_chan_list / clear_bss_queue reading
// a bad pointer) on about the 8th consecutive connect that finds no AP. It does so with power save off or on, with one or two callers, and even after a full
// esp_wifi_deinit / init between attempts (3.2.3). The heap stayed intact and the driver's object held valid pointers up to the crash (3.2.4 diagnostic), so
// the fault is in the driver's connect processing, not in TORQVA memory.
// Therefore no connect command is ever given for a network that is not there: a targeted scan for the saved SSID comes first (a plain scan, which does not
// go through cnx_sta_connect_cmd), and the connect is issued only when the scan saw the network, locked to the channel and BSSID it was seen on, so the
// driver does not start its own connect scan either.
bool find_network(const String& ssid, int32_t* ch, uint8_t bssid[6], int32_t* rssi) {
    g_scan_done_evt = false;
    if (WiFi.scanNetworks(true, false, false, 120, 0, ssid.c_str()) == WIFI_SCAN_FAILED) return false;
    const uint32_t t0 = millis();
    while (!g_scan_done_evt && millis() - t0 < 10000) delay(20);
    const int n = g_scan_done_evt ? WiFi.scanComplete() : -1;
    bool found = false;
    for (int i = 0; i < n && !found; i++) {
        if (WiFi.SSID(i) != ssid) continue;
        *ch = WiFi.channel(i); *rssi = WiFi.RSSI(i);
        const uint8_t* b = WiFi.BSSID(i);
        if (b) memcpy(bssid, b, 6);
        found = b != nullptr;
    }
    WiFi.scanDelete();
    return found;
}

bool wifi_up() {
    String ssid, pass, base, ca;
    if (!ota_net_config(&ssid, &pass, &base, &ca)) return WiFi.status() == WL_CONNECTED;
    sta_init_once();
    hook_scan_done();
    if (WiFi.status() == WL_CONNECTED && WiFi.SSID() == ssid) return true;
    phase(PH_WIFI_JOIN);
    g_connecting = true;
    while (g_scan_busy()) delay(50);                            // a user-requested scan finishes first (none can start while g_connecting)
    if (WiFi.status() == WL_CONNECTED) {                        // on another network (staged change / revert): leave it first
        WiFi.disconnect(false);
        const uint32_t d0 = millis();
        while (WiFi.status() == WL_CONNECTED && millis() - d0 < 3000) delay(50);
    }
    int32_t ch = 0, rssi = 0; uint8_t bssid[6] = {0};
    if (!find_network(ssid, &ch, bssid, &rssi)) {
        g_wifi_reason = 201; g_wifi_drops++; g_absent_scans++;  // reported exactly like the driver's own NO_AP_FOUND (201), but no connect was attempted
        g_connecting = false;
        return false;
    }
    WiFi.begin(ssid.c_str(), pass.c_str(), ch, bssid);
    const uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 <= kWifiWaitMs) delay(100);
    const bool ok = WiFi.status() == WL_CONNECTED;
    if (!ok) {
        WiFi.disconnect(false);                                 // a network that was seen but refused us (wrong password, AP full...): stop before the next try
        delay(300);
    }
    g_connecting = false;
    return ok;
}

// The WebSocket address follows the current configuration (a staged or reverted network can carry another backend address).
void refresh_uri() {
    String ssid, pass, base, ca;
    if (!ota_net_config(&ssid, &pass, &base, &ca)) return;
    String host = base; if (host.endsWith("/")) host.remove(host.length() - 1);
    host = host.substring(8);                                                      // base is https://<host>[:port], checked by ota_platform_capability
    g_uri = "wss://" + host + "/api/torqva/device/link";
    const int colon = host.lastIndexOf(':');
    const long port = colon > 0 ? host.substring(colon + 1).toInt() : 443;
    g_port = (port > 0 && port < 65536) ? (uint16_t)port : 443;
}

// Appends queued lines to frame[*n] while they fit. Returns how many lines were taken.
int take(QueueHandle_t q, char* frame, size_t* n, char* item) {
    int k = 0;
    while (xQueuePeek(q, item, 0) == pdTRUE) {
        const size_t len = strlen(item);
        if (*n + len + 1 > kFrame) break;
        xQueueReceive(q, item, 0);
        if (*n) frame[(*n)++] = '\n';
        memcpy(frame + *n, item, len); *n += len;
        k++;
    }
    return k;
}

void note_hw() {
    const UBaseType_t p = uxQueueMessagesWaiting(g_pq), t = uxQueueMessagesWaiting(g_tq);
    if (p > g_pq_hw) g_pq_hw = p;
    if (t > g_tq_hw) g_tq_hw = t;
}

void link_task(void*) {
    uint32_t backoff = kBackoffMinMs;
    static char item[kLine];
    static char frame[kFrame + 1];
    static RxItem rx;
    for (;;) {
        uint32_t connected_at = 0;
        ota_wifi_trial_tick(millis());
        refresh_uri();
        if (wifi_up()) {
            esp_websocket_client_config_t c = {};
            c.uri = g_uri.c_str();
            c.cert_pem = g_ca;                        // server certificate verified against the provisioned CA; ESP-TLS checks the host name
            c.disable_auto_reconnect = true;          // reconnecting is done below, with backoff and jitter
            c.buffer_size = kRx;
            c.task_stack = 6144;
            c.pingpong_timeout_sec = 20;
            c.user_agent = "torqva-device/1";
            phase(PH_WS_CONNECT);
            esp_websocket_client_handle_t h = esp_websocket_client_init(&c);
            if (h) {
                g_closed = false; g_close_code = 0;
                xQueueReset(g_rq);
                esp_websocket_register_events(h, WEBSOCKET_EVENT_ANY, on_event, nullptr);
                if (esp_websocket_client_start(h) == ESP_OK) {
                    const uint32_t t0 = millis();
                    while (!g_up && !g_closed && millis() - t0 < kWsConnectWaitMs) delay(20);
                    if (g_up) {
                        connected_at = g_link_t0 = millis();
                        phase(PH_LINK);
                        g_link_fd = -1;
                        g_links++; g_ws_error = false; g_max_send_ms = 0; g_frames = 0; g_send_sum_ms = 0; g_rx_max_ms = 0; g_pq_hw = 0; g_tq_hw = 0;
                        memset(g_send_hist, 0, sizeof(g_send_hist));
                        g_nodelay = apply_nodelay();
                        start_mdns();
                        xQueueReset(g_pq); xQueueReset(g_tq);   // nothing queued while the link was down is sent late
                        wifi_log("INFO", "Wi-Fi TLS link connected");
                        send_net_info();
                        send_link_diag();
                        uint32_t last_tele = 0, stall_t0 = 0;
                        bool send_failed = false, stalled_out = false;
                        size_t n = 0;                                  // a message built but not yet written (kept while the socket has no room)
                        while (g_up && !g_closed && !g_reconnect_req && esp_websocket_client_is_connected(h)) {
                            ota_wifi_trial_tick(millis());
                            // 1. Inbound first: commands, heartbeats and the handshake from the backend.
                            while (xQueueReceive(g_rq, &rx, 0) == pdTRUE) {
                                const uint32_t r0 = millis();
                                feed_lines(rx.d, rx.len);
                                const uint32_t rt = millis() - r0;
                                if (rt > g_rx_max_ms) g_rx_max_ms = rt;
                            }
                            // 2. One outbound message: every waiting priority line, then telemetry (at most every kTelemetryTickMs unless priority lines go anyway).
                            note_hw();
                            if (n == 0) {
                                const int prio = take(g_pq, frame, &n, item);
                                if (prio > 0 || (uint32_t)(millis() - last_tele) >= kTelemetryTickMs) {
                                    if (take(g_tq, frame, &n, item) > 0) last_tele = millis();
                                }
                            }
                            if (n == 0) { delay(5); continue; }
                            if (!sock_writable()) {
                                // TCP is not draining (the AP or the peer is not taking data right now). Wait for room instead of blocking in the write, which the
                                // WebSocket client would turn into an aborted connection. Meanwhile new telemetry replaces old (wifi_link_send); acks stay queued.
                                if (!stall_t0) { stall_t0 = millis(); g_stalls++; }
                                const uint32_t sd = millis() - stall_t0;
                                if (sd > g_stall_max_ms) g_stall_max_ms = sd;
                                if (sd > kStallDeadMs) { stalled_out = true; break; }      // no progress at all: the link is dead (the backend gives up at 8 s too)
                                delay(10);
                                continue;
                            }
                            stall_t0 = 0;
                            frame[n] = 0;
                            const uint32_t s0 = millis();
                            const int sent = esp_websocket_client_send_text(h, frame, (int)n, pdMS_TO_TICKS(kSendWaitMs));
                            const uint32_t took = millis() - s0;
                            if (sent < 0 && esp_websocket_client_is_connected(h) && !g_closed) {
                                // The client's own task held its lock (IDF 4.4 holds it while reading, and a TLS read can wait on a partial record): nothing was
                                // written and the client did NOT abort, so the SAME message is sent again on the next pass. Measured on RIG-1 (27 Nov, 14:38:53):
                                // a link closed here while the socket was writable and no stall was seen. A real write failure aborts the client (handled below).
                                g_lock_waits++;
                                if (took > g_max_send_ms) g_max_send_ms = took;
                                continue;
                            }
                            n = 0;
                            if (took > g_max_send_ms) g_max_send_ms = took;
                            g_frames++; g_send_sum_ms += took;
                            g_send_hist[took < 20 ? 0 : took < 100 ? 1 : took < 300 ? 2 : took < 1000 ? 3 : 4]++;
                            if (sent <= 0) { send_failed = true; break; }          // 0 = the write timed out and the client already aborted the connection
                        }
                        g_last_up_s = (millis() - connected_at) / 1000;
                        g_close_rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
                        // Why THIS link ended (net_info reports it during the next link). Decided per link, so an earlier link's cause is never carried over.
                        if (g_reconnect_req) g_close_cause = CC_RECONNECT_REQ;
                        else if (stalled_out) g_close_cause = CC_STALL;
                        else if (send_failed) g_close_cause = CC_SEND_FAIL;
                        else g_close_cause = g_ws_error ? CC_WS_ERROR : (g_closed ? CC_PEER_CLOSED : CC_NOT_CONNECTED);
                        if (g_reconnect_req) {
                            g_reconnect_req = false;
                            WiFi.disconnect(true);
                        }
                    }
                }
                g_up = false;
                phase(PH_WS_STOP);
                esp_websocket_client_stop(h);
                esp_websocket_client_destroy(h);
            }
        }
        phase(PH_BACKOFF);
        if (connected_at && millis() - connected_at > kStableMs) backoff = kBackoffMinMs;        // a link that lasted resets the backoff
        delay(backoff + (esp_random() % (backoff / 2 + 1)));                                     // exponential backoff with jitter, capped at kBackoffMaxMs
        backoff = backoff * 2 > kBackoffMaxMs ? kBackoffMaxMs : backoff * 2;
    }
}
}  // namespace

void wifi_link_start(Device* dev, SemaphoreHandle_t mu) {
    String ssid, pass, base, ca;
    if (!ota_net_config(&ssid, &pass, &base, &ca)) return;                      // not provisioned: USB only (nothing invented)
    g_dev = dev; g_mu = mu;
    refresh_uri();
    static String ca_keep; ca_keep = ca; g_ca = ca_keep.c_str();
    g_pq = xQueueCreate(kPrioDepth, kLine);
    g_tq = xQueueCreate(kTeleDepth, kLine);
    g_rq = xQueueCreate(kRxDepth, sizeof(RxItem));
    WiFi.onEvent(on_wifi_disconnected, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
    xTaskCreatePinnedToCore(link_task, "link", 8192, nullptr, 2, nullptr, 0);   // above loop() and the OLED (priority 1); below the control task
}

void wifi_link_send(const char* line) {
    if (!g_pq || !g_up || !line) return;
    const LinkClass k = link_classify(line);
    if (k == LinkClass::PRIORITY) { enqueue_prio(line); return; }            // no "seq" / seq 0: may overtake the ordered stream (link_classify.h)
    char item[kLine];
    strncpy(item, line, kLine - 1); item[kLine - 1] = 0;
    if (xQueueSend(g_tq, item, 0) == pdTRUE) return;
    // Backpressure on the ORDERED queue (one queue, so sequence numbers never go backwards). Only periodic telemetry is ever dropped: the oldest one if it
    // is at the head, otherwise the incoming line if it is telemetry. A status / ota frame that still finds no room is counted as a priority drop (pd).
    char head[kLine];
    if (xQueuePeek(g_tq, head, 0) == pdTRUE && link_is_telemetry(head) && xQueueReceive(g_tq, head, 0) == pdTRUE) {
        g_tele_drop++;
        if (xQueueSend(g_tq, item, 0) == pdTRUE) return;
    }
    if (k == LinkClass::ORDERED_TELEMETRY) g_tele_drop++; else g_prio_drop++;
}

bool wifi_link_up() { return g_up; }

// Called from loop() (core 1). Network info and link measurements every 5 s, whatever the link task is doing, so a link task that is stuck in one phase
// still shows up (link_diag "ph" / "pa") instead of falling silent.
void wifi_link_poll() {
    if (!g_pq) return;
    static uint32_t last = 0;
    if ((uint32_t)(millis() - last) < 5000) return;
    last = millis();
    send_net_info();
    send_link_diag();
}

void wifi_log(const char* lvl, const char* msg) {
    char safe[200];
    size_t j = 0;
    for (size_t i = 0; msg && msg[i] && j + 1 < sizeof(safe); i++) {
        char ch = msg[i];
        safe[j++] = (ch == '"' || ch == '\\' || (unsigned char)ch < 0x20) ? ' ' : ch;
    }
    safe[j] = 0;
    char line[280];
    const int w = snprintf(line, sizeof(line), "{\"t\":\"log\",\"seq\":0,\"ts\":%lu,\"lvl\":\"%s\",\"msg\":\"%s\"}",
                           (unsigned long)millis(), lvl ? lvl : "INFO", safe);
    if (w > 0 && (size_t)w < sizeof(line)) {
        wifi_link_send(line);
        usb_out_line(line);
    }
}

void wifi_link_reconnect() {
    g_reconnect_req = true;                     // the link task re-reads the configuration (address and network) on its next cycle
}

// ---- Wi-Fi scan (asynchronous: the control loop never waits). One scan at most every 10 s, shown as at most 12 networks, strongest first, one entry per name.
namespace {
struct ScanNet { char ssid[33]; int rssi; int ch; const char* auth; };
ScanNet g_nets[12];
int g_net_n = 0, g_net_emit = 0;
bool g_scan_pending = false, g_scan_collected = false;
volatile bool g_scan_done_evt = false;        // set by the driver's SCAN_DONE event (Arduino's own 20 x per-channel guess expires before a scan made while associated ends)
void on_scan_done(arduino_event_id_t, arduino_event_info_t) { g_scan_done_evt = true; }
void hook_scan_done() {
    static bool hooked = false;
    if (!hooked) { WiFi.onEvent(on_scan_done, ARDUINO_EVENT_WIFI_SCAN_DONE); hooked = true; }
}
bool g_scan_busy() { return g_scan_pending; }
uint32_t g_scan_t0 = 0;

const char* auth_name(wifi_auth_mode_t a) {
    switch (a) {
        case WIFI_AUTH_OPEN: return "OPEN";
        case WIFI_AUTH_WEP: return "WEP";
        case WIFI_AUTH_WPA_PSK: return "WPA";
        case WIFI_AUTH_WPA2_PSK: return "WPA2";
        case WIFI_AUTH_WPA_WPA2_PSK: return "WPA/WPA2";
        case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2-ENT";
        case WIFI_AUTH_WPA3_PSK: return "WPA3";
        case WIFI_AUTH_WPA2_WPA3_PSK: return "WPA2/WPA3";
        default: return "OTHER";
    }
}
void json_safe(char* dst, size_t cap, const char* src) {
    size_t j = 0;
    for (size_t i = 0; src && src[i] && j + 1 < cap; i++) {
        const unsigned char c = (unsigned char)src[i];
        dst[j++] = (c < 0x20 || c == '"' || c == '\\' || c == 0x7f) ? '?' : (char)c;
    }
    dst[j] = 0;
}
void emit(const char* line) { wifi_link_send(line); usb_out_line(line); }
void emit_end(int ok, const char* why) {
    char line[160];
    snprintf(line, sizeof(line), "{\"t\":\"wifi_scan_end\",\"seq\":0,\"ts\":%lu,\"n\":%d,\"ok\":%d,\"why\":\"%s\"}", (unsigned long)millis(), g_net_n, ok, why);
    emit(line);
}
}  // namespace

bool wifi_scan_start() {
    if (g_scan_pending || g_connecting) return false;                                            // never a scan during a station connect (one owner of the driver)
    hook_scan_done();
    g_scan_done_evt = false;
    static uint32_t last = 0;
    if (last && (uint32_t)(millis() - last) < 10000u) return false;
    if (WiFi.getMode() == WIFI_OFF) WiFi.mode(WIFI_STA);
    if (WiFi.scanNetworks(true, false, false, 120) == WIFI_SCAN_FAILED) return false;           // async; hidden networks are not listed (enter the name by hand)
    last = millis(); g_scan_t0 = last; g_scan_pending = true; g_scan_collected = false; g_net_n = 0; g_net_emit = 0;
    return true;
}

void wifi_scan_poll() {
    if (!g_scan_pending) return;
    // Results are read only once the driver says the scan is over. Measured on RIG-1 (27 Nov): every scan made while associated ended as SCAN_FAILED after
    // ~2.8 s because Arduino gives up after 20 x 120 ms while the driver is still scanning, and it then clears its "scanning" state, so a connect could
    // start on top of a scan still running in the driver. g_scan_pending stays set (no connect can start) until SCAN_DONE or the 15 s safety limit.
    if (!g_scan_done_evt) {
        if ((uint32_t)(millis() - g_scan_t0) > 15000u) { g_scan_pending = false; WiFi.scanDelete(); emit_end(0, "SCAN_TIMEOUT"); }
        return;
    }
    const int n = WiFi.scanComplete();
    if (n == WIFI_SCAN_RUNNING) return;
    if (!g_scan_collected) {
        if (n < 0) { g_scan_pending = false; emit_end(0, "SCAN_FAILED"); return; }
        g_net_n = 0;
        for (int i = 0; i < n; i++) {
            String s = WiFi.SSID(i);
            if (s.length() == 0 || s.length() > 32) continue;                                     // hidden / malformed names are not listed
            const int rssi = WiFi.RSSI(i);
            int dup = -1;
            for (int k = 0; k < g_net_n; k++) if (strcmp(g_nets[k].ssid, s.c_str()) == 0) { dup = k; break; }
            if (dup >= 0 && g_nets[dup].rssi >= rssi) continue;                                    // one entry per name: the strongest
            int slot = dup;
            if (slot < 0) {
                if (g_net_n < 12) slot = g_net_n++;
                else { int w = 0; for (int k = 1; k < 12; k++) if (g_nets[k].rssi < g_nets[w].rssi) w = k; if (g_nets[w].rssi >= rssi) continue; slot = w; }
            }
            json_safe(g_nets[slot].ssid, sizeof(g_nets[slot].ssid), s.c_str());
            g_nets[slot].rssi = rssi; g_nets[slot].ch = WiFi.channel(i); g_nets[slot].auth = auth_name(WiFi.encryptionType(i));
        }
        for (int a = 0; a < g_net_n; a++) for (int b = a + 1; b < g_net_n; b++) if (g_nets[b].rssi > g_nets[a].rssi) { ScanNet t = g_nets[a]; g_nets[a] = g_nets[b]; g_nets[b] = t; }
        WiFi.scanDelete();
        g_scan_collected = true; g_net_emit = 0;
    }
    for (int burst = 0; burst < 3 && g_net_emit < g_net_n; burst++, g_net_emit++) {                // a few lines per call: the link queue is small
        char line[240];
        snprintf(line, sizeof(line), "{\"t\":\"wifi_net\",\"seq\":0,\"ts\":%lu,\"i\":%d,\"n\":%d,\"ssid\":\"%s\",\"rssi\":%d,\"ch\":%d,\"auth\":\"%s\"}",
                 (unsigned long)millis(), g_net_emit, g_net_n, g_nets[g_net_emit].ssid, g_nets[g_net_emit].rssi, g_nets[g_net_emit].ch, g_nets[g_net_emit].auth);
        emit(line);
    }
    if (g_net_emit >= g_net_n) { emit_end(1, ""); g_scan_pending = false; g_scan_collected = false; }
}

#else
void wifi_link_start(torqva::Device*, SemaphoreHandle_t) {}
void wifi_link_send(const char*) {}
bool wifi_link_up() { return false; }
void wifi_log(const char*, const char*) {}
void wifi_link_reconnect() {}
bool wifi_scan_start() { return false; }
void wifi_scan_poll() {}
void wifi_link_poll() {}
#endif
