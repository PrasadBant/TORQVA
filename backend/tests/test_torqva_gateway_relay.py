"""Device-facing gateway relay (scripts/development/ota_https_gateway.py relay()): ONE thread moves bytes both ways between the device's TLS socket and the
backend socket (an OpenSSL connection must not be used by two threads at once). Real TLS over loopback; no hardware."""
import datetime
import importlib.util
import socket
import ssl
import threading
import time
from pathlib import Path

import pytest

crypto = pytest.importorskip("cryptography")
from cryptography import x509                                      # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization   # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec           # noqa: E402
from cryptography.x509.oid import NameOID                          # noqa: E402

GW = Path(__file__).resolve().parents[2] / "scripts" / "development" / "ota_https_gateway.py"
spec = importlib.util.spec_from_file_location("ota_https_gateway", GW)
gw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gw)


def self_signed(tmp_path):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=1)).not_valid_after(now + datetime.timedelta(days=1)).sign(key, hashes.SHA256()))
    c, k = tmp_path / "c.pem", tmp_path / "k.pem"
    c.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    k.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return str(c), str(k)


def read_exactly(sock, n, timeout=10.0):
    sock.settimeout(timeout)
    buf = bytearray()
    while len(buf) < n:
        d = sock.recv(65536)
        if not d:
            break
        buf += d
    return bytes(buf)


def device_session(sock, payload, want, chunk=18, timeout=15.0):
    """Like the board: many small writes while reading, all on one thread (non-blocking TLS client)."""
    sock.setblocking(False)
    sent, got, pending = 0, bytearray(), b""
    end = time.time() + timeout
    while (sent < len(payload) or pending or len(got) < want) and time.time() < end:
        if not pending and sent < len(payload):
            pending = payload[sent:sent + chunk]
        if pending:
            try:
                k = sock.send(pending); sent += k; pending = pending[k:]
            except (ssl.SSLWantWriteError, ssl.SSLWantReadError, BlockingIOError):
                pass
        try:
            while True:
                d = sock.recv(65536)
                if not d:
                    break
                got += d
        except (ssl.SSLWantReadError, ssl.SSLWantWriteError, BlockingIOError):
            pass
        if not pending and sent >= len(payload):
            time.sleep(0.001)
    sock.setblocking(True)
    return bytes(got)


def test_relay_moves_both_directions_at_once_and_reports_who_ended(tmp_path):
    cert, key = self_signed(tmp_path)
    sctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); sctx.load_cert_chain(cert, key)
    cctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT); cctx.check_hostname = False; cctx.verify_mode = ssl.CERT_NONE
    lsock = socket.create_server(("127.0.0.1", 0))
    port = lsock.getsockname()[1]
    device = cctx.wrap_socket(socket.socket(), server_hostname="localhost", do_handshake_on_connect=False)
    t = threading.Thread(target=lambda: (device.connect(("127.0.0.1", port)), device.do_handshake()), daemon=True); t.start()
    raw, _ = lsock.accept()
    dev_side = sctx.wrap_socket(raw, server_side=True)
    t.join(5)
    backend_gw, backend = socket.socketpair()

    up_payload = b"".join(b"device line %05d\n" % i for i in range(3000))     # many small writes, as the board sends
    down_payload = b"".join(b"backend frame %05d\n" % i for i in range(3000))
    n = {"up": 0, "down": 0, "t_up": 0.0, "t_down": 0.0}
    result = {}
    r = threading.Thread(target=lambda: result.setdefault("end", gw.relay(dev_side, backend_gw, n)), daemon=True); r.start()

    # The test's own TLS client is also driven by ONE thread (writing and reading it from two threads is exactly the hazard the relay removes).
    got = {}
    w2 = threading.Thread(target=lambda: backend.sendall(down_payload)); w2.start()
    r2 = threading.Thread(target=lambda: got.setdefault("up", read_exactly(backend, len(up_payload)))); r2.start()
    got["down"] = device_session(device, up_payload, len(down_payload))
    w2.join(5); r2.join(10)
    assert got["up"] == up_payload and got["down"] == down_payload
    assert n["up"] == len(up_payload) and n["down"] == len(down_payload)

    device.close()                                                            # the board goes away: the relay ends and says so
    r.join(5)
    assert not r.is_alive()
    assert result["end"][0] == "device"
    backend.close(); lsock.close()


def test_tune_socket_sets_nodelay_and_keepalive():
    a, b = socket.socketpair()
    try:
        gw.tune_socket(a)
        if a.family in (socket.AF_INET, socket.AF_INET6):
            assert a.getsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY) != 0
        assert a.getsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE) != 0
    finally:
        a.close(); b.close()
