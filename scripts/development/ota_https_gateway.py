"""Device-facing HTTPS for the Firmware Manager on a bench LAN (offline tool; run deliberately). Nothing here flashes, opens a serial port or deploys.

    python scripts/development/ota_https_gateway.py make-cert --ip <PC LAN IPv4> --out-dir <private folder OUTSIDE the repository>
        writes bench_ca.pem (the CA the ESP32 trusts: give it to provision_ota.py --ca), bench_ca_key.pem (PRIVATE),
        gateway_cert.pem and gateway_key.pem (PRIVATE) for the gateway. Refuses a folder inside the repository or one that is not empty.
        With --ca-dir <folder> it re-issues only the gateway certificate from that existing CA (for example after the PC's address changed).
    python scripts/development/ota_https_gateway.py serve --ip <PC LAN IPv4> --cert <gateway_cert.pem> --key <gateway_key.pem> [--port 8443] [--backend http://127.0.0.1:8000]
        TLS listener on that address that forwards ONLY  GET /api/torqva/firmware/ota/<release id>/manifest|image?t=<token>  and the device's
        WebSocket upgrade on  GET /api/torqva/device/link  to the local backend (which stays bound to 127.0.0.1), and answers 404 to everything else.
        The download token check and the device handshake stay in the backend.

Why a gateway: the ESP32 must reach the two download routes over verified TLS, but the rest of the API (operators, commands, commissioning) has no
reason to be on the LAN. The backend's own TORQVA_OTA_PUBLIC_BASE_URL is then https://<ip>:<port>.
mbedTLS 2.x (ESP-IDF 4.4) matches the host against DNS names only, so the certificate carries the IP both as a DNS name and as an IP address.
"""
import argparse
import datetime
import http.server
import ipaddress
import re
import selectors
import socket
import ssl
import threading
import time
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CR, LF = chr(13), chr(10)
CRLF = CR + LF
WS_ROUTE = "/api/torqva/device/link"          # the device's own WebSocket (wireless device link); authenticated by the device protocol, not here
ROUTE = re.compile(r"^/api/torqva/firmware/ota/[A-Za-z0-9-]{1,40}/(manifest|image)\?t=[0-9a-f]{1,64}$")


def _inside_repo(p: Path) -> bool:
    try:
        p.resolve().relative_to(REPO)
        return True
    except ValueError:
        return False


def _lan_ip(s: str) -> str:
    ip = ipaddress.IPv4Address(s)
    if ip.is_loopback or ip.is_unspecified or ip.is_multicast:
        raise SystemExit("refusing: --ip must be the PC's LAN address the ESP32 can reach (not loopback / 0.0.0.0)")
    return str(ip)


def make_cert(a) -> int:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
    ip, out = _lan_ip(a.ip), Path(a.out_dir)
    if _inside_repo(out):
        print("refusing: --out-dir is inside the repository; keep the private keys outside it", file=sys.stderr)
        return 2
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        print("refusing: --out-dir is not empty", file=sys.stderr)
        return 2
    now = datetime.datetime.now(datetime.timezone.utc)
    pem = lambda k: k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    if a.ca_dir:                                        # re-issue the gateway certificate from the EXISTING bench CA (the device keeps trusting the same CA)
        cad = Path(a.ca_dir)
        ca = x509.load_pem_x509_certificate((cad / "bench_ca.pem").read_bytes())
        ca_key = serialization.load_pem_private_key((cad / "bench_ca_key.pem").read_bytes(), password=None)
        if ca.public_key().public_numbers() != ca_key.public_key().public_numbers():
            print("refusing: bench_ca_key.pem does not belong to bench_ca.pem", file=sys.stderr)
            return 2
        ca_name = ca.subject
    else:
        ca_key = ec.generate_private_key(ec.SECP256R1())
        ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "TORQVA bench OTA CA (development)")])
    ca = ca if a.ca_dir else (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key())
          .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=825))
          .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
          .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
          .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
          .sign(ca_key, hashes.SHA256()))
    key = ec.generate_private_key(ec.SECP256R1())
    cert = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, ip)])).issuer_name(ca_name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(now + datetime.timedelta(days=397))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(ip), x509.IPAddress(ipaddress.IPv4Address(ip))]), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.KeyUsage(True, False, False, False, True, False, False, False, False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    (out / "bench_ca.pem").write_bytes(ca.public_bytes(serialization.Encoding.PEM))            # public: what the device trusts
    if not a.ca_dir:
        (out / "bench_ca_key.pem").write_bytes(pem(ca_key))                                    # a reused CA's key stays where it is (never copied)
    (out / "gateway_cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (out / "gateway_key.pem").write_bytes(pem(key))
    print(f"written: {out / 'bench_ca.pem'} (public CA certificate: provision_ota.py --ca){' - the existing CA from ' + a.ca_dir if a.ca_dir else ''}")
    print(f"written: {out / 'gateway_key.pem'}{'' if a.ca_dir else ', ' + str(out / 'bench_ca_key.pem')} (PRIVATE, development only)")
    print(f"written: {out / 'gateway_cert.pem'} for {ip}; device-facing URL: https://{ip}:8443")
    return 0


def tune_socket(s) -> None:
    """Low latency and dead-peer detection on one relayed socket: TCP_NODELAY (small WebSocket frames are not held back by Nagle) and TCP keepalive
    (a board that lost power or left the network is noticed within ~20 s instead of never: the relay would otherwise block on it forever)."""
    try:
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        if hasattr(socket, "SIO_KEEPALIVE_VALS"):                       # Windows: idle 10 s, then probes every 2 s
            s.ioctl(socket.SIO_KEEPALIVE_VALS, (1, 10000, 2000))
        elif hasattr(socket, "TCP_KEEPIDLE"):
            s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 10)
            s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 2)
            s.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 5)
    except (OSError, ValueError, AttributeError):
        pass


