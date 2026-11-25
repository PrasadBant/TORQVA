// SHA-256 and HMAC-SHA-256 (FIPS 180-4 / RFC 2104), self-contained so the SAME code runs in the host tests and on the target. Used for the authenticated USB session (auth.h).
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace torqva {

struct Sha256 {
    uint32_t h[8];
    uint64_t total;
    uint8_t buf[64];
    size_t used;
};

void sha256_init(Sha256* c);
void sha256_update(Sha256* c, const void* data, size_t n);
void sha256_final(Sha256* c, uint8_t out[32]);
void sha256(const void* data, size_t n, uint8_t out[32]);
void hmac_sha256(const uint8_t* key, size_t key_len, const void* msg, size_t msg_len, uint8_t out[32]);

// Lower-case hex of the first n_bytes bytes (n_bytes <= 32); out must hold 2*n_bytes+1 chars.
void to_hex(const uint8_t* in, size_t n_bytes, char* out);
// Compares two NUL-terminated strings in time independent of where they differ (length is not secret).
bool ct_equal(const char* a, const char* b);

}  // namespace torqva
