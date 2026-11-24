"""Unified TORQVA wireless provisioning utility (offline host setup + explicit hardware flash).

Automates Step 2 of hardware bring-up without embedding secrets into the repository:
  1. Detects the reachable LAN IPv4 address (prefers physical Wi-Fi / Ethernet over virtual adapters).
  2. Provisions a 32-byte per-device authentication key (`device_keys.json` + NVS `torqva.authkey`).
  3. Generates or reuses an ECDSA P-256 firmware release signing key pair outside the repo and writes
     the public key header (`esp32/torqva_fw/src/ota_pubkey.h`, git-ignored).
  4. Generates or reuses a bench TLS CA + server certificate for the detected/selected LAN IP.
  5. Collects Wi-Fi SSID/password interactively via getpass (never logged or saved to repo), merges
     `torqva` + `torqva_ota` NVS CSVs, builds `nvs.bin` (`0x5000` bytes for `0x9000`), and deletes
     temporary CSVs immediately after use.
  6. Only inspects or flashes a physical serial port when explicitly authorized (`--flash` with
     `--motor-power-disconnected`).
"""
from __future__ import annotations

import argparse
import datetime
import getpass
import hashlib
import ipaddress
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BACKEND = REPO / "backend"
sys.path.insert(0, str(BACKEND))

from torqva.device_keys import KeyStore  # noqa: E402


def default_secrets_dir() -> Path:
    base = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / ".config"))
    return base / "Torqva" / "secrets"


