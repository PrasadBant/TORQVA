"""Firmware Manager (firmware.py, firmware_routes.py, the bridge's OTA frames). No real serial port, no network, no flash: images are synthetic ESP application
images built here, the signing key is generated per test run (never committed), and a software test device plays the firmware's side of the protocol over a
MemoryTransport while downloading through the real HTTP endpoints. Nothing here is hardware validation."""
import base64
import hashlib
import hmac
import json
import struct
import sys
import time
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))

from torqva import firmware as fwm
from torqva.api import create_router, install_error_handlers
from torqva.auth import TokenAuth
from torqva.firmware import FirmwareError, FirmwareManager, canonical, parse_esp_image, version_compare
from torqva.serial_bridge import Conn, FrameError, MemoryTransport, parse_frame
from torqva.service import SimulationService
from test_torqva_p16_serial import ENTRIES, H, fast, slow, status, wait


# ------------------------------------------------------------------------------------------------ synthetic images and keys
def esp_image(ver="3.1.0", chip=9, hash_appended=True, marker=True, size_hint=4000, prof=None):
    """A structurally valid ESP application image: header, two segments, checksum byte, optional appended SHA-256, and the TORQVA_FW_ID marker."""
    seg0 = bytes((i * 7) & 0xFF for i in range(size_hint))
    ident = f"TORQVA_FW_ID:ver={ver};chip=esp32s3;proto=1;" + ("" if prof is None else f"prof={prof};")
    seg1 = (ident.encode() + b"\0" if marker else b"") + bytes(64)
    hdr = bytearray(24)
    hdr[0], hdr[1], hdr[2], hdr[3] = 0xE9, 2, 2, 0x4F
    struct.pack_into("<I", hdr, 4, 0x40370000)
    hdr[8] = 0xEE
    struct.pack_into("<H", hdr, 12, chip)
    hdr[23] = 1 if hash_appended else 0
    body = bytearray(hdr)
    cs = 0xEF
    for load, seg in ((0x3C000020, seg0), (0x3FC88000, seg1)):
        body += struct.pack("<II", load, len(seg)) + seg
        for b in seg:
            cs ^= b
    body += bytes(15 - (len(body) % 16))
    body.append(cs)
    if hash_appended:
        body += hashlib.sha256(bytes(body)).digest()
    return bytes(body)


@pytest.fixture(scope="module")
def keys(tmp_path_factory):
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    d = tmp_path_factory.mktemp("keys")
    good, other = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    (d / "pub.pem").write_bytes(good.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo))
    return {"pub": str(d / "pub.pem"), "good": good, "other": other}


def sign(key, data):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    ver = fwm.firmware_identity(data)["ver"]
    return base64.b64encode(key.sign(canonical(ver, len(data), hashlib.sha256(data).hexdigest()).encode(), ec.ECDSA(hashes.SHA256()))).decode()


# ------------------------------------------------------------------------------------------------ fixtures
@pytest.fixture()
def api(tmp_path, keys, monkeypatch):
    monkeypatch.setenv("TORQVA_FIRMWARE_DIR", str(tmp_path / "fw"))
    monkeypatch.setenv("TORQVA_OTA_PUBLIC_KEY", keys["pub"])
    monkeypatch.setenv("TORQVA_OTA_PUBLIC_BASE_URL", "https://ota.bench.lan")
    svc = SimulationService()
    app = FastAPI(); app.include_router(create_router(svc, TokenAuth(ENTRIES))); install_error_handlers(app)
    c = TestClient(app, raise_server_exceptions=False)
    yield svc, c
    svc.bridge.disconnect()


def upload(c, data, sig="", tok="a", name="firmware.bin", version=""):
    return c.post("/api/torqva/firmware/releases", headers=H(tok), files={"file": (name, data, "application/octet-stream")}, data={"signature": sig, "version": version, "notes": "bench"})


_SEQ = [100]


def nseq():
    """OTA frames share the device's one increasing frame counter."""
    _SEQ[0] += 1
    return _SEQ[0]


def ota_info(**kw):
    f = {"t": "ota_info", "seq": nseq(), "ts": 1000, "cap": 1, "why": "", "run": "ota_0", "psz": 3342336, "pend": 0, "last": "", "lver": "", "blk": "", "busy": 0}
    f.update(kw)
    return json.dumps(f)


def connect_device(svc, fw="3.0.1", info=None, session=True):
    """The connected physical device: handshake, telemetry, an authenticated session (as the bridge holds it after the real handshake) and its ota_info."""
    b = svc.bridge
    tr = MemoryTransport(); b.connect(tr)
    tr.feed(json.dumps({**json.loads(status(0)), "fw": fw}))
    tr.feed(fast(1, rpm=0.0, duty=0.0, v=0.0, i=0.01)); tr.feed(slow(2))
    tr.feed(info if info is not None else ota_info())
    assert wait(lambda: b.model.conn == Conn.CONNECTED and b.ota_info is not None)
    if session:
        b._auth = {"state": "active", "sid": "a" * 16, "sk": b"k" * 32, "expires": b._clock() + 600, "restarts": 0, "dev": "RIG-1"}
    return tr


