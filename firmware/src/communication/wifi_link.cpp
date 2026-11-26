// See wifi_link.h. Built only with TORQVA_WIFI_LINK=1 (OTA LED bench profile); empty otherwise.
#include "wifi_link.h"

#if defined(TORQVA_WIFI_LINK) && TORQVA_WIFI_LINK
#include <WiFi.h>
#include <ESPmDNS.h>
#include <esp_websocket_client.h>
#include <freertos/queue.h>
#include "ota_esp32.h"
#include "usb_out.h"

#ifndef TORQVA_DEVICE_ID
#define TORQVA_DEVICE_ID "RIG-1"
#endif
#ifndef TORQVA_FW_VERSION
#define TORQVA_FW_VERSION "1.1.2"
#endif

using namespace torqva;

namespace {
constexpr size_t kLine = 320;                 // device lines are < 320 bytes (Device::pop_line buffer)
constexpr size_t kRx = 1024;                  // the backend's own limit per message is 1024 bytes (device_link.py)
constexpr uint32_t kWifiWaitMs = 20000;
constexpr uint32_t kWsConnectWaitMs = 15000;
constexpr uint32_t kBackoffMinMs = 1000, kBackoffMaxMs = 30000, kStableMs = 30000;

Device* g_dev = nullptr;
SemaphoreHandle_t g_mu = nullptr;
QueueHandle_t g_q = nullptr;
volatile bool g_up = false, g_closed = false, g_mdns_ok = false, g_reconnect_req = false;
String g_uri;
const char* g_ca = nullptr;
char g_rx[kRx + 1];
size_t g_rx_len = 0;
uint32_t g_dropped = 0;

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

void send_net_info() {
    char buf[260];
    const int w = snprintf(buf, sizeof(buf),
        "{\"t\":\"net_info\",\"seq\":0,\"ts\":%lu,\"ip\":\"%s\",\"ssid\":\"%s\",\"rssi\":%d,\"mac\":\"%s\",\"heap\":%lu,\"up_s\":%lu}",
        (unsigned long)millis(), WiFi.localIP().toString().c_str(), WiFi.SSID().c_str(),
        (int)WiFi.RSSI(), WiFi.macAddress().c_str(), (unsigned long)ESP.getFreeHeap(), (unsigned long)(millis() / 1000));
    if (w > 0 && (size_t)w < sizeof(buf)) wifi_link_send(buf);
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

void on_event(void*, esp_event_base_t, int32_t id, void* data) {
    auto* d = static_cast<esp_websocket_event_data_t*>(data);
    switch (id) {
        case WEBSOCKET_EVENT_CONNECTED: g_rx_len = 0; g_up = true; break;
        case WEBSOCKET_EVENT_DISCONNECTED: case WEBSOCKET_EVENT_CLOSED: case WEBSOCKET_EVENT_ERROR: g_up = false; g_closed = true; break;
        case WEBSOCKET_EVENT_DATA:
            if (d->op_code != 0x1 && d->op_code != 0x0) break;                   // text (and its continuation) only; ping / pong / close are the client's own
            if (d->payload_offset == 0) g_rx_len = 0;
            if (d->payload_len > (int)kRx || g_rx_len + (size_t)d->data_len > kRx) { g_rx_len = 0; break; }   // oversized: dropped, never truncated into a command
            memcpy(g_rx + g_rx_len, d->data_ptr, (size_t)d->data_len); g_rx_len += (size_t)d->data_len;
            if (d->payload_offset + d->data_len >= d->payload_len) { feed_lines(g_rx, g_rx_len); g_rx_len = 0; }
            break;
        default: break;
    }
}

// Joins (or stays on) the network the CURRENT configuration names. Already being associated is not enough: after a staged change or a revert the configured
// SSID differs from the one joined, and the link must move to it.
bool wifi_up() {
    String ssid, pass, base, ca;
    if (!ota_net_config(&ssid, &pass, &base, &ca)) return WiFi.status() == WL_CONNECTED;
    if (WiFi.status() == WL_CONNECTED && WiFi.SSID() == ssid) return true;
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    if (WiFi.status() == WL_CONNECTED) WiFi.disconnect(false);
    WiFi.begin(ssid.c_str(), pass.c_str());
    const uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED) { if (millis() - t0 > kWifiWaitMs) return false; delay(100); }
    return true;
}

// The WebSocket address follows the current configuration (a staged or reverted network can carry another backend address).
void refresh_uri() {
    String ssid, pass, base, ca;
    if (!ota_net_config(&ssid, &pass, &base, &ca)) return;
    String host = base; if (host.endsWith("/")) host.remove(host.length() - 1);
    g_uri = "wss://" + host.substring(8) + "/api/torqva/device/link";
}

void link_task(void*) {
    uint32_t backoff = kBackoffMinMs;
    char item[kLine];
    for (;;) {
        uint32_t connected_at = 0;
        ota_wifi_trial_tick(millis());
        refresh_uri();
        if (wifi_up()) {
            esp_websocket_client_config_t c = {};
            c.uri = g_uri.c_str();
            c.cert_pem = g_ca;                        // server certificate verified against the provisioned CA; ESP-TLS checks the host name
            c.disable_auto_reconnect = true;          // reconnecting is done below, with exponential backoff and jitter
            c.buffer_size = kRx;
            c.task_stack = 6144;
            c.pingpong_timeout_sec = 20;
            c.user_agent = "torqva-device/1";
            esp_websocket_client_handle_t h = esp_websocket_client_init(&c);
            if (h) {
                g_closed = false;
                esp_websocket_register_events(h, WEBSOCKET_EVENT_ANY, on_event, nullptr);
                if (esp_websocket_client_start(h) == ESP_OK) {
                    const uint32_t t0 = millis();
                    while (!g_up && !g_closed && millis() - t0 < kWsConnectWaitMs) delay(50);
                    if (g_up) {
                        connected_at = millis();
                        start_mdns();
                        xQueueReset(g_q);                 // nothing queued while the link was down is sent late
                        wifi_log("INFO", "Wi-Fi TLS link connected");
                        send_net_info();
                        uint32_t last_net = millis();
                        while (g_up && !g_closed && !g_reconnect_req && esp_websocket_client_is_connected(h)) {
                            ota_wifi_trial_tick(millis());
                            if (xQueueReceive(g_q, item, pdMS_TO_TICKS(50)) == pdTRUE)
                                if (esp_websocket_client_send_text(h, item, (int)strlen(item), pdMS_TO_TICKS(1000)) < 0) break;
                            if ((uint32_t)(millis() - last_net) >= 5000) {
                                last_net = millis();
                                send_net_info();
                            }
                        }
                        if (g_reconnect_req) {
                            g_reconnect_req = false;
                            WiFi.disconnect(true);
                        }
                    }
                }
                g_up = false;
                esp_websocket_client_stop(h);
                esp_websocket_client_destroy(h);
            }
        }
        if (connected_at && millis() - connected_at > kStableMs) backoff = kBackoffMinMs;        // a link that lasted resets the backoff
        delay(backoff + (esp_random() % (backoff / 2 + 1)));                                     // exponential backoff with jitter
        backoff = backoff * 2 > kBackoffMaxMs ? kBackoffMaxMs : backoff * 2;
    }
}
}  // namespace

