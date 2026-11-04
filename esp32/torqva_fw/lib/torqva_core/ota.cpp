#include "ota.h"
#include "sha256.h"
#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace torqva {

const char* ota_state_name(OtaState s) {
    switch (s) {
        case OtaState::IDLE: return "IDLE";
        case OtaState::REFUSED: return "REFUSED";
        case OtaState::AUTHORIZED: return "AUTHORIZED";
        case OtaState::PREPARING: return "PREPARING";
        case OtaState::WIFI: return "WIFI";
        case OtaState::MANIFEST: return "MANIFEST";
        case OtaState::DOWNLOADING: return "DOWNLOADING";
        case OtaState::VERIFYING: return "VERIFYING";
        case OtaState::READY: return "READY";
        case OtaState::REBOOTING: return "REBOOTING";
        case OtaState::SELF_TEST: return "SELF_TEST";
        case OtaState::CONFIRMED: return "CONFIRMED";
        case OtaState::ROLLBACK: return "ROLLBACK";
        case OtaState::FAILED: return "FAILED";
    }
    return "?";
}

// ---- minimal JSON field readers (flat objects of strings and numbers, as produced by the backend)
static const char* find_key(const char* s, const char* key) {
    char pat[24];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char* p = strstr(s, pat);
    if (!p) return nullptr;
    p += strlen(pat);
    while (*p == ' ') p++;
    if (*p != ':') return nullptr;
    p++;
    while (*p == ' ') p++;
    return p;
}
static bool str_of(const char* s, const char* key, char* out, size_t cap) {
    const char* p = find_key(s, key);
    if (!p || *p != '"') return false;
    p++;
    size_t n = 0;
    while (*p && *p != '"') {
        if (*p == '\\' || (unsigned char)*p < 0x20) return false;        // no escapes or control characters in any field we accept
        if (n + 1 >= cap) return false;
        out[n++] = *p++;
    }
    if (*p != '"') return false;
    out[n] = 0;
    return true;
}
static bool num_of(const char* s, const char* key, double* out) {
    const char* p = find_key(s, key);
    if (!p) return false;
    char* end = nullptr;
    const double v = strtod(p, &end);
    if (end == p || !isfinite(v)) return false;
    *out = v;
    return true;
}
static bool is_hex(const char* s, size_t len) {
    if (strlen(s) != len) return false;
    for (size_t i = 0; i < len; i++) if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
    return true;
}
static bool is_version(const char* s) {
    // MAJOR.MINOR.PATCH with an optional -suffix of [A-Za-z0-9.]
    int dots = 0; bool digit = false; size_t i = 0;
    for (; s[i] && s[i] != '-'; i++) {
        if (s[i] == '.') { if (!digit) return false; dots++; digit = false; }
        else if (isdigit((unsigned char)s[i])) digit = true;
        else return false;
    }
    if (dots != 2 || !digit) return false;
    if (s[i] == '-') { i++; if (!s[i]) return false; for (; s[i]; i++) if (!isalnum((unsigned char)s[i]) && s[i] != '.') return false; }
    return true;
}

bool is_ota_line(const char* line) {
    char t[8];
    return line && str_of(line, "t", t, sizeof(t)) && strcmp(t, "ota") == 0;
}

const char* parse_ota(const char* line, OtaRequest* r) {
    if (!line || !r) return "NULL";
    memset(r, 0, sizeof(*r));
    if (strlen(line) > 250) return "LINE_TOO_LONG";
    double id, seq;
    if (!num_of(line, "id", &id) || id < 0 || id > 4294967295.0 || id != floor(id)) return "BAD_ID";
    if (!num_of(line, "seq", &seq) || seq < 0 || seq > 4294967295.0 || seq != floor(seq)) return "BAD_SEQ";
    if (!str_of(line, "rel", r->rel, sizeof(r->rel)) || !is_hex(r->rel, 12)) return "BAD_RELEASE";
    if (!str_of(line, "ver", r->ver, sizeof(r->ver)) || !is_version(r->ver)) return "BAD_VERSION";
    if (!str_of(line, "tok", r->tok, sizeof(r->tok)) || !is_hex(r->tok, 32)) return "BAD_TOKEN";
    if (!str_of(line, "sid", r->sid, sizeof(r->sid)) || !str_of(line, "m", r->mac, sizeof(r->mac))) return "BAD_AUTH_FIELDS";
    r->id = (uint32_t)id; r->seq = (uint32_t)seq;
    return nullptr;
}