def written(tr, t=None):
    out = []
    for x in tr.written:
        o = json.loads(x)
        if t is None or o.get("t") == t:
            out.append(o)
    return out


# ------------------------------------------------------------------------------------------------ image parsing and versions
def test_a_synthetic_image_parses_like_a_real_one():
    info = parse_esp_image(esp_image())
    assert info["chip_id"] == 9 and info["segments"] == 2 and info["hash_appended"] and info["hash_ok"]
    assert fwm.firmware_identity(esp_image("4.0.2"))["ver"] == "4.0.2"


@pytest.mark.parametrize("data,code", [
    (b"", "EMPTY"),
    (b"\x7fELF" + bytes(200), "NOT_ESP_IMAGE"),                                           # an ELF, not the flashable image
    (esp_image()[:40], "BAD_SEGMENTS"),                                                     # truncated
    (bytes([0xE9, 0]) + esp_image()[2:], "BAD_SEGMENTS"),                                   # zero segments
])
def test_files_that_are_not_complete_esp_images_are_rejected(data, code):
    with pytest.raises(FirmwareError) as e:
        parse_esp_image(data)
    assert e.value.code == code


def test_corruption_is_detected_by_the_image_checksum_and_the_appended_hash():
    img = bytearray(esp_image())
    img[100] ^= 0x01
    with pytest.raises(FirmwareError) as e:
        parse_esp_image(bytes(img))
    assert e.value.code == "IMAGE_CHECKSUM_FAILED"
    img = bytearray(esp_image())
    img[-1] ^= 0x01                                                                         # only the appended SHA-256 changed
    with pytest.raises(FirmwareError) as e:
        parse_esp_image(bytes(img))
    assert e.value.code == "IMAGE_HASH_MISMATCH"


def test_versions_compare_like_the_firmware():
    assert version_compare("3.1.0", "3.0.1") == 1 and version_compare("3.0.10", "3.0.9") == 1 and version_compare("3.1.0-dev", "3.1.0") == -1
    assert version_compare("3.1.0", "3.1.0") == 0 and version_compare("v3", "3.1.0") is None


# ------------------------------------------------------------------------------------------------ upload and validation
def test_an_admin_uploads_a_valid_signed_image_and_every_check_is_verified(api, keys):
    svc, c = api
    data = esp_image("3.1.0")
    r = upload(c, data, sign(keys["good"], data))
    assert r.status_code == 200, r.text
    rec = r.json()
    assert rec["version"] == "3.1.0" and rec["size"] == len(data) and rec["sha256"] == hashlib.sha256(data).hexdigest() and rec["id"] == rec["sha256"][:12]
    assert {k: v["status"] for k, v in rec["checks"].items()} == {"image": "VERIFIED", "chip": "VERIFIED", "partition": "VERIFIED", "integrity": "VERIFIED", "signature": "VERIFIED"}
    assert rec["deployable"] and rec["status"] == "APPROVED" and rec["uploaded_by"] == "adam"
    stored = Path(svc.firmware.store.image_path(rec["sha256"]))
    assert stored.read_bytes() == data                                                       # on disk, outside the in-memory store
    assert any(h["kind"] == "release_uploaded" and h["release"] == rec["id"] for h in c.get("/api/torqva/firmware/deployments", headers=H("v")).json()["history"])
    assert "canonical" not in rec and "BEGIN" not in r.text                                  # no key material in any response


@pytest.mark.parametrize("make,status_code,code", [
    (lambda k: (b"", "", "firmware.bin"), 400, "EMPTY"),
    (lambda k: (esp_image(), "", "firmware.cpp"), 400, "NOT_A_BIN"),
    (lambda k: (b"#include <Arduino.h>\nvoid setup(){}", "", "firmware.bin"), 400, "NOT_ESP_IMAGE"),
    (lambda k: (esp_image(marker=False), "", "firmware.bin"), 400, "NO_FIRMWARE_ID"),
])
def test_invalid_uploads_are_rejected_with_the_reason(api, keys, make, status_code, code):
    svc, c = api
    data, sig, name = make(keys)
    r = upload(c, data, sig, name=name)
    assert r.status_code == status_code and r.json()["detail"]["code"] == code, r.text
    assert c.get("/api/torqva/firmware/releases", headers=H("v")).json()["releases"] == []


def test_an_oversized_image_is_rejected(api, monkeypatch):
    svc, c = api
    svc.firmware.max_bytes = 3000
    r = upload(c, esp_image())
    assert r.status_code == 413 and r.json()["detail"]["code"] == "TOO_LARGE"


def test_a_typed_version_must_match_the_version_compiled_into_the_image(api, keys):
    svc, c = api
    data = esp_image("3.1.0")
    r = upload(c, data, sign(keys["good"], data), version="9.9.9")
    assert r.status_code == 400 and r.json()["detail"]["code"] == "VERSION_MISMATCH"


