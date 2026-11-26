"""ESP-IDF NVS partition read/write helpers for TORQVA Wi-Fi provisioning.

Why this module exists
----------------------
The ESP32 keeps its Wi-Fi SSID/password, backend URL, CA certificate and device
authentication key in the NVS partition (0x9000, 0x5000 bytes). Writing that
partition is a whole-partition operation: an image that lists only the keys
TORQVA knows about would erase every other namespace on the board, including the
OTA last-known-good record that recovery depends on. This module therefore:

* parses the board's current NVS image strictly (any corruption or unknown entry
  type raises ``NvsError``; nothing is guessed), so unrelated entries can be kept;
* encodes the merged image in memory with the supported generator
  (``esp_idf_nvs_partition_gen``), so no CSV containing the Wi-Fi password or the
  device key is ever written to disk.

Layout reference (ESP-IDF NVS, version 2): 4096-byte pages; each page has a
32-byte header (state, sequence number, version, CRC32 over bytes 4..27), a
32-byte bitmap (2 bits per entry), then 126 entries of 32 bytes. An entry is
``ns_index, type, span, chunk_index, crc32, key[16], data[8]``. Strings and blobs
continue over ``span - 1`` following entries.
"""
from __future__ import annotations

import io
import struct
import zlib
from dataclasses import dataclass
from typing import Dict, Iterable, List, Tuple

NVS_OFFSET = 0x9000          # from the pinned partition table (default_8MB.csv)
NVS_SIZE = 0x5000

PAGE_SIZE = 4096
ENTRY_SIZE = 32
ENTRIES_PER_PAGE = 126
FIRST_ENTRY_OFFSET = 64      # 32-byte page header + 32-byte entry bitmap

PAGE_ACTIVE = 0xFFFFFFFE
PAGE_FULL = 0xFFFFFFFC
PAGE_FREEING = 0xFFFFFFF8
PAGE_EMPTY = 0xFFFFFFFF
_VALID_PAGE_STATES = (PAGE_ACTIVE, PAGE_FULL, PAGE_FREEING)

ENTRY_WRITTEN = 0b10
ENTRY_EMPTY = 0b11

TYPE_SZ = 0x21               # NUL-terminated string (may span entries)
TYPE_BLOB_IDX = 0x48         # index of a blob split into BLOB_DATA chunks
TYPE_BLOB_DATA = 0x42        # one blob chunk
_PRIMITIVES = {                # type -> (encoding name, struct format)
    0x01: ("u8", "<B"), 0x11: ("i8", "<b"),
    0x02: ("u16", "<H"), 0x12: ("i16", "<h"),
    0x04: ("u32", "<I"), 0x14: ("i32", "<i"),
    0x08: ("u64", "<Q"), 0x18: ("i64", "<q"),
}
_ENCODING_TO_TYPE = {enc: t for t, (enc, _) in _PRIMITIVES.items()}


class NvsError(RuntimeError):
    """The NVS image is corrupt or contains something this module does not understand."""


@dataclass(frozen=True)
class NvsEntry:
    namespace: str
    key: str
    encoding: str   # generator encoding: u8..i64, string, hex2bin
    value: str      # canonical text form: integers in decimal, strings as-is, blobs as lowercase hex


def _entry_crc(entry: bytes) -> int:
    return zlib.crc32(entry[0:4] + entry[8:32], 0xFFFFFFFF) & 0xFFFFFFFF