void ota_canonical(const OtaRequest& r, char* out, size_t n) {
    snprintf(out, n, "ota|%lu|%lu|%s|%s|%s|%s", (unsigned long)r.id, (unsigned long)r.seq, r.sid, r.rel, r.ver, r.tok);
}

const char* parse_manifest(const char* json, OtaManifest* m) {
    if (!json || !m) return "NULL";
    memset(m, 0, sizeof(*m));
    double size;
    if (!str_of(json, "rel", m->rel, sizeof(m->rel)) || !is_hex(m->rel, 12)) return "MANIFEST_INVALID";
    if (!str_of(json, "ver", m->ver, sizeof(m->ver)) || !is_version(m->ver)) return "MANIFEST_INVALID";
    if (!str_of(json, "chip", m->chip, sizeof(m->chip))) return "MANIFEST_INVALID";
    if (!str_of(json, "sha256", m->sha256, sizeof(m->sha256)) || !is_hex(m->sha256, 64)) return "MANIFEST_INVALID";
    if (!str_of(json, "sig", m->sig, sizeof(m->sig)) || !m->sig[0]) return "MANIFEST_INVALID";
    if (!num_of(json, "size", &size) || size < 1 || size > 4294967295.0 || size != floor(size)) return "MANIFEST_INVALID";
    m->size = (uint32_t)size;
    return nullptr;
}

void manifest_canonical(const OtaManifest& m, char* out, size_t n) {
    snprintf(out, n, "torqva-fw|1|%s|%lu|%s|%s", m.ver, (unsigned long)m.size, m.sha256, m.chip);
}

static bool parse_ver(const char* s, long v[3], bool* suffix) {
    if (!s || !is_version(s)) return false;
    char* e = nullptr;
    const char* p = s;
    for (int i = 0; i < 3; i++) { v[i] = strtol(p, &e, 10); p = e + (i < 2 ? 1 : 0); }
    *suffix = (*e == '-');
    return true;
}

int version_compare(const char* a, const char* b) {
    long x[3], y[3]; bool sx, sy;
    if (!parse_ver(a, x, &sx) || !parse_ver(b, y, &sy)) return -2;
    for (int i = 0; i < 3; i++) { if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1; }
    if (sx != sy) return sx ? -1 : 1;       // 3.1.0-dev < 3.1.0
    if (sx && sy) { const int c = strcmp(strchr(a, '-'), strchr(b, '-')); return c < 0 ? -1 : (c > 0 ? 1 : 0); }
    return 0;
}

const char* check_image_header(const uint8_t* b, size_t n) {
    if (n < 24) return "INVALID_IMAGE";
    if (b[0] != 0xE9) return "INVALID_IMAGE";                       // ESP application image magic
    const uint16_t chip = (uint16_t)(b[12] | (b[13] << 8));         // esp_image_header_t.chip_id
    if (chip != 9) return "WRONG_CHIP";                              // 9 = ESP32-S3
    return nullptr;
}

static void emit(OtaSink sink, void* ctx, OtaState s, const char* why, uint32_t bytes, uint32_t total) {
    if (!sink) return;
    OtaProgress p = {s, why ? why : "", bytes, total};
    sink(p, ctx);
}