def detect_lan_ip() -> str:
    """Detect the primary LAN IPv4 address for device-to-backend HTTPS communication."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        parsed = ipaddress.IPv4Address(ip)
        if not parsed.is_loopback and not parsed.is_unspecified:
            return str(parsed)
    except OSError:
        pass
    return ""


def _esptool_path() -> Path:
    return Path.home() / ".platformio" / "packages" / "tool-esptoolpy" / "esptool.py"


def inspect_board(port: str, baud: int = 460800) -> str:
    esptool = _esptool_path()
    if not esptool.exists():
        raise RuntimeError(f"esptool.py not found at {esptool}")
    proc = subprocess.run(
        [sys.executable, str(esptool), "--port", port, "--baud", str(baud), "flash_id"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr or proc.stdout or f"esptool failed on {port}")
    return proc.stdout


def ensure_tls_certs(secrets_dir: Path, lan_ip: str) -> dict:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    tls_dir = secrets_dir / "tls"
    tls_dir.mkdir(parents=True, exist_ok=True)
    ca_path = tls_dir / "bench_ca.pem"
    ca_key_path = tls_dir / "bench_ca_key.pem"
    cert_path = tls_dir / "gateway_cert.pem"
    key_path = tls_dir / "gateway_key.pem"
    now = datetime.datetime.now(datetime.timezone.utc)
    pem_bytes = lambda k: k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())

    if ca_path.exists() and ca_key_path.exists():
        ca = x509.load_pem_x509_certificate(ca_path.read_bytes())
        ca_key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)
    else:
        ca_key = ec.generate_private_key(ec.SECP256R1())
        ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "TORQVA Bench OTA CA")])
        ca = (
            x509.CertificateBuilder()
            .subject_name(ca_name)
            .issuer_name(ca_name)
            .public_key(ca_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=5))
            .not_valid_after(now + datetime.timedelta(days=825))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256())
        )
        ca_path.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
        ca_key_path.write_bytes(pem_bytes(ca_key))

    srv_key = ec.generate_private_key(ec.SECP256R1())
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, lan_ip)]))
        .issuer_name(ca.subject)
        .public_key(srv_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=397))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(lan_ip), x509.IPAddress(ipaddress.IPv4Address(lan_ip))]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.KeyUsage(True, False, False, False, True, False, False, False, False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(srv_key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(pem_bytes(srv_key))
    return {"ca": ca_path, "cert": cert_path, "key": key_path}


def ensure_signing_keys(secrets_dir: Path, export_header: bool = True) -> dict:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    sig_dir = secrets_dir / "signing"
    sig_dir.mkdir(parents=True, exist_ok=True)
    priv_path = sig_dir / "release_signing_key.pem"
    pub_path = sig_dir / "release_public_key.pem"

    if priv_path.exists() and pub_path.exists():
        pub_pem = pub_path.read_bytes()
        pub_key = serialization.load_pem_public_key(pub_pem)
    else:
        priv_key = ec.generate_private_key(ec.SECP256R1())
        priv_path.write_bytes(
            priv_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        )
        pub_key = priv_key.public_key()
        pub_pem = pub_key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        pub_path.write_bytes(pub_pem)

    hdr_path = REPO / "esp32" / "torqva_fw" / "src" / "ota_pubkey.h"
    if export_header:
        lines = pub_pem.decode("ascii").strip().splitlines()
        body = "\n".join(f'    "{ln}\\n"' for ln in lines)
        hdr_path.write_text(
            "// Generated by backend/tools/provision_wireless.py. Release-signing PUBLIC key (not a secret). git-ignored.\n"
            f"#pragma once\nstatic const char TORQVA_OTA_PUBKEY_PEM[] =\n{body};\n",
            encoding="utf-8",
        )
    der = pub_key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return {
        "priv": priv_path,
        "pub": pub_path,
        "header": hdr_path,
        "fingerprint": hashlib.sha256(der).hexdigest()[:16],
    }


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
) -> Path:
    if len(ssid) == 0 or len(ssid) > 32:
        raise ValueError("SSID must be 1-32 characters")
    if len(password) > 64:
        raise ValueError("Wi-Fi password must be <= 64 characters")
    if not base_url.startswith("https://"):
        raise ValueError("base_url must begin with https://")
    ca_text = ca_pem_path.read_text(encoding="ascii").strip()
    if "-----BEGIN CERTIFICATE-----" not in ca_text or "PRIVATE KEY" in ca_text:
        raise ValueError("invalid CA certificate PEM")
    if len(ca_text) > 3900:
        raise ValueError("CA PEM exceeds 3900 bytes NVS string limit")

    ks = KeyStore(str(keys_file))
    key_bytes = ks.provision(device_id, rotate=rotate_device_key)

    def _q(v: str) -> str:
        return '"' + v.replace('"', '""') + '"'

    csv_text = "\n".join([
        "key,type,encoding,value",
        "torqva,namespace,,",
        f"authkey,data,hex2bin,{key_bytes.hex()}",
        "torqva_ota,namespace,,",
        f"ssid,data,string,{_q(ssid)}",
        f"pass,data,string,{_q(password)}",
        f"base,data,string,{_q(base_url.rstrip('/'))}",
        f"ca,data,string,{_q(ca_text)}",
        "",
    ])

    tmp_dir = Path(tempfile.mkdtemp(prefix="torqva_nvs_"))
    try:
        csv_path = tmp_dir / "nvs_merged.csv"
        csv_path.write_text(csv_text, encoding="utf-8")
        res = subprocess.run(
            [sys.executable, "-m", "esp_idf_nvs_partition_gen", "generate", str(csv_path), str(out_bin), "0x5000"],
            capture_output=True,
            text=True,
            check=False,
        )
        if res.returncode != 0 or not out_bin.exists():
            raise RuntimeError(res.stderr or res.stdout or "esp_idf_nvs_partition_gen failed")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    return out_bin


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--device-id", default="RIG-1")
    ap.add_argument("--port", default="COM7")
    ap.add_argument("--ip", default=detect_lan_ip(), help="Reachable host LAN IPv4 (auto-detected default)")
    ap.add_argument("--https-port", type=int, default=8443)
    ap.add_argument("--secrets-dir", default=str(default_secrets_dir()))
    ap.add_argument("--keys-file", default=str(BACKEND / "data" / "device_keys.json"))
    ap.add_argument("--ssid", default="", help="Wi-Fi SSID (prompted interactively if omitted)")
    ap.add_argument("--rotate-key", action="store_true")
    ap.add_argument("--inspect-only", action="store_true")
    ap.add_argument("--flash", action="store_true", help="Flash NVS to --port (requires --motor-power-disconnected)")
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
        print(inspect_board(a.port))
        return 0

    tls = ensure_tls_certs(secrets_dir, a.ip)
    sig = ensure_signing_keys(secrets_dir, export_header=True)
    base_url = f"https://{a.ip}:{a.https_port}"
    print(f"Configured LAN HTTPS URL : {base_url}")
    print(f"Signing public key fp   : {sig['fingerprint']} ({sig['pub']})")
    print(f"Gateway TLS cert/key    : {tls['cert']}")

    if not a.flash:
        print("Provisioning artifacts generated (dry-run; serial port untouched).")
        print("Pass --flash --motor-power-disconnected to generate NVS interactively and flash.")
        return 0

    if not a.motor_power_disconnected:
        print("refusing: --flash requires explicit --motor-power-disconnected confirmation", file=sys.stderr)
        return 2

    ssid = a.ssid.strip() or input("Wi-Fi SSID: ").strip()
    pw = getpass.getpass("Wi-Fi password (hidden): ")
    tmp_bin_dir = Path(tempfile.mkdtemp(prefix="torqva_nvs_bin_"))
    try:
        nvs_bin = build_nvs_image(
            device_id=a.device_id,
            ssid=ssid,
            password=pw,
            base_url=base_url,
            ca_pem_path=tls["ca"],
            keys_file=Path(a.keys_file),
            out_bin=tmp_bin_dir / "nvs.bin",
            rotate_device_key=a.rotate_key,
        )
        esptool = _esptool_path()
        res = subprocess.run(
            [sys.executable, str(esptool), "--chip", "esp32s3", "--port", a.port, "--baud", "460800", "write_flash", "0x9000", str(nvs_bin)],
            check=False,
        )
        return res.returncode
    finally:
        shutil.rmtree(tmp_bin_dir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