def test_wrong_chip_wrong_key_and_tampered_signatures_are_stored_as_not_deployable(api, keys):
    svc, c = api
    esp32 = esp_image("3.1.0", chip=0)
    r = upload(c, esp32, sign(keys["good"], esp32)).json()
    assert r["checks"]["chip"]["status"] == "FAILED" and not r["deployable"]
    other = esp_image("3.2.0")
    r = upload(c, other, sign(keys["other"], other)).json()                                  # signed with a key the backend does not trust
    assert r["checks"]["signature"]["status"] == "FAILED" and not r["deployable"]
    third = esp_image("3.3.0")
    r = upload(c, third, sign(keys["good"], esp_image("3.3.1"))).json()                     # a valid signature, for a different image
    assert r["checks"]["signature"]["status"] == "FAILED" and not r["deployable"]
    fourth = esp_image("3.4.0")
    r = upload(c, fourth, "").json()
    assert r["checks"]["signature"]["status"] == "FAILED"
    fifth = esp_image("3.5.0")
    r = upload(c, fifth, "not base64 !!").json()
    assert r["checks"]["signature"]["status"] == "FAILED"


def test_without_a_configured_public_key_signatures_are_unavailable_never_accepted(tmp_path):
    fm = FirmwareManager(None, root=str(tmp_path), public_key="", base_url="https://ota.bench.lan")
    rec, checks = fm.validate(esp_image(), "AAAA")
    assert checks["signature"]["status"] == "UNAVAILABLE" and "TORQVA_OTA_PUBLIC_KEY" in checks["signature"]["detail"]


def test_upload_is_admin_only(api, keys):
    svc, c = api
    data = esp_image()
    for tok in ("v", "o"):
        assert upload(c, data, sign(keys["good"], data), tok=tok).status_code == 403
    assert c.post("/api/torqva/firmware/releases", files={"file": ("f.bin", data)}).status_code == 401


def test_duplicate_images_and_versions_are_refused(api, keys):
    svc, c = api
    data = esp_image("3.1.0")
    assert upload(c, data, sign(keys["good"], data)).status_code == 200
    r = upload(c, data, sign(keys["good"], data))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "DUPLICATE_RELEASE"
    again = esp_image("3.1.0", size_hint=5000)                                               # different bytes, same version
    r = upload(c, again, sign(keys["good"], again))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "DUPLICATE_VERSION"


def test_a_corrupt_release_index_fails_closed(tmp_path, keys):
    (tmp_path / "images").mkdir()
    (tmp_path / "releases.json").write_text('{"releases": {"../../etc": {"sha256": "x"}}}')
    fm = FirmwareManager(None, root=str(tmp_path), public_key=keys["pub"], base_url="https://ota.bench.lan")
    assert fm.store.load_error and fm.config()["storage"] == "UNAVAILABLE"
    data = esp_image()
    with pytest.raises(FirmwareError) as e:
        fm.upload(data, sign(keys["good"], data), "adam")
    assert e.value.code == "STORAGE_UNAVAILABLE"
    assert (tmp_path / "releases.json").read_text().startswith('{"releases": {"../../etc"')     # never overwritten


def test_a_stored_image_that_no_longer_matches_its_checksum_is_never_served(tmp_path, keys):
    fm = FirmwareManager(None, root=str(tmp_path), public_key=keys["pub"], base_url="https://ota.bench.lan")
    data = esp_image()
    rec = fm.upload(data, sign(keys["good"], data), "adam")
    Path(fm.store.image_path(rec["sha256"])).write_bytes(data[:-1] + b"\0")
    with pytest.raises(FirmwareError) as e:
        fm.store.read_image(fm.release(rec["id"]))
    assert e.value.code == "STORAGE_CORRUPT"
    with pytest.raises(FirmwareError):
        fm.store.image_path("../" + "a" * 61)                                                # no path traversal


# ------------------------------------------------------------------------------------------------ frames
def test_ota_frames_are_parsed_strictly():
    f = parse_frame('{"t":"ota","seq":5,"ts":9,"id":3,"st":"DOWNLOADING","rel":"0123456789ab","ver":"3.1.0","b":4096,"n":200000,"why":""}')
    assert f["st"] == "DOWNLOADING" and f["b"] == 4096
    assert parse_frame(ota_info())["cap"] == 1
    for bad in ('{"t":"ota","id":3,"st":"DONE","rel":"x","ver":"1","b":0,"n":0,"why":""}', '{"t":"ota_info","cap":true,"why":"","run":"","psz":0,"pend":0,"last":"","lver":"","blk":"","busy":0}'):
        with pytest.raises(FrameError):
            parse_frame(bad)


# ------------------------------------------------------------------------------------------------ deployment eligibility
def deployable(c, keys, ver="3.1.0"):
    data = esp_image(ver)
    rec = upload(c, data, sign(keys["good"], data)).json()
    assert rec["deployable"], rec
    return rec, data


def deploy(c, rec, tok="a", device="RIG-1", confirm=None, bench=True):
    return c.post("/api/torqva/firmware/deployments", headers=H(tok), json={"release_id": rec["id"], "device_id": device,
                  "confirm": confirm if confirm is not None else f"INSTALL {rec['version']} ON {device}", "bench_power_disconnected": bench})