const char* ota_run(const OtaRequest& req, const char* running_ver, OtaPort& port, OtaSink sink, void* ctx) {
    const char* why = nullptr;
    emit(sink, ctx, OtaState::PREPARING, "", 0, 0);
    const uint32_t slot = port.inactive_partition_size();
    if (slot == 0) { why = "NO_INACTIVE_PARTITION"; emit(sink, ctx, OtaState::FAILED, why, 0, 0); return why; }

    emit(sink, ctx, OtaState::WIFI, "", 0, 0);
    if (!port.wifi_connect()) { why = "WIFI_UNAVAILABLE"; emit(sink, ctx, OtaState::FAILED, why, 0, 0); return why; }

    emit(sink, ctx, OtaState::MANIFEST, "", 0, 0);
    static char text[640];
    OtaManifest m;
    if (!port.fetch_manifest(req, text, sizeof(text))) why = "SERVER_UNAVAILABLE";
    else if ((why = parse_manifest(text, &m)) != nullptr) {}
    else if (strcmp(m.rel, req.rel) != 0 || strcmp(m.ver, req.ver) != 0) why = "MANIFEST_MISMATCH";       // the manifest must be the release the authenticated request named
    else if (strcmp(m.chip, "esp32s3") != 0) why = "WRONG_CHIP";
    else if (m.size > slot) why = "IMAGE_TOO_LARGE";
    else if (version_compare(m.ver, running_ver) != 1) why = "DOWNGRADE_REFUSED";                        // equal or older: never reinstalled or downgraded over the air
    else {
        char canon[160];
        manifest_canonical(m, canon, sizeof(canon));
        if (!port.verify_signature(canon, m.sig)) why = "SIGNATURE_INVALID";
    }
    if (why) { port.wifi_disconnect(); emit(sink, ctx, OtaState::FAILED, why, 0, 0); return why; }

    uint32_t clen = 0;
    if (!port.open_image(req, &clen)) why = "SERVER_UNAVAILABLE";
    else if (clen != m.size) why = "SIZE_MISMATCH";
    else if (!port.flash_begin(m.size)) why = "FLASH_BEGIN_FAILED";
    if (why) { port.close_image(); port.wifi_disconnect(); emit(sink, ctx, OtaState::FAILED, why, 0, m.size); return why; }

    Sha256 h; sha256_init(&h);
    static uint8_t buf[4096];
    uint32_t got = 0;
    bool header_checked = false;
    uint8_t head[24]; size_t head_n = 0;
    uint32_t last_report = 0;
    emit(sink, ctx, OtaState::DOWNLOADING, "", 0, m.size);
    for (;;) {
        const int r = port.read_image(buf, sizeof(buf));
        if (r < 0) { why = "DOWNLOAD_INTERRUPTED"; break; }
        if (r == 0) break;
        if (got + (uint32_t)r > m.size) { why = "SIZE_MISMATCH"; break; }
        if (!header_checked) {
            const size_t take = (size_t)r < sizeof(head) - head_n ? (size_t)r : sizeof(head) - head_n;
            memcpy(head + head_n, buf, take); head_n += take;
            if (head_n == sizeof(head)) { header_checked = true; if ((why = check_image_header(head, head_n)) != nullptr) break; }
        }
        if (!port.flash_write(buf, (size_t)r)) { why = "FLASH_WRITE_FAILED"; break; }
        sha256_update(&h, buf, (size_t)r);
        got += (uint32_t)r;
        if (got - last_report >= 65536 || got == m.size) { last_report = got; emit(sink, ctx, OtaState::DOWNLOADING, "", got, m.size); }
    }
    port.close_image();
    port.wifi_disconnect();
    if (!why && got != m.size) why = "DOWNLOAD_INTERRUPTED";
    if (!why && !header_checked) why = "INVALID_IMAGE";
    if (!why) {
        emit(sink, ctx, OtaState::VERIFYING, "", got, m.size);
        uint8_t d[32]; char hex[65];
        sha256_final(&h, d); to_hex(d, 32, hex);
        if (strcmp(hex, m.sha256) != 0) why = "CHECKSUM_MISMATCH";
    }
    if (why) { port.flash_abort(); emit(sink, ctx, OtaState::FAILED, why, got, m.size); return why; }
    if (!port.flash_finish_and_select()) { why = "BOOT_SELECT_FAILED"; port.flash_abort(); emit(sink, ctx, OtaState::FAILED, why, got, m.size); return why; }
    emit(sink, ctx, OtaState::READY, "", got, m.size);
    if (!port.record_attempt(m.rel, m.ver)) {
        // The new image is already selected: without the record the next boot cannot report the result, but it still self-tests and rolls back on failure.
        emit(sink, ctx, OtaState::READY, "ATTEMPT_NOT_RECORDED", got, m.size);
    }
    emit(sink, ctx, OtaState::REBOOTING, "", got, m.size);
    port.restart();
    return nullptr;
}

