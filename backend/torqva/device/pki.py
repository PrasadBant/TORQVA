"""Bench PKI helpers shared by the provisioning service and scripts/setup/provision_wireless.py.

The device verifies the backend gateway's TLS certificate against the CA stored in its NVS and checks the HOST NAME of the address it connects to. A certificate
issued for one LAN address therefore does not work after the laptop moves to another network, even though the CA is unchanged. ``gateway_cert_covers`` lets the
provisioning service see that before a board is configured, and ``ensure_tls_certs`` reissues the gateway certificate for the new address (the HTTPS gateway process
must then be restarted to load it).

Private keys stay in the secrets directory (outside the repository) and are never returned, logged or sent anywhere.
"""
from __future__ import annotations

import datetime
import hashlib
import ipaddress
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlsplit

MAX_CA_PEM = 3900                       # NVS string budget


def host_of(url: str) -> str:
    """Host part of an https:// URL ('' when it has none)."""
    try:
        return urlsplit(url).hostname or ""
    except ValueError:
        return ""


def _pem_key(key) -> bytes:
    from cryptography.hazmat.primitives import serialization
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())


def ensure_tls_certs(secrets_dir: Path, lan_ip: str) -> Dict[str, Path]:
    """Create (or reuse) the bench CA and issue a gateway certificate for ``lan_ip``. The CA is reused so already-provisioned boards keep trusting it."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    ipaddress.IPv4Address(lan_ip)                                        # raises on anything that is not a literal IPv4 address
    tls_dir = secrets_dir / "tls"
    tls_dir.mkdir(parents=True, exist_ok=True)
    ca_path, ca_key_path = tls_dir / "bench_ca.pem", tls_dir / "bench_ca_key.pem"
    cert_path, key_path = tls_dir / "gateway_cert.pem", tls_dir / "gateway_key.pem"
    now = datetime.datetime.now(datetime.timezone.utc)

    if ca_path.exists() and ca_key_path.exists():
        ca = x509.load_pem_x509_certificate(ca_path.read_bytes())
        ca_key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)
    else:
        ca_key = ec.generate_private_key(ec.SECP256R1())
        ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "TORQVA Bench OTA CA")])
        ca = (
            x509.CertificateBuilder()
            .subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=825))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256())
        )
        ca_path.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
        ca_key_path.write_bytes(_pem_key(ca_key))

    srv_key = ec.generate_private_key(ec.SECP256R1())
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, lan_ip)]))
        .issuer_name(ca.subject).public_key(srv_key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=397))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(lan_ip), x509.IPAddress(ipaddress.IPv4Address(lan_ip))]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.KeyUsage(True, False, False, False, True, False, False, False, False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(srv_key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(_pem_key(srv_key))
    return {"ca": ca_path, "cert": cert_path, "key": key_path}


def ensure_signing_keys(secrets_dir: Path, header_path: Optional[Path] = None) -> Dict[str, object]:
    """Release signing key pair (private key stays in the secrets dir). Optionally exports the PUBLIC key as a firmware header."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    sig_dir = secrets_dir / "signing"
    sig_dir.mkdir(parents=True, exist_ok=True)
    priv_path, pub_path = sig_dir / "release_signing_key.pem", sig_dir / "release_public_key.pem"
    if priv_path.exists() and pub_path.exists():
        pub_pem = pub_path.read_bytes()
        pub_key = serialization.load_pem_public_key(pub_pem)
    else:
        priv_key = ec.generate_private_key(ec.SECP256R1())
        priv_path.write_bytes(_pem_key(priv_key))
        pub_key = priv_key.public_key()
        pub_pem = pub_key.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        pub_path.write_bytes(pub_pem)
    if header_path is not None:
        body = "\n".join(f'    "{ln}\\n"' for ln in pub_pem.decode("ascii").strip().splitlines())
        header_path.write_text(
            "// Generated by scripts/setup/provision_wireless.py. Release-signing PUBLIC key (not a secret). git-ignored.\n"
            f"#pragma once\nstatic const char TORQVA_OTA_PUBKEY_PEM[] =\n{body};\n", encoding="utf-8")
    der = pub_key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return {"priv": priv_path, "pub": pub_path, "header": header_path, "fingerprint": hashlib.sha256(der).hexdigest()[:16]}


def read_trust_anchor(secrets_dir: Path) -> Tuple[Optional[str], str]:
    """(CA PEM, detail). The CA must be the issuer of the gateway certificate the backend serves; certificate-only, within the NVS size limit."""
    from cryptography import x509

    tls = secrets_dir / "tls"
    ca_path, cert_path = tls / "bench_ca.pem", tls / "gateway_cert.pem"
    if not ca_path.exists() or not cert_path.exists():
        return None, "TLS trust anchor not found; create it once with scripts/setup/provision_wireless.py"
    ca_text = ca_path.read_text(encoding="ascii").strip()
    if "-----BEGIN CERTIFICATE-----" not in ca_text or "PRIVATE KEY" in ca_text or len(ca_text) > MAX_CA_PEM:
        return None, "the stored CA file is not a certificate-only PEM within the NVS size limit"
    try:
        ca = x509.load_pem_x509_certificate(ca_text.encode("ascii"))
        gw = x509.load_pem_x509_certificate(cert_path.read_bytes())
        gw.verify_directly_issued_by(ca)
    except Exception as exc:                                              # noqa: BLE001 - reported as a validation result
        return None, f"the gateway certificate is not issued by the stored CA ({type(exc).__name__})"
    return ca_text, "gateway certificate chains to the stored CA"


def gateway_cert_hosts(secrets_dir: Path) -> List[str]:
    """Host names / addresses the gateway certificate is valid for (empty when unreadable)."""
    from cryptography import x509
    try:
        cert = x509.load_pem_x509_certificate((secrets_dir / "tls" / "gateway_cert.pem").read_bytes())
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except Exception:                                                     # noqa: BLE001
        return []
    return [str(i) for i in san.get_values_for_type(x509.IPAddress)] + list(san.get_values_for_type(x509.DNSName))


def gateway_cert_expired(secrets_dir: Path, now: Optional[datetime.datetime] = None) -> bool:
    from cryptography import x509
    try:
        cert = x509.load_pem_x509_certificate((secrets_dir / "tls" / "gateway_cert.pem").read_bytes())
    except Exception:                                                     # noqa: BLE001
        return True
    now = now or datetime.datetime.now(datetime.timezone.utc)
    return not (cert.not_valid_before_utc <= now <= cert.not_valid_after_utc)


def gateway_cert_covers(secrets_dir: Path, host: str) -> bool:
    """Does the gateway certificate name ``host`` (the device checks this exactly)? Also false when the certificate is expired or unreadable."""
    return bool(host) and host in gateway_cert_hosts(secrets_dir) and not gateway_cert_expired(secrets_dir)
