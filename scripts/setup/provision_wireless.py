"""TORQVA wireless provisioning utility (offline host setup + explicit hardware write).

This script is a thin command-line front end. The NVS planning, merging, writing and verification live in ONE place, backend/torqva/device/provisioning.py, shared with the
website's "Configure Wi-Fi" panel, so there is no second implementation that could behave differently:

  * the board's current NVS partition is READ and parsed first; every entry TORQVA does not own (saved runtime limits, the OTA last-known-good record, ...) is kept;
  * the existing device authentication key is reused (a different key in NVS and in the key store is refused, never silently replaced; --rotate-key is the only way
    to change an identity);
  * the partition table is checked against the pinned layout before anything is written, only 0x9000..0xE000 is written, and the result is read back and verified;
  * the image is built in memory: no CSV or .bin containing the Wi-Fi password or the device key is written to disk when flashing.

Steps:
  1. Detect the reachable LAN IPv4 address.
  2. Create or reuse the bench TLS CA and a gateway certificate for that address (backend/torqva/device/pki.py), plus the release signing key pair (public key header
     written to firmware/src/ota_pubkey.h, git-ignored).
  3. With --flash (and --motor-power-disconnected): read -> merge -> write -> verify the board's NVS over the given serial port, then restart it.

This script cannot know whether the board's firmware supports staged network changes, so it always writes the network directly. Use the website (USB, with the board
connected) to get staged writes that keep the previous network as a fallback.
"""
from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path
from typing import Optional

REPO = Path(__file__).resolve().parents[2]
BACKEND = REPO / "backend"
sys.path.insert(0, str(BACKEND))

from torqva.access.device_keys import KeyStore  # noqa: E402
from torqva.device import pki  # noqa: E402
from torqva.device.nvs import encode_partition, parse_partition  # noqa: E402
from torqva.device.provisioning import (  # noqa: E402
    EsptoolFlash,
    ProvisioningError,
    default_secrets_dir,
    detect_lan_ip,
    plan_network_config,
    resolve_identity,
    validate_base_url,
    validate_wifi,
    write_network_config,
)

__all__ = ["default_secrets_dir", "detect_lan_ip", "ensure_tls_certs", "ensure_signing_keys", "build_nvs_image", "main"]


def ensure_tls_certs(secrets_dir: Path, lan_ip: str) -> dict:
    return pki.ensure_tls_certs(secrets_dir, lan_ip)


def ensure_signing_keys(secrets_dir: Path, export_header: bool = True) -> dict:
    return pki.ensure_signing_keys(secrets_dir, REPO / "firmware" / "src" / "ota_pubkey.h" if export_header else None)