def test_deployment_is_admin_only(api, keys):
    svc, c = api
    rec, _ = deployable(c, keys)
    connect_device(svc)
    assert deploy(c, rec, tok="o").status_code == 403 and deploy(c, rec, tok="v").status_code == 403


def test_no_device_means_not_eligible_and_nothing_is_sent(api, keys):
    svc, c = api
    rec, _ = deployable(c, keys)
    r = deploy(c, rec)
    assert r.status_code == 409 and "device not connected" in r.json()["detail"]["message"]


@pytest.mark.parametrize("setup,expected", [
    (dict(info=ota_info(cap=0, why="NO_OTA_PARTITIONS")), "OTA NOT CONFIGURED on the device: NO_OTA_PARTITIONS"),
    (dict(info=ota_info(blk="MOTOR_POWER_CONNECTED")), "the device refuses an update now: MOTOR_POWER_CONNECTED"),
    (dict(info=ota_info(blk="SPEED_UNVERIFIED")), "the device refuses an update now: SPEED_UNVERIFIED"),
    (dict(info=ota_info(psz=1000)), "does not fit the device's inactive partition"),
    (dict(fw="3.1.0"), "is not newer than the installed 3.1.0"),
    (dict(fw="3.2.0"), "is not newer than the installed 3.2.0"),
    (dict(session=False), "no authenticated session"),
])
def test_every_ineligible_condition_blocks_deployment_with_its_reason(api, keys, setup, expected):
    svc, c = api
    rec, _ = deployable(c, keys)
    tr = connect_device(svc, **setup)
    r = deploy(c, rec)
    assert r.status_code == 409 and expected in r.json()["detail"]["message"], r.text
    assert written(tr, "ota") == []


def test_a_different_device_id_confirmation_and_attestation_are_required(api, keys):
    svc, c = api
    rec, _ = deployable(c, keys)
    tr = connect_device(svc)
    assert "not 'RIG-9'" in deploy(c, rec, device="RIG-9").json()["detail"]["message"]
    assert deploy(c, rec, confirm="yes").json()["detail"]["code"] == "CONFIRMATION_REQUIRED"
    assert deploy(c, rec, bench=False).json()["detail"]["code"] == "BENCH_ATTESTATION_REQUIRED"
    assert written(tr, "ota") == []


def test_a_device_facing_url_on_localhost_blocks_deployment(api, keys):
    svc, c = api
    rec, _ = deployable(c, keys)
    connect_device(svc)
    svc.firmware.base_url = "https://127.0.0.1:8443"
    assert "reachable by the device" in deploy(c, rec).json()["detail"]["message"]
    svc.firmware.base_url = "http://ota.bench.lan"
    assert "must use https" in deploy(c, rec).json()["detail"]["message"]


def test_an_unsigned_release_is_not_deployable(api, keys):
    svc, c = api
    data = esp_image("3.1.0")
    rec = upload(c, data, sign(keys["other"], data)).json()
    connect_device(svc)
    assert "did not pass every validation check" in deploy(c, rec).json()["detail"]["message"]


# ------------------------------------------------------------------------------------------------ the update lifecycle against a software test device
class SoftwareDevice:
    """Plays the firmware's side: checks the MAC of the request with the session key, downloads manifest and image through the real HTTP routes with the
    token, verifies the signature and SHA-256 like ota_run(), and reports the states the firmware would report."""

    def __init__(self, svc, c, tr, pub_pem):
        self.svc, self.c, self.tr, self.pub = svc, c, tr, pub_pem

    def request(self):
        reqs = written(self.tr, "ota")
        assert len(reqs) == 1
        q = reqs[0]
        canon = f"ota|{q['id']}|{q['seq']}|{q['sid']}|{q['rel']}|{q['ver']}|{q['tok']}"
        assert hmac.compare_digest(q["m"], hmac.new(b"k" * 32, canon.encode(), hashlib.sha256).hexdigest()[:32])      # authentic for the live session
        return q

    def report(self, st, q, **kw):
        f = {"t": "ota", "seq": nseq(), "ts": 1000, "id": q["id"], "st": st, "rel": q["rel"], "ver": q["ver"], "b": 0, "n": 0, "why": ""}
        f.update(kw)
        self.tr.feed(json.dumps(f))

    def download_and_verify(self, q):
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        m = self.c.get(f"/api/torqva/firmware/ota/{q['rel']}/manifest", params={"t": q["tok"]})
        assert m.status_code == 200, m.text
        man = m.json()
        assert man["rel"] == q["rel"] and man["ver"] == q["ver"] and man["chip"] == "esp32s3"
        key = serialization.load_pem_public_key(Path(self.pub).read_bytes())
        key.verify(base64.b64decode(man["sig"]), canonical(man["ver"], man["size"], man["sha256"]).encode(), ec.ECDSA(hashes.SHA256()))   # raises if not authentic
        img = self.c.get(f"/api/torqva/firmware/ota/{q['rel']}/image", params={"t": q["tok"]})
        assert img.status_code == 200 and len(img.content) == man["size"] and hashlib.sha256(img.content).hexdigest() == man["sha256"]
        return man