def _entry_state(bitmap: bytes, index: int) -> int:
    return (bitmap[index // 4] >> ((index % 4) * 2)) & 0b11


def parse_partition(image: bytes) -> Dict[Tuple[str, str], NvsEntry]:
    """Return every live (namespace, key) of an NVS image, newest write wins.

    Raises ``NvsError`` on any CRC mismatch, invalid page state, malformed span or
    unsupported entry type. Callers must treat that as "do not rewrite".
    """
    if len(image) == 0 or len(image) % PAGE_SIZE:
        raise NvsError("NVS image size is not a whole number of pages")

    pages: List[Tuple[int, int]] = []          # (sequence, page base)
    for base in range(0, len(image), PAGE_SIZE):
        state, seq = struct.unpack_from("<II", image, base)
        if state == PAGE_EMPTY:
            continue
        if state not in _VALID_PAGE_STATES:
            raise NvsError(f"NVS page at 0x{base:x} has an invalid state 0x{state:08x}")
        (stored_crc,) = struct.unpack_from("<I", image, base + 28)
        if zlib.crc32(image[base + 4:base + 28], 0xFFFFFFFF) & 0xFFFFFFFF != stored_crc:
            raise NvsError(f"NVS page header CRC mismatch at 0x{base:x}")
        pages.append((seq, base))
    pages.sort()

    namespaces: Dict[int, str] = {}
    items: List[dict] = []                      # every written item, in page order (oldest page first)
    for seq, base in pages:
        bitmap = image[base + 32:base + 64]
        index = 0
        while index < ENTRIES_PER_PAGE:
            if _entry_state(bitmap, index) != ENTRY_WRITTEN:
                index += 1
                continue
            off = base + FIRST_ENTRY_OFFSET + index * ENTRY_SIZE
            entry = image[off:off + ENTRY_SIZE]
            ns, typ, span, chunk = entry[0], entry[1], entry[2], entry[3]
            (stored,) = struct.unpack_from("<I", entry, 4)
            if _entry_crc(entry) != stored:
                raise NvsError(f"NVS entry CRC mismatch at page 0x{base:x} entry {index}")
            if span < 1 or index + span > ENTRIES_PER_PAGE:
                raise NvsError(f"NVS entry {index} on page 0x{base:x} has an invalid span {span}")
            try:
                key = entry[8:24].split(b"\0", 1)[0].decode("ascii")
            except UnicodeDecodeError as exc:
                raise NvsError(f"NVS key on page 0x{base:x} entry {index} is not ASCII") from exc
            data = entry[24:32]
            item = {"seq": seq, "base": base, "index": index, "ns": ns, "type": typ, "span": span, "chunk": chunk, "key": key}
            if ns == 0 and typ == 0x01:                              # namespace definition
                namespaces[data[0]] = key
            elif typ in _PRIMITIVES:
                if span != 1:
                    raise NvsError(f"primitive entry {key!r} has span {span}")
                item["value"] = str(struct.unpack_from(_PRIMITIVES[typ][1], data, 0)[0])
                item["encoding"] = _PRIMITIVES[typ][0]
            elif typ in (TYPE_SZ, TYPE_BLOB_DATA):
                size = struct.unpack_from("<H", data, 0)[0]
                payload = image[base + FIRST_ENTRY_OFFSET + (index + 1) * ENTRY_SIZE:
                                base + FIRST_ENTRY_OFFSET + (index + span) * ENTRY_SIZE]
                if size > len(payload):
                    raise NvsError(f"entry {key!r} declares {size} bytes but spans only {len(payload)}")
                payload = payload[:size]
                (stored_data_crc,) = struct.unpack_from("<I", data, 4)
                if zlib.crc32(payload, 0xFFFFFFFF) & 0xFFFFFFFF != stored_data_crc:
                    raise NvsError(f"NVS data CRC mismatch for {key!r}")
                item["payload"] = payload
            elif typ == TYPE_BLOB_IDX:
                if span != 1:
                    raise NvsError(f"blob index {key!r} has span {span}")
                item["blob_size"], item["chunk_count"], item["chunk_start"] = struct.unpack_from("<IBB", data, 0)
            else:
                raise NvsError(f"unsupported NVS entry type 0x{typ:02x} for key {key!r}")
            items.append(item)
            index += span

    result: Dict[Tuple[str, str], NvsEntry] = {}
    for item in items:
        if item["ns"] == 0 and item["type"] == 0x01:
            continue
        if item["type"] == TYPE_BLOB_DATA:
            continue                                                 # resolved through its blob index
        ns_name = namespaces.get(item["ns"])
        if ns_name is None:
            raise NvsError(f"entry {item['key']!r} references an undefined namespace index {item['ns']}")
        if item["type"] in _PRIMITIVES:
            value, encoding = item["value"], item["encoding"]
        elif item["type"] == TYPE_SZ:
            try:
                value = item["payload"].rstrip(b"\0").decode("utf-8")
            except UnicodeDecodeError as exc:
                raise NvsError(f"string {item['key']!r} is not UTF-8") from exc
            encoding = "string"
        else:                                                        # TYPE_BLOB_IDX
            # An interrupted rewrite (a reset while the board saved a blob) can leave an older written copy of an index or of a chunk next to the newest
            # one. The newest copy wins, as it does for the firmware's own lookups: the last index for a key, and for each chunk the latest copy written
            # before that index (data is always written before its index).
            pos = items.index(item)
            if any(later["type"] == TYPE_BLOB_IDX and later["ns"] == item["ns"] and later["key"] == item["key"] for later in items[pos + 1:]):
                continue                                             # a newer index for this blob exists: this one is stale
            chunks = []
            for ci in range(item["chunk_start"], item["chunk_start"] + item["chunk_count"]):
                cands = [i for i, c in enumerate(items) if c["type"] == TYPE_BLOB_DATA and c["ns"] == item["ns"] and c["key"] == item["key"] and c["chunk"] == ci]
                before = [i for i in cands if i < pos]
                pick = (before or cands or [None])[-1]
                if pick is not None:
                    chunks.append(items[pick])
            if len(chunks) != item["chunk_count"]:
                raise NvsError(f"blob {item['key']!r} is missing chunks ({len(chunks)} of {item['chunk_count']})")
            blob = b"".join(c["payload"] for c in sorted(chunks, key=lambda c: c["chunk"]))
            if len(blob) != item["blob_size"]:
                raise NvsError(f"blob {item['key']!r} reassembled to {len(blob)} bytes, expected {item['blob_size']}")
            value, encoding = blob.hex(), "hex2bin"
        result[(ns_name, item["key"])] = NvsEntry(ns_name, item["key"], encoding, value)
    return result


def encode_partition(entries: Iterable[NvsEntry], size: int = NVS_SIZE) -> bytes:
    """Encode entries as an NVS image of exactly ``size`` bytes using the supported generator.

    The generator's CLI reserves one page for itself (``check_size``), so the
    in-memory call is given ``size - PAGE_SIZE`` to produce the same bytes the CLI
    would. Entries are grouped by namespace, in the order given.
    """
    from esp_idf_nvs_partition_gen.nvs_partition_gen import Page, nvs_close, nvs_open, write_entry

    buf = io.BytesIO()
    nvs = nvs_open(buf, size - PAGE_SIZE, Page.VERSION2)
    current = None
    for e in entries:
        if e.namespace != current:
            write_entry(nvs, e.namespace, "namespace", "", "")
            current = e.namespace
        write_entry(nvs, e.key, "data", e.encoding, e.value)
    nvs_close(nvs)
    image = buf.getvalue()
    if len(image) != size:
        raise NvsError(f"generated NVS image is {len(image)} bytes, expected {size}")
    return image


def logical_view(entries: Dict[Tuple[str, str], NvsEntry]) -> Dict[Tuple[str, str], Tuple[str, str]]:
    """Comparable (encoding, value) view used for read-back verification."""
    return {k: (v.encoding, v.value) for k, v in entries.items()}