def relay(dev, up, n) -> "tuple[str, str]":
    """Relay bytes both ways between the device's TLS socket and the backend's plain socket, on ONE thread.

    The previous relay read the TLS socket on one thread while another wrote to it. An OpenSSL connection must not be used by two threads at once, and
    CPython does not serialise it. This loop is the only user of `dev`. Non-blocking: an SSL write that cannot complete is retried with the SAME chunk.
    Returns (which side ended first, how)."""
    tune_socket(dev); tune_socket(up)
    dev.setblocking(False); up.setblocking(False)
    to_dev, to_up = bytearray(), bytearray()
    dev_chunk = b""                                                     # an SSL write in progress (must be retried unchanged)
    sel = selectors.DefaultSelector()
    sel.register(dev, selectors.EVENT_READ); sel.register(up, selectors.EVENT_READ)
    try:
        while True:
            want_dev = selectors.EVENT_READ | (selectors.EVENT_WRITE if (to_dev or dev_chunk) else 0)
            want_up = selectors.EVENT_READ | (selectors.EVENT_WRITE if to_up else 0)
            sel.modify(dev, want_dev); sel.modify(up, want_up)
            ready = sel.select(timeout=None if not dev.pending() else 0)
            events = {k.fileobj: m for k, m in ready}
            if dev.pending() or events.get(dev, 0) & selectors.EVENT_READ:
                try:
                    while True:
                        data = dev.recv(65536)
                        if not data:
                            return "device", "EOF"
                        to_up += data; n["up"] += len(data); n["t_up"] = time.monotonic()
                        if not dev.pending():
                            break
                except (ssl.SSLWantReadError, ssl.SSLWantWriteError, BlockingIOError):
                    pass
                except OSError as e:
                    return "device", type(e).__name__
            if events.get(up, 0) & selectors.EVENT_READ:
                try:
                    data = up.recv(65536)
                    if not data:
                        return "backend", "EOF"
                    to_dev += data; n["down"] += len(data); n["t_down"] = time.monotonic()
                except BlockingIOError:
                    pass
                except OSError as e:
                    return "backend", type(e).__name__
            if to_up:
                try:
                    k = up.send(to_up); del to_up[:k]
                except BlockingIOError:
                    pass
                except OSError as e:
                    return "backend-write", type(e).__name__
            if to_dev or dev_chunk:
                if not dev_chunk:
                    dev_chunk = bytes(to_dev[:16384]); del to_dev[:len(dev_chunk)]
                try:
                    k = dev.send(dev_chunk)
                    dev_chunk = dev_chunk[k:]
                except (ssl.SSLWantReadError, ssl.SSLWantWriteError, BlockingIOError):
                    pass
                except OSError as e:
                    return "device-write", type(e).__name__
    finally:
        sel.close()
        try:
            up.close()
        except OSError:
            pass