def current(c):
    return c.get("/api/torqva/firmware/status", headers=H("v")).json()["current"]


def test_full_update_lifecycle_confirmed_only_by_the_device_after_its_self_test(api, keys):
    svc, c = api
    rec, data = deployable(c, keys)
    tr = connect_device(svc)
    r = deploy(c, rec)
    assert r.status_code == 200, r.text
    dep = r.json()
    assert dep["state"] == "REQUESTED" and dep["from_version"] == "3.0.1" and "token" not in dep
    dev = SoftwareDevice(svc, c, tr, keys["pub"])
    q = dev.request()
    assert q["rel"] == rec["id"] and q["ver"] == "3.1.0"
    assert not any(o.get("type") in ("START", "SET_SPEED", "RUN_TEST") for o in written(tr))        # an update never sends a motion command
    dev.report("AUTHORIZED", q); dev.report("PREPARING", q); dev.report("WIFI", q); dev.report("MANIFEST", q)
    assert wait(lambda: current(c)["state"] == "MANIFEST")
    man = dev.download_and_verify(q)
    dev.report("DOWNLOADING", q, b=65536, n=man["size"])
    assert wait(lambda: current(c)["bytes"] == 65536)                                        # progress is what the device reported
    dev.report("DOWNLOADING", q, b=man["size"], n=man["size"]); dev.report("VERIFYING", q); dev.report("READY", q); dev.report("REBOOTING", q)
    assert wait(lambda: current(c)["state"] == "REBOOTING")
    svc.bridge.disconnect("device restarting")                                                # the USB link drops while the chip restarts
    assert wait(lambda: current(c)["state"] == "WAITING_FOR_RECONNECTION")
    assert current(c)["state"] not in ("FAILED", "CONFIRMED")                                 # a disconnect for the restart is not a failure
    tr2 = connect_device(svc, fw="3.1.0", info=ota_info(run="ota_1", pend=1, blk="PENDING_VERIFY"))
    tr2.feed(json.dumps({"t": "ota", "seq": nseq(), "ts": 1000, "id": 0, "st": "SELF_TEST", "rel": "", "ver": "3.1.0", "b": 0, "n": 0, "why": ""}))
    assert wait(lambda: current(c)["state"] == "SELF_TEST")
    assert current(c)["state"] != "CONFIRMED"                                                 # running the new version is not proof it is healthy
    tr2.feed(json.dumps({"t": "ota", "seq": nseq(), "ts": 1000, "id": 0, "st": "CONFIRMED", "rel": "", "ver": "3.1.0", "b": 0, "n": 0, "why": ""}))
    assert wait(lambda: current(c)["state"] == "CONFIRMED")
    states = [e["state"] for e in current(c)["events"]]
    assert states[:1] == ["REQUESTED"] and "WAITING_FOR_RECONNECTION" in states and states[-1] == "CONFIRMED"
    hist = c.get("/api/torqva/firmware/deployments", headers=H("v")).json()["history"]
    assert any(h["kind"] == "deployment_result" and h["result"] == "CONFIRMED" and h["version"] == "3.1.0" for h in hist)
    assert c.get(f"/api/torqva/firmware/ota/{q['rel']}/image", params={"t": q["tok"]}).status_code == 403            # the token ends with the deployment
    assert not any(o.get("type") in ("START", "SET_SPEED", "RUN_TEST") for o in written(tr2))
    assert svc.bridge.snapshot()["physical_control_enabled"] is False                         # nothing was enabled by the update


def test_a_confirmation_seen_before_the_restart_is_never_taken_as_success(api, keys):
    svc, c = api
    rec, _ = deployable(c, keys)
    tr = connect_device(svc)
    deploy(c, rec)
    dev = SoftwareDevice(svc, c, tr, keys["pub"]); q = dev.request()
    dev.report("AUTHORIZED", q); dev.report("DOWNLOADING", q, b=4096, n=rec["size"])
    assert wait(lambda: current(c)["state"] == "DOWNLOADING")
    for st in ("CONFIRMED", "SELF_TEST"):                                                       # a stale or premature boot report for the target version
        tr.feed(json.dumps({"t": "ota", "seq": nseq(), "ts": 1000, "id": 0, "st": st, "rel": "", "ver": "3.1.0", "b": 0, "n": 0, "why": ""}))
    dev.report("DOWNLOADING", q, b=8192, n=rec["size"])                                        # a later frame proves the earlier ones were processed
    assert wait(lambda: current(c)["bytes"] == 8192)
    assert current(c)["state"] == "DOWNLOADING"
    f = {"t": "ota", "seq": nseq(), "ts": 1000, "id": q["id"], "st": "READY", "rel": q["rel"], "ver": q["ver"], "b": 0, "n": 0, "why": ""}
    tr.feed(json.dumps(f)); tr.feed(json.dumps(f))                                              # the same seq twice: the duplicate is dropped by the bridge
    assert wait(lambda: current(c)["state"] == "READY")
    assert svc.bridge.snapshot()["counters"]["duplicates"] == 1