def build_nvs_image(
    *,
    device_id: str,
    ssid: str,
    password: str,
    base_url: str,
    ca_pem_path: Path,
    keys_file: Path,
    out_bin: Path,
    rotate_device_key: bool = False,
    existing_nvs: Optional[bytes] = None,
) -> Path:
    """Offline image for inspection or a manual write. With ``existing_nvs`` (a dump of the board's partition) every unrelated entry is merged in; without it the image is
    for a BLANK board. Re-provisioning network trust preserves an established device identity: only ``rotate_device_key`` replaces it. The file contains secrets: keep it
    private and delete it after use."""
    problems = validate_wifi(ssid, password) + validate_base_url(base_url)
    if problems:
        raise ValueError("; ".join(problems))
    ca_text = ca_pem_path.read_text(encoding="ascii").strip()
    if "-----BEGIN CERTIFICATE-----" not in ca_text or "PRIVATE KEY" in ca_text:
        raise ValueError("invalid CA certificate PEM")
    if len(ca_text) > pki.MAX_CA_PEM:
        raise ValueError(f"CA PEM exceeds {pki.MAX_CA_PEM} bytes NVS string limit")
    existing = parse_partition(existing_nvs) if existing_nvs else {}
    key, identity = resolve_identity(existing, KeyStore(str(keys_file)), device_id, rotate_device_key)
    plan = plan_network_config(existing, device_key=key, identity=identity, ssid=ssid, password=password, base_url=base_url, ca_pem=ca_text, stage_capable=False)
    out_bin.write_bytes(encode_partition(plan.entries))
    return out_bin


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--device-id", default="RIG-1")
    ap.add_argument("--port", default="COM7")
    ap.add_argument("--ip", default=detect_lan_ip(), help="Reachable host LAN IPv4 (auto-detected default)")
    ap.add_argument("--https-port", type=int, default=8443)
    ap.add_argument("--secrets-dir", default=str(default_secrets_dir()))
    ap.add_argument("--keys-file", default=str(BACKEND / "data" / "device_keys.json"))
    ap.add_argument("--ssid", default="", help="Wi-Fi SSID (prompted interactively if omitted)")
    ap.add_argument("--rotate-key", action="store_true", help="replace the device authentication key (an identity change: the board and the backend must both take the new key)")
    ap.add_argument("--erase-damaged-nvs", action="store_true", help="if the board's NVS cannot be read, rebuild it from scratch (unreadable saved settings are lost)")
    ap.add_argument("--inspect-only", action="store_true", help="connect to --port and print the chip; writes nothing")
    ap.add_argument("--flash", action="store_true", help="read-merge-write-verify the board's NVS over --port (requires --motor-power-disconnected)")
    ap.add_argument("--motor-power-disconnected", action="store_true", help="Explicit confirmation that motor supply is disconnected")
    a = ap.parse_args()

    secrets_dir = Path(a.secrets_dir).resolve()
    try:
        secrets_dir.relative_to(REPO)
        print("refusing: --secrets-dir must be outside the repository", file=sys.stderr)
        return 2
    except ValueError:
        pass

    if not a.ip:
        print("refusing: could not auto-detect LAN IPv4; pass --ip <LAN_IP>", file=sys.stderr)
        return 2

    if a.inspect_only:
        flash = EsptoolFlash(a.port)
        try:
            print(f"chip: {flash.open()}")
        finally:
            flash.close()
        return 0

    tls = ensure_tls_certs(secrets_dir, a.ip)
    sig = ensure_signing_keys(secrets_dir, export_header=True)
    base_url = f"https://{a.ip}:{a.https_port}"
    print(f"Configured LAN HTTPS URL : {base_url}")
    print(f"Signing public key fp   : {sig['fingerprint']} ({sig['pub']})")
    print(f"Gateway TLS cert/key    : {tls['cert']}")

    if not a.flash:
        print("Provisioning artifacts generated (dry-run; serial port untouched).")
        print("Pass --flash --motor-power-disconnected to read, merge, write and verify the board's NVS.")
        return 0

    if not a.motor_power_disconnected:
        print("refusing: --flash requires explicit --motor-power-disconnected confirmation", file=sys.stderr)
        return 2

    ssid = a.ssid.strip() or input("Wi-Fi SSID: ").strip()
    pw = getpass.getpass("Wi-Fi password (hidden): ")
    problems = validate_wifi(ssid, pw) + validate_base_url(base_url)
    if problems:
        print("refusing: " + "; ".join(problems), file=sys.stderr)
        return 2
    ca_pem, detail = pki.read_trust_anchor(secrets_dir)
    if ca_pem is None:
        print(f"refusing: {detail}", file=sys.stderr)
        return 2

    flash = EsptoolFlash(a.port)
    try:
        result = write_network_config(
            flash, device_id=a.device_id, keystore=KeyStore(str(Path(a.keys_file))), ssid=ssid, password=pw, base_url=base_url, ca_pem=ca_pem,
            stage_capable=False, rotate_key=a.rotate_key, erase_damaged=a.erase_damaged_nvs, phase=lambda name, detail: print(f"[{name}] {detail}"))
        flash.reset()
    except ProvisioningError as exc:
        print(f"refusing/failed [{exc.code}]: {exc.message}", file=sys.stderr)
        return 1
    finally:
        flash.close()
    print(f"Done: identity {result['identity']}; {result['existing_entries']} existing NVS entries read"
          f"{' (damaged partition rebuilt)' if result['rebuilt'] else ' and preserved except the TORQVA-managed keys'}; the written image was read back and verified; board restarted.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