const char* ota_selftest(const SelfTestInputs& s) {
    if (!s.device_initialised) return "DEVICE_INIT";
    if (!s.outputs_disabled) return "OUTPUTS_NOT_DISABLED";
    if (!s.safety_initialised) return "SAFETY_INIT";
    if (!s.watchdog_active) return "WATCHDOG";
    if (!s.estop_input_read) return "ESTOP_INPUT";
    if (!s.sensors_initialised) return "SENSORS";
    if (!s.identity_and_key) return "IDENTITY";
    if (!s.ota_healthy) return "OTA_CONFIG";
    if (!s.host_link) return "HOST_LINK";
    return nullptr;
}

BootOutcome ota_boot_outcome(bool attempt_recorded, const char* attempt_ver, const char* running_ver, bool pending_verify) {
    if (!attempt_recorded || !attempt_ver || !attempt_ver[0] || !running_ver) return BootOutcome::NONE;
    if (strcmp(attempt_ver, running_ver) != 0) return BootOutcome::ROLLED_BACK;
    return pending_verify ? BootOutcome::SELF_TEST : BootOutcome::CONFIRMED;
}

size_t encode_ota_status(char* buf, size_t n, const OtaProgress& p, const char* rel, const char* ver, uint32_t req_id, uint32_t seq, uint32_t ts_ms) {
    const int w = snprintf(buf, n, "{\"t\":\"ota\",\"seq\":%lu,\"ts\":%lu,\"id\":%lu,\"st\":\"%s\",\"rel\":\"%s\",\"ver\":\"%s\",\"b\":%lu,\"n\":%lu,\"why\":\"%s\"}",
                           (unsigned long)seq, (unsigned long)ts_ms, (unsigned long)req_id, ota_state_name(p.state), rel ? rel : "", ver ? ver : "", (unsigned long)p.bytes, (unsigned long)p.total, p.reason ? p.reason : "");
    return (w > 0 && (size_t)w < n) ? (size_t)w : 0;
}

size_t encode_ota_info(char* buf, size_t n, const OtaInfo& i, uint32_t seq, uint32_t ts_ms) {
    const int w = snprintf(buf, n, "{\"t\":\"ota_info\",\"seq\":%lu,\"ts\":%lu,\"cap\":%u,\"why\":\"%s\",\"run\":\"%s\",\"psz\":%lu,\"pend\":%u,\"last\":\"%s\",\"lver\":\"%s\",\"blk\":\"%s\",\"busy\":%u}",
                           (unsigned long)seq, (unsigned long)ts_ms, i.capable ? 1u : 0u, i.why ? i.why : "", i.running ? i.running : "?", (unsigned long)i.inactive_size, i.pending_verify ? 1u : 0u,
                           i.last_result ? i.last_result : "", i.last_ver ? i.last_ver : "", i.block ? i.block : "", i.busy ? 1u : 0u);
    return (w > 0 && (size_t)w < n) ? (size_t)w : 0;
}

}  // namespace torqva