def test_a_failed_self_test_reports_rollback_and_the_previous_firmware_is_recognised(api, keys):
    svc, c = api
    rec, _ = deployable(c, keys)
    tr = connect_device(svc)
    deploy(c, rec)
    dev = SoftwareDevice(svc, c, tr, keys["pub"]); q = dev.request()
    dev.report("AUTHORIZED", q); dev.report("REBOOTING", q)
    assert wait(lambda: current(c)["state"] == "REBOOTING")
    svc.bridge.disconnect("restart")
    tr2 = connect_device(svc, fw="3.1.0", info=ota_info(run="ota_1", pend=1))
    tr2.feed(json.dumps({"t": "ota", "seq": nseq(), "ts": 1000, "id": 0, "st": "ROLLBACK", "rel": "", "ver": "3.1.0", "b": 0, "n": 0, "why": "SENSORS"}))
    assert wait(lambda: current(c)["state"] == "ROLLBACK")
    svc.bridge.disconnect("restart into the previous image")
    connect_device(svc, fw="3.0.1", info=ota_info(last="ROLLED_BACK", lver="3.1.0"))           # the old image runs again and says so
    assert wait(lambda: current(c)["state"] == "ROLLED_BACK")
    assert "previous firmware" in current(c)["reason"]


def test_a_device_failure_report_ends_the_deployment_with_its_reason(api, keys):
    svc, c = api
    rec, _ = deployable(c, keys)
    tr = connect_device(svc)
    deploy(c, rec)
    dev = SoftwareDevice(svc, c, tr, keys["pub"]); q = dev.request()
    dev.report("AUTHORIZED", q); dev.report("DOWNLOADING", q, b=4096, n=rec["size"]); dev.report("FAILED", q, why="CHECKSUM_MISMATCH")
    assert wait(lambda: current(c)["state"] == "FAILED")
    assert current(c)["reason"] == "CHECKSUM_MISMATCH"
    assert c.get(f"/api/torqva/firmware/ota/{q['rel']}/manifest", params={"t": q["tok"]}).status_code == 403


def test_a_device_refusal_is_reported_as_refused(api, keys):
    svc, c = api
    rec, _ = deployable(c, keys)
    tr = connect_device(svc)
    deploy(c, rec)
    dev = SoftwareDevice(svc, c, tr, keys["pub"]); q = dev.request()
    dev.report("REFUSED", q, why="MOTOR_TURNING")
    assert wait(lambda: current(c)["state"] == "REFUSED") and current(c)["reason"] == "MOTOR_TURNING"


def _to_verifying_with_the_whole_image(svc, c, keys):
    """RIG-1, 5 Nov 22:54: the device reported the complete image and VERIFYING, then the Wi-Fi link dropped; READY / REBOOTING never arrived."""
    rec, _ = deployable(c, keys)
    tr = connect_device(svc)
    deploy(c, rec)
    dev = SoftwareDevice(svc, c, tr, keys["pub"]); q = dev.request()
    dev.report("AUTHORIZED", q); dev.report("DOWNLOADING", q, b=rec["size"], n=rec["size"]); dev.report("VERIFYING", q)
    assert wait(lambda: current(c)["state"] == "VERIFYING")
    return rec, q


def test_a_link_lost_while_verifying_the_whole_image_waits_for_the_restart_and_the_boot_status_confirms(api, keys):
    svc, c = api
    rec, q = _to_verifying_with_the_whole_image(svc, c, keys)
    svc.bridge.disconnect("Wi-Fi link closed")                                                # the device verifies and restarts on its own
    assert wait(lambda: current(c)["state"] == "WAITING_FOR_RECONNECTION")
    tr2 = connect_device(svc, fw="3.1.0", info=ota_info(run="ota_1", pend=0, last="CONFIRMED", lver="3.1.0"))   # only its periodic boot status arrives
    assert wait(lambda: current(c)["state"] == "CONFIRMED")
    assert "confirmed by the device" in current(c)["reason"]
    hist = c.get("/api/torqva/firmware/deployments", headers=H("v")).json()["history"]
    assert any(h["kind"] == "deployment_result" and h["result"] == "CONFIRMED" and h["version"] == "3.1.0" for h in hist)
    assert not any(o.get("type") in ("START", "SET_SPEED", "RUN_TEST") for o in written(tr2))


def test_after_a_link_lost_while_verifying_the_one_shot_confirmed_report_also_counts(api, keys):
    svc, c = api
    _to_verifying_with_the_whole_image(svc, c, keys)
    svc.bridge.disconnect("Wi-Fi link closed")
    assert wait(lambda: current(c)["state"] == "WAITING_FOR_RECONNECTION")
    tr2 = connect_device(svc, fw="3.1.0", info=ota_info(run="ota_1", pend=1, blk="PENDING_VERIFY"))
    tr2.feed(json.dumps({"t": "ota", "seq": nseq(), "ts": 1000, "id": 0, "st": "CONFIRMED", "rel": "", "ver": "3.1.0", "b": 0, "n": 0, "why": ""}))
    assert wait(lambda: current(c)["state"] == "CONFIRMED")