void wifi_link_start(Device* dev, SemaphoreHandle_t mu) {
    String ssid, pass, base, ca;
    if (!ota_net_config(&ssid, &pass, &base, &ca)) return;                      // not provisioned: USB only (nothing invented)
    g_dev = dev; g_mu = mu;
    String host = base; if (host.endsWith("/")) host.remove(host.length() - 1);
    g_uri = "wss://" + host.substring(8) + "/api/torqva/device/link";            // base is https://<host>[:port], checked by ota_platform_capability
    static String ca_keep; ca_keep = ca; g_ca = ca_keep.c_str();
    g_q = xQueueCreate(24, kLine);
    xTaskCreatePinnedToCore(link_task, "link", 6144, nullptr, 1, nullptr, 0);
}

void wifi_link_send(const char* line) {
    if (!g_q || !g_up || !line) return;
    char item[kLine];
    strncpy(item, line, kLine - 1); item[kLine - 1] = 0;
    if (xQueueSend(g_q, item, 0) != pdTRUE) g_dropped++;
}

bool wifi_link_up() { return g_up; }

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
    if (g_scan_pending) return false;
    static uint32_t last = 0;
    if (last && (uint32_t)(millis() - last) < 10000u) return false;
    if (WiFi.getMode() == WIFI_OFF) WiFi.mode(WIFI_STA);
    if (WiFi.scanNetworks(true, false, false, 120) == WIFI_SCAN_FAILED) return false;           // async; hidden networks are not listed (enter the name by hand)
    last = millis(); g_scan_t0 = last; g_scan_pending = true; g_scan_collected = false; g_net_n = 0; g_net_emit = 0;
    return true;
}

void wifi_scan_poll() {
    if (!g_scan_pending) return;
    const int n = WiFi.scanComplete();
    if (n == WIFI_SCAN_RUNNING) {
        if ((uint32_t)(millis() - g_scan_t0) > 15000u) { g_scan_pending = false; WiFi.scanDelete(); emit_end(0, "SCAN_TIMEOUT"); }
        return;
    }
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
#endif
