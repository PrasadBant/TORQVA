"""Provision a device for over-the-air updates (offline; run it yourself, deliberately). Nothing here flashes, uploads or opens a port.

    python tools/provision_ota.py --ssid BENCH-WIFI --base-url https://ota.bench.lan --ca <ca.pem> --out-dir <empty private folder>
        (the Wi-Fi password is asked for; it is never an argument)

Writes nvs_torqva_ota.csv (SECRET: it holds the Wi-Fi password), namespace "torqva_ota", keys ssid, pass, base, ca - the values the firmware reads
(src/ota_esp32.cpp). The base URL must be the HTTPS address at which the DEVICE reaches the backend (TORQVA_OTA_PUBLIC_BASE_URL on the backend): never
localhost or 127.0.0.1. The CA file is the certificate (chain root) the device uses to verify that server; TLS verification is never disabled.

The NVS partition holds the authentication key too (tools/provision_device_key.py). Writing a new NVS image replaces the whole partition, so build ONE
image from both CSV files (concatenate them, keeping one header line), then write it with the commands printed below. Delete the CSV and .bin afterwards.
"""
import argparse
import getpass
import re
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ssid", required=True)
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--ca", required=True, help="PEM certificate the device trusts for the base URL")
    ap.add_argument("--out-dir", required=True)
    a = ap.parse_args()
    host = re.sub(r"^https://", "", a.base_url).split("/", 1)[0].rsplit(":", 1)[0].lower().strip("[]")
    if not a.base_url.startswith("https://") or not host or host in ("localhost", "0.0.0.0", "::1") or host.startswith("127."):
        print("refusing: --base-url must be an https:// address the device can reach (not localhost / 127.0.0.1)", file=sys.stderr)
        return 2
    ca = Path(a.ca).read_text(encoding="ascii").strip()
    if "-----BEGIN CERTIFICATE-----" not in ca or "PRIVATE KEY" in ca:
        print("refusing: --ca must be a PEM certificate (and never a private key)", file=sys.stderr)
        return 2
    if len(ca) > 3900:
        print("refusing: the CA certificate is larger than one NVS string (4000 bytes); use the root certificate only", file=sys.stderr)
        return 2
    if len(a.ssid) > 32 or not a.ssid:
        print("refusing: an SSID is 1-32 characters", file=sys.stderr)
        return 2
    pw = getpass.getpass("Wi-Fi password: ")
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        print("refusing: --out-dir is not empty", file=sys.stderr)
        return 2

    def q(v: str) -> str:
        return '"' + v.replace('"', '""') + '"'

    csv = out / "nvs_torqva_ota.csv"
    csv.write_text("key,type,encoding,value\ntorqva_ota,namespace,,\n"
                   f"ssid,data,string,{q(a.ssid)}\npass,data,string,{q(pw)}\nbase,data,string,{q(a.base_url.rstrip('/'))}\nca,data,string,{q(ca)}\n", encoding="utf-8")
    print(f"written: {csv} (SECRET: Wi-Fi password)")
    print("Next, by hand (NOT run by this tool), after merging with the authentication-key CSV:")
    print("  python -m esp_idf_nvs_partition_gen generate nvs_merged.csv nvs.bin 0x5000      (pip install esp-idf-nvs-partition-gen)")
    print("  python -m esptool --chip esp32s3 --port <COMx> write_flash 0x9000 nvs.bin")
    print("The nvs partition is at 0x9000, 20 KB (0x5000) in default_8MB.csv. Then delete the CSV files and nvs.bin.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