def test_a_boot_status_is_never_confirmation_before_the_restart_or_for_the_old_firmware(api, keys):
    svc, c = api
    rec, q = _to_verifying_with_the_whole_image(svc, c, keys)
    tr = svc.bridge._transport
    tr.feed(ota_info(pend=0, last="CONFIRMED", lver="3.1.0"))                                  # seen while still VERIFYING (no restart yet): ignored
    tr.feed(fast(nseq(), rpm=0.0, duty=0.0, v=0.0, i=0.01))
    time.sleep(0.3)
    assert current(c)["state"] == "VERIFYING"
    svc.bridge.disconnect("Wi-Fi link closed")
    assert wait(lambda: current(c)["state"] == "WAITING_FOR_RECONNECTION")
    connect_device(svc, fw="3.0.1", info=ota_info(pend=0, last="CONFIRMED", lver="3.0.1"))     # the OLD image is back, confirmed long ago: not success
    time.sleep(0.3)
    assert current(c)["state"] == "WAITING_FOR_RECONNECTION"
    svc.bridge.disconnect("again")
    connect_device(svc, fw="3.0.1", info=ota_info(pend=0, last="CONFIRMED", lver="3.1.0"))     # says 3.1.0 but runs 3.0.1: not success either
    time.sleep(0.3)
    assert current(c)["state"] == "WAITING_FOR_RECONNECTION"


def test_a_link_lost_before_the_image_is_complete_is_not_treated_as_the_restart(api, keys):
    svc, c = api
    rec, _ = deployable(c, keys)
    tr = connect_device(svc)
    deploy(c, rec)
    dev = SoftwareDevice(svc, c, tr, keys["pub"]); q = dev.request()
    dev.report("AUTHORIZED", q); dev.report("DOWNLOADING", q, b=4096, n=rec["size"]); dev.report("VERIFYING", q)
    assert wait(lambda: current(c)["state"] == "VERIFYING")
    svc.bridge.disconnect("Wi-Fi link closed")
    assert wait(lambda: "link was lost" in current(c)["reason"])
    assert current(c)["state"] == "VERIFYING"                                                   # unchanged behaviour: no restart assumed


def test_after_a_link_lost_while_verifying_a_device_failure_report_still_fails_it(api, keys):
    svc, c = api
    rec, q = _to_verifying_with_the_whole_image(svc, c, keys)
    svc.bridge.disconnect("Wi-Fi link closed")
    assert wait(lambda: current(c)["state"] == "WAITING_FOR_RECONNECTION")
    tr2 = connect_device(svc)                                                                  # it did not restart: verification failed on the device
    tr2.feed(json.dumps({"t": "ota", "seq": nseq(), "ts": 1000, "id": q["id"], "st": "FAILED", "rel": q["rel"], "ver": q["ver"], "b": 0, "n": 0, "why": "SIGNATURE_INVALID"}))
    assert wait(lambda: current(c)["state"] == "FAILED")
    assert current(c)["reason"] == "SIGNATURE_INVALID"


def test_a_device_silent_after_a_link_lost_while_verifying_is_verification_pending_not_failed(api, keys, monkeypatch):
    svc, c = api
    _to_verifying_with_the_whole_image(svc, c, keys)
    svc.bridge.disconnect("Wi-Fi link closed")
    assert wait(lambda: current(c)["state"] == "WAITING_FOR_RECONNECTION")
    fm = svc.firmware
    start = fm.clock()
    monkeypatch.setattr(fm, "clock", lambda: start + 301)                                       # the old 5-minute no-progress rule no longer applies
    assert current(c)["state"] == "WAITING_FOR_RECONNECTION"
    monkeypatch.setattr(fm, "clock", lambda: start + fwm.REBOOT_GRACE_S + 1)
    assert current(c)["state"] == "VERIFICATION_PENDING"


def test_a_device_that_never_comes_back_is_verification_pending_not_failed_or_confirmed(api, keys, monkeypatch):
    svc, c = api
    rec, _ = deployable(c, keys)
    tr = connect_device(svc)
    deploy(c, rec)
    dev = SoftwareDevice(svc, c, tr, keys["pub"]); q = dev.request()
    dev.report("REBOOTING", q)
    assert wait(lambda: current(c)["state"] == "REBOOTING")
    svc.bridge.disconnect("restart")
    fm = svc.firmware
    start = fm.clock()
    monkeypatch.setattr(fm, "clock", lambda: start + fwm.REBOOT_GRACE_S + 1)
    assert current(c)["state"] == "VERIFICATION_PENDING"


