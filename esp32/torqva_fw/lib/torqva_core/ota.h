// Over-the-air application update (ESP32-S3 OTA partitions), hardware-agnostic. Isolated from motor control: it never touches the drive; the Device only
// refuses motion while an update is in progress (OTA_IN_PROGRESS) and decides, from its own state, whether an update may start at all (ota_block_reason).
//
// Flow (one update):
//   backend -> {"t":"ota","id":..,"rel":"<12 hex>","ver":"<x.y.z>","tok":"<32 hex>","seq":..,"sid":"<16 hex>","m":"<32 hex>"}   MAC over ota_canonical() with the
//              live session key, exactly like "cfg": only the authenticated backend can request an update, and only for the session it holds.
//   device  : connects to the Wi-Fi provisioned in NVS (never sent over the wire), fetches the signed MANIFEST from the HTTPS base URL provisioned in NVS
//             (the backend cannot redirect the device to another server), checks it against the request, verifies its ECDSA P-256 signature with the public key
//             compiled into this firmware, streams the image into the INACTIVE OTA partition while hashing it, compares size and SHA-256, checks the image header,
//             selects the new partition for the next boot only after every check passed, records the attempt and restarts.
//   next boot: the new image starts PENDING_VERIFY (bootloader rollback is enabled). ota_selftest() decides: confirm only when every required check passed;
//             fail -> mark invalid and restart -> the bootloader boots the previous image. A crash or reset before confirmation also rolls back.
// Every status the device reports is the state it is actually in; progress bytes are the bytes actually written.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace torqva {

enum class OtaState : uint8_t {
    IDLE, REFUSED, AUTHORIZED, PREPARING, WIFI, MANIFEST, DOWNLOADING, VERIFYING, READY, REBOOTING, SELF_TEST, CONFIRMED, ROLLBACK, FAILED
};
const char* ota_state_name(OtaState s);

// The authenticated request (parsed from the "ota" line).
struct OtaRequest {
    uint32_t id, seq;
    char rel[13];          // release id: 12 lower-case hex
    char ver[24];          // expected version
    char tok[33];          // one-time download token issued by the backend for this deployment
    char sid[33], mac[33];
};
bool is_ota_line(const char* line);
const char* parse_ota(const char* line, OtaRequest* out);              // nullptr = well-formed
void ota_canonical(const OtaRequest& r, char* out, size_t n);           // ota|id|seq|sid|rel|ver|tok

// The signed manifest the device downloads. The signature covers torqva-fw|1|<ver>|<size>|<sha256 hex>|<chip>.
struct OtaManifest {
    char rel[13], ver[24], chip[16], sha256[65], sig[160];
    uint32_t size;
};
const char* parse_manifest(const char* json, OtaManifest* out);
void manifest_canonical(const OtaManifest& m, char* out, size_t n);

// Semantic version "MAJOR.MINOR.PATCH[-suffix]". -1 / 0 / +1; returns -2 when either string is not a version. A suffixed build sorts before the same plain version.
int version_compare(const char* a, const char* b);

// Platform services (ESP32: WiFi, WiFiClientSecure + HTTPClient, Update, mbedTLS; host tests: a fake). All calls may block; they run in the OTA task, never in the control task.
class OtaPort {
public:
    virtual ~OtaPort() {}
    virtual bool wifi_connect() = 0;                                       // provisioned SSID; false = not reachable
    virtual void wifi_disconnect() = 0;
    virtual bool fetch_manifest(const OtaRequest& r, char* out, size_t cap) = 0;   // HTTPS GET <base>/.../manifest?t=<tok>; TLS verified against the provisioned CA
    virtual bool open_image(const OtaRequest& r, uint32_t* content_length) = 0;   // HTTPS GET <base>/.../image?t=<tok>
    virtual int read_image(uint8_t* buf, size_t n) = 0;                    // >0 bytes, 0 = end of stream, <0 = error / interrupted
    virtual void close_image() = 0;
    virtual uint32_t inactive_partition_size() = 0;                        // 0 = no inactive OTA partition
    virtual bool flash_begin(uint32_t size) = 0;                           // erase/prepare the INACTIVE partition (never the running one)
    virtual bool flash_write(const uint8_t* buf, size_t n) = 0;
    virtual bool flash_finish_and_select() = 0;                            // validate + set it as the next boot partition
    virtual void flash_abort() = 0;                                        // the running image stays the boot image
    virtual bool verify_signature(const char* message, const char* sig_b64) = 0;   // ECDSA P-256 / SHA-256, public key compiled into the firmware
    virtual bool record_attempt(const char* rel, const char* ver) = 0;     // persisted before the restart, read by the next boot
    virtual void restart() = 0;
};