def serve(a) -> int:
    ip, backend = _lan_ip(a.ip), a.backend.rstrip("/")
    if not re.match(r"^http://(127\.0\.0\.1|localhost):\d+$", backend):
        print("refusing: --backend must be the local backend (http://127.0.0.1:<port>)", file=sys.stderr)
        return 2

    class H(http.server.BaseHTTPRequestHandler):
        server_version = "torqva-ota-gateway"
        sys_version = ""

        def setup(self):
            # The TLS handshake runs here, in this connection's own thread (never in the accept loop, where one slow client would stall every other),
            # with a time limit, and every connection and handshake failure is logged (address only; nothing from the request).
            peer = self.client_address[0]
            self.request.settimeout(15)
            try:
                self.request.do_handshake()
            except (ssl.SSLError, OSError) as e:
                sys.stderr.write(f"{peer} TLS handshake FAILED: {type(e).__name__}: {str(e)[:120]}" + LF)
                raise
            self.request.settimeout(None)
            sys.stderr.write(f"{peer} TLS {self.request.version()} {self.request.cipher()[0]}" + LF)
            super().setup()

        def handle(self):
            try:
                super().handle()
            except (ssl.SSLError, OSError):
                pass

        def _no(self, code=404):
            self.send_response(code); self.send_header("Content-Length", "0"); self.end_headers()

        def _ws(self):
            # One WebSocket upgrade, relayed byte for byte to the local backend; the backend runs the device handshake and closes unauthenticated links.
            host, port = backend[len("http://"):].rsplit(":", 1)
            try:
                up = socket.create_connection((host, int(port)), timeout=10)
            except OSError:
                return self._no(502)
            head = [f"GET {WS_ROUTE} HTTP/1.1", f"Host: {host}:{port}", "Upgrade: websocket", "Connection: Upgrade", f"X-Forwarded-For: {self.client_address[0]}"]
            for h in ("Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Protocol"):
                v = self.headers.get(h)
                if v and CR not in v and LF not in v:
                    head.append(f"{h}: {v}")
            up.sendall((CRLF.join(head) + CRLF + CRLF).encode("latin-1"))
            self.close_connection = True
            # The device sends nothing before the backend's 101 response has been relayed, so nothing is left in self.rfile's buffer: the raw sockets are used.
            t_open = time.monotonic()
            n = {"up": 0, "down": 0, "t_up": t_open, "t_down": t_open}
            side, how = relay(self.connection, up, n)
            now = time.monotonic()
            sys.stderr.write(f"{self.address_string()} WS {WS_ROUTE} closed after {now - t_open:.1f}s "
                             f"(device->backend {n['up']} B, backend->device {n['down']} B incl. the 101 response) "
                             f"first end: {side} {how}; last device data {now - n['t_up']:.1f}s before close, "
                             f"last backend data {now - n['t_down']:.1f}s before close; opened {datetime.datetime.now() - datetime.timedelta(seconds=now - t_open):%H:%M:%S}" + LF)

        def do_GET(self):
            if self.path == WS_ROUTE and self.headers.get("Upgrade", "").lower() == "websocket":
                return self._ws()
            if not ROUTE.match(self.path):
                return self._no()
            req_headers = {}
            rng = self.headers.get("Range")
            if rng and CR not in rng and LF not in rng and rng.startswith("bytes="):
                req_headers["Range"] = rng
            try:
                with urllib.request.urlopen(urllib.request.Request(backend + self.path, headers=req_headers, method="GET"), timeout=60) as r:
                    length = r.headers.get("Content-Length", "")
                    if not length.isdecimal() or not 0 < int(length) <= 8 * 1024 * 1024:
                        return self._no(502)
                    remaining = int(length)
                    self.send_response(r.status)
                    self.send_header("Content-Type", r.headers.get("Content-Type", "application/octet-stream"))
                    self.send_header("Content-Length", length)
                    if r.headers.get("Content-Range"):
                        self.send_header("Content-Range", r.headers.get("Content-Range"))
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    while remaining:
                        chunk = r.read(min(64 * 1024, remaining))
                        if not chunk:
                            self.close_connection = True
                            return                         # truncated transfer: the ESP32 rejects it
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            except urllib.error.HTTPError as e:
                return self._no(e.code)
            except OSError:
                self.close_connection = True

        def _refuse(self):
            self._no(405)
        do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = _refuse

        def log_message(self, fmt, *args):               # never logs the query string (it holds the one-time download token)
            sys.stderr.write(f"{self.address_string()} {self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}\n")

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(a.cert, a.key)
    srv = http.server.ThreadingHTTPServer((ip, a.port), H)
    srv.daemon_threads = True
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True, do_handshake_on_connect=False)

    def _accept_error(request, client_address):              # a connection that fails before or during setup (handshake) is logged, not silently dropped
        sys.stderr.write(f"{client_address[0]} connection error: {sys.exc_info()[0].__name__ if sys.exc_info()[0] else '?'}" + LF)
    srv.handle_error = _accept_error
    print(f"TORQVA OTA gateway: https://{ip}:{a.port} -> {backend} (only the device download routes); Ctrl+C to stop")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("make-cert"); c.add_argument("--ip", required=True); c.add_argument("--out-dir", required=True)
    c.add_argument("--ca-dir", default=None, help="folder holding an existing bench_ca.pem + bench_ca_key.pem to issue from (no new CA)")
    s = sub.add_parser("serve"); s.add_argument("--ip", required=True); s.add_argument("--port", type=int, default=8443)
    s.add_argument("--cert", required=True); s.add_argument("--key", required=True); s.add_argument("--backend", default="http://127.0.0.1:8000")
    a = ap.parse_args()
    return {"make-cert": make_cert, "serve": serve}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