def test_download_tokens_are_bound_to_the_release_and_the_deployment(api, keys):
    svc, c = api
    rec, _ = deployable(c, keys)
    other, _ = deployable(c, keys, "3.2.0")
    tr = connect_device(svc)
    deploy(c, rec)
    q = SoftwareDevice(svc, c, tr, keys["pub"]).request()
    assert c.get(f"/api/torqva/firmware/ota/{rec['id']}/image", params={"t": "0" * 32}).status_code == 403
    assert c.get(f"/api/torqva/firmware/ota/{other['id']}/image", params={"t": q["tok"]}).status_code == 403          # another release
    assert c.get(f"/api/torqva/firmware/ota/{rec['id']}/image").status_code == 403
    assert c.get(f"/api/torqva/firmware/ota/{rec['id']}/image", params={"t": q["tok"]}).status_code == 200


def test_deployments_are_rate_limited_and_one_runs_at_a_time(api, keys):
    svc, c = api
    rec, _ = deployable(c, keys)
    connect_device(svc)
    assert deploy(c, rec).status_code == 200
    r = deploy(c, rec)
    assert r.status_code == 429 and r.json()["detail"]["code"] == "RATE_LIMITED"


def test_viewers_read_status_releases_and_history_without_upload_or_deploy_rights(api, keys):
    svc, c = api
    deployable(c, keys)
    s = c.get("/api/torqva/firmware/status", headers=H("v")).json()
    assert s["config"]["signature_verification"] == "AVAILABLE" and "never enable motor operation" in s["motor_operation"]
    assert len(c.get("/api/torqva/firmware/releases", headers=H("o")).json()["releases"]) == 1
    assert c.get("/api/torqva/firmware/status").status_code == 401


# ------------------------------------------------------------------------------------------------ the OTA LED bench profile (no motor hardware)
def bench_release(c, keys, ver="3.1.0"):
    data = esp_image(ver, prof="ota_led_bench")
    rec = upload(c, data, sign(keys["good"], data)).json()
    assert rec["deployable"] and rec["profile"] == "ota_led_bench", rec
    return rec


def test_ota_info_parses_the_optional_bench_profile_strictly():
    assert parse_frame(ota_info(prof="ota_led_bench"))["prof"] == "ota_led_bench"
    assert parse_frame(ota_info())["prof"] == ""                                               # production frames carry no prof: unchanged
    for bad in ("x" * 25, 1):
        with pytest.raises(FrameError):
            parse_frame(ota_info(prof=bad))


def test_an_unknown_firmware_profile_is_refused_at_upload(api, keys):
    _, c = api
    data = esp_image("3.1.0", prof="anything_else")
    r = upload(c, data, sign(keys["good"], data))
    assert r.status_code == 400 and r.json()["detail"]["code"] == "UNKNOWN_PROFILE"


def test_a_bench_release_never_goes_to_a_production_device_nor_the_reverse(api, keys):
    svc, c = api
    bench = bench_release(c, keys, "3.1.0")
    prod, _ = deployable(c, keys, "3.2.0")
    tr = connect_device(svc)                                                                  # a production device (no prof)
    r = deploy(c, bench)
    assert r.status_code == 409 and "profile mismatch" in r.text, r.text
    assert not written(tr, "ota")
    svc.bridge.disconnect("swap boards")
    tr2 = connect_device(svc, info=ota_info(prof="ota_led_bench"))                            # an LED bench device
    r = deploy(c, prod)
    assert r.status_code == 409 and "profile mismatch" in r.text, r.text
    assert not written(tr2, "ota")


def test_a_bench_release_deploys_to_a_bench_device_through_the_normal_checks(api, keys):
    svc, c = api
    bench = bench_release(c, keys, "3.1.0")
    tr = connect_device(svc, info=ota_info(prof="ota_led_bench"))
    st = c.get("/api/torqva/firmware/status", headers=H("v")).json()
    assert st["device"]["profile"] == "ota_led_bench" and "bench" in st["device"]["profile_label"]
    r = deploy(c, bench)
    assert r.status_code == 200, r.text
    q = written(tr, "ota")
    assert len(q) == 1 and q[0]["ver"] == "3.1.0"
    assert not any(o.get("type") in ("START", "SET_SPEED", "RUN_TEST") for o in written(tr))


def test_a_bench_device_refuses_every_motor_command_but_stop(api):
    from torqva.auth import Role
    svc, _ = api
    tr = connect_device(svc, info=ota_info(prof="ota_led_bench"))
    b = svc.bridge
    assert b.device_profile() == "ota_led_bench"
    assert any("OTA LED BENCH DEVICE" in x for x in b.control_blockers())
    for action, params in (("START", {"duty_pct": 10}), ("SET_SPEED", {"rpm": 1000})):
        rec = b.request_command(action, params, "adam", Role.ADMIN)
        assert rec.state.value == "REJECTED" and any("OTA LED BENCH DEVICE" in x for x in rec.reasons), (action, rec.reasons)
    assert not any(o.get("type") in ("START", "SET_SPEED", "RUN_TEST") for o in written(tr))
    rec = b.request_command("STOP", {}, "vera", Role.VIEWER)
    assert not any("OTA LED BENCH DEVICE" in x for x in rec.reasons)                          # STOP is never blocked by the bench profile
