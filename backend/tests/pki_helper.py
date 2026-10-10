"""TEST-ONLY PKI: every credential is generated in memory/tmp for one test run, uses the marker CA name "TORQVA-TEST-CA", and is never written outside pytest's tmp_path.
Production TLS policy refuses a CA carrying this marker (see device_transport.build_server_context). Nothing here is a production credential."""
import datetime as dt
import ipaddress
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

NOW = dt.datetime.now(dt.timezone.utc)


def _name(cn):
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])


class CA:
    def __init__(self, cn="TORQVA-TEST-CA"):
        self.key = ec.generate_private_key(ec.SECP256R1())
        self.cert = (x509.CertificateBuilder().subject_name(_name(cn)).issuer_name(_name(cn)).public_key(self.key.public_key())
                     .serial_number(x509.random_serial_number()).not_valid_before(NOW - dt.timedelta(days=1)).not_valid_after(NOW + dt.timedelta(days=2))
                     .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
                     .add_extension(x509.KeyUsage(digital_signature=True, key_cert_sign=True, crl_sign=True, content_commitment=False, key_encipherment=False,
                                                  data_encipherment=False, key_agreement=False, encipher_only=False, decipher_only=False), critical=True)
                     .sign(self.key, hashes.SHA256()))

    def issue(self, cn, server=False, not_before=None, not_after=None):
        key = ec.generate_private_key(ec.SECP256R1())
        b = (x509.CertificateBuilder().subject_name(_name(cn)).issuer_name(self.cert.subject).public_key(key.public_key())
             .serial_number(x509.random_serial_number()).not_valid_before(not_before or NOW - dt.timedelta(hours=1)).not_valid_after(not_after or NOW + dt.timedelta(days=1))
             .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
             .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH if server else ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False))
        if server:
            b = b.add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
        return b.sign(self.key, hashes.SHA256()), key

    def crl(self, revoked_serials=()):
        b = x509.CertificateRevocationListBuilder().issuer_name(self.cert.subject).last_update(NOW - dt.timedelta(hours=1)).next_update(NOW + dt.timedelta(days=1))
        for sn in revoked_serials:
            b = b.add_revoked_certificate(x509.RevokedCertificateBuilder().serial_number(sn).revocation_date(NOW - dt.timedelta(minutes=5)).build())
        return b.sign(self.key, hashes.SHA256())


def pem(cert):
    return cert.public_bytes(serialization.Encoding.PEM)


def key_pem(key):
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())


def der(cert):
    return cert.public_bytes(serialization.Encoding.DER)


def write(path: Path, data: bytes) -> str:
    path.write_bytes(data)
    return str(path)


def files(tmp: Path, ca: CA, cert, key, prefix):
    return write(tmp / f"{prefix}.crt", pem(cert)), write(tmp / f"{prefix}.key", key_pem(key))


def ca_file(tmp: Path, ca: CA, name="ca.pem"):
    return write(tmp / name, pem(ca.cert))


def crl_file(tmp: Path, ca: CA, revoked=(), name="ca.crl"):
    return write(tmp / name, ca.crl(revoked).public_bytes(serialization.Encoding.PEM))
