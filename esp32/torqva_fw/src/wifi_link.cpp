// See wifi_link.h. Built only with TORQVA_WIFI_LINK=1 (OTA LED bench profile); empty otherwise.
#include "wifi_link.h"

#if defined(TORQVA_WIFI_LINK) && TORQVA_WIFI_LINK
#include <WiFi.h>
#include <esp_websocket_client.h>
#include <freertos/queue.h>
#include "ota_esp32.h"

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
volatile bool g_up = false, g_closed = false;
String g_uri;
const char* g_ca = nullptr;
char g_rx[kRx + 1];
size_t g_rx_len = 0;
uint32_t g_dropped = 0;

void feed_lines(char* buf, size_t n) {
    buf[n] = 0;
    char* p = buf;
    while (p && *p) {
        char* nl = strchr(p, '\n');
        if (nl) *nl = 0;
        const size_t len = strlen(p);
        if (len > 0 && len < 256 && xSemaphoreTake(g_mu, pdMS_TO_TICKS(200)) == pdTRUE) {   // the device's own line limit (main.cpp loop: 256)
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

bool wifi_up() {
    if (WiFi.status() == WL_CONNECTED) return true;
    String ssid, pass, base, ca;
    if (!ota_net_config(&ssid, &pass, &base, &ca)) return false;
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.begin(ssid.c_str(), pass.c_str());
    const uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED) { if (millis() - t0 > kWifiWaitMs) return false; delay(100); }
    return true;
}

void link_task(void*) {
    uint32_t backoff = kBackoffMinMs;
    char item[kLine];
    for (;;) {
        uint32_t connected_at = 0;
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
                        xQueueReset(g_q);                 // nothing queued while the link was down is sent late
                        while (g_up && !g_closed && esp_websocket_client_is_connected(h)) {
                            if (xQueueReceive(g_q, item, pdMS_TO_TICKS(50)) == pdTRUE)
                                if (esp_websocket_client_send_text(h, item, (int)strlen(item), pdMS_TO_TICKS(1000)) < 0) break;
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

#else
void wifi_link_start(torqva::Device*, SemaphoreHandle_t) {}
void wifi_link_send(const char*) {}
bool wifi_link_up() { return false; }
#endif