struct OtaProgress {
    OtaState state;
    const char* reason;    // static string; "" when none
    uint32_t bytes, total;
};
typedef void (*OtaSink)(const OtaProgress& p, void* ctx);

// The image header checks the device repeats on the first bytes it receives (the bootloader and Update check again): magic 0xE9 and chip id 9 (ESP32-S3).
const char* check_image_header(const uint8_t* b, size_t n);

// Runs one update to completion (blocking). Returns nullptr when the new image is selected and the device is about to restart; otherwise the failure reason
// (the running image remains the boot image). `running_ver` is this firmware's version; a manifest that is not newer is refused (DOWNGRADE_REFUSED).
const char* ota_run(const OtaRequest& req, const char* running_ver, OtaPort& port, OtaSink sink, void* ctx);

// First boot of a new image (state PENDING_VERIFY). Every field must be true to confirm. Returns nullptr = confirm, else the first failing check (roll back).
struct SelfTestInputs {
    bool device_initialised;      // Device constructed, NVS read
    bool sensors_initialised;     // INA219 answered and at least one DS18B20 found
    bool identity_and_key;        // a real device id and a provisioned authentication key
    bool host_link;               // a line from the host was received after boot (proves the USB link)
    bool safety_initialised;      // safety monitor running and not latched by a boot fault
    bool estop_input_read;        // the E-stop input has been read and debounced (not UNKNOWN)
    bool outputs_disabled;        // driver enables and PWM read back as off
    bool watchdog_active;         // control task registered with the task watchdog
    bool ota_healthy;             // OTA configuration still valid in this image (partitions, key, provisioning)
    bool motion_unavailable;      // LED bench profile only: motor control compiled out and the motor outputs read back as off
};
const char* ota_selftest(const SelfTestInputs& s);
// The LED bench profile's first-boot check: everything above except the sensors and the E-stop input (that board has neither), plus motion_unavailable.
const char* ota_selftest_bench(const SelfTestInputs& s);

// What the last recorded attempt became, decided at boot from facts the platform reads (no guess):
//   NONE         no attempt recorded
//   SELF_TEST    the attempted version is running and the bootloader marks it PENDING_VERIFY: run ota_selftest()
//   CONFIRMED    the attempted version is running and already confirmed (e.g. a later normal reboot)
//   ROLLED_BACK  a different version is running: the new image failed its self-test, crashed or was reset before confirmation, and the bootloader went back
enum class BootOutcome : uint8_t { NONE, SELF_TEST, CONFIRMED, ROLLED_BACK };
BootOutcome ota_boot_outcome(bool attempt_recorded, const char* attempt_ver, const char* running_ver, bool pending_verify);

// Status line encoders (JSON lines, additive to protocol 1). Like every frame they carry the device's one gapless sequence counter and its millisecond clock.
size_t encode_ota_status(char* buf, size_t n, const OtaProgress& p, const char* rel, const char* ver, uint32_t req_id, uint32_t seq, uint32_t ts_ms);
struct OtaInfo {
    bool capable; const char* why;          // why OTA is not available ("" when capable)
    const char* running;                    // "ota_0" / "ota_1" / "factory" / "?"
    uint32_t inactive_size;
    bool pending_verify;                    // this boot is an unconfirmed new image
    const char* last_result;                // "" | CONFIRMED | ROLLED_BACK | FAILED
    const char* last_ver;                   // version of the last attempt ("" none)
    const char* block;                      // why an update would be refused right now ("" = eligible)
    bool busy;
    const char* profile;                    // "" production; "ota_led_bench" for the LED bench profile (then sent as "prof"; production frames are unchanged)
};
size_t encode_ota_info(char* buf, size_t n, const OtaInfo& i, uint32_t seq, uint32_t ts_ms);

}  // namespace torqva
