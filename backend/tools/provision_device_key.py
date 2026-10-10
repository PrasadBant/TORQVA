"""Provision a per-device authentication key (offline; run it yourself, deliberately).

    python tools/provision_device_key.py --device-id RIG-1 --out-dir <empty private folder>

What it does: creates a random 32-byte key, stores it in the backend key file (backend/data/device_keys.json, or TORQVA_DEVICE_KEYS_FILE), and writes an NVS image source
(`nvs_torqva.csv`, SECRET) for the device. It PRINTS the commands that would build and write the NVS image; it does not run them, flash anything or open a serial port.
Delete the CSV and any .bin afterwards; the backend copy is the only copy you need to keep.

The firmware reads namespace "torqva", key "authkey" (32 bytes). The device id compiled into the firmware (-DTORQVA_DEVICE_ID) must equal --device-id: the id is part of
every handshake proof, so a mismatch simply fails authentication.
"""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from torqva.device_keys import KeyStore, KeyStoreError  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--device-id", required=True)
    ap.add_argument("--out-dir", required=True, help="private, empty folder for the secret NVS csv")
    ap.add_argument("--rotate", action="store_true", help="replace an existing key (the device must be re-provisioned)")
    a = ap.parse_args()
    store_path = os.environ.get("TORQVA_DEVICE_KEYS_FILE") or str(Path(__file__).resolve().parents[1] / "data" / "device_keys.json")
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        print("refusing: --out-dir is not empty", file=sys.stderr)
        return 2
    try:
        key = KeyStore(store_path).provision(a.device_id, rotate=a.rotate)
    except KeyStoreError as e:
        print(f"refusing: {e}", file=sys.stderr)
        return 2
    csv = out / "nvs_torqva.csv"
    csv.write_text(f"key,type,encoding,value\ntorqva,namespace,,\nauthkey,data,hex2bin,{key.hex()}\n", encoding="utf-8")
    try:
        os.chmod(csv, 0o600)
    except OSError:
        pass
    print(f"key stored for {a.device_id} in {store_path}")
    print(f"SECRET NVS source written: {csv}   (delete it after use)")
    print("Commands to run yourself when (and only when) flashing is authorised; the default Arduino-ESP32 partition table has NVS at 0x9000, size 0x5000:")
    print(f"  python -m esp_idf_nvs_partition_gen generate {csv} {out / 'nvs_torqva.bin'} 0x5000")
    print(f"  python -m esptool --chip esp32s3 --port <COM port> write_flash 0x9000 {out / 'nvs_torqva.bin'}")
    print(f"Build the firmware with -DTORQVA_DEVICE_ID=\\\"{a.device_id}\\\". Authentication also needs the build flag TORQVA_TRANSPORT_SECURED=1 before the firmware will treat the link as secured (a human decision).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
