"""Wi-Fi provisioning over USB: NVS parse/plan/encode, validation, PKI checks, the job state machine (staged and direct), identity and recovery-data preservation,
quarantine after an unverified write, restart reconciliation, persistent history, timeouts, credential leakage, concurrency and the HTTP surface.
Hardware is replaced by an in-memory flash and a fake board (tests/wifi_fakes.py); no port is opened and no board is touched."""
import hashlib
import json
import struct
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from torqva.access.auth import TokenAuth
from torqva.access.device_keys import KeyStore
from torqva.api.routes import create_router
from torqva.device import pki
from torqva.device.nvs import NVS_OFFSET, NVS_SIZE, NvsEntry, NvsError, encode_partition, logical_view, parse_partition
from torqva.device.operation_lock import OperationBusy, OperationLock
from torqva.device.provisioning import (
    JobHistory, ProvisioningError, WifiProvisioner, check_partition_table, group_by_namespace, plan_network_config,
    resolve_identity, validate_base_url, validate_wifi,
)
from wifi_fakes import BASE, DEVICE, PASSWORD, Clock, FakeBridge, FakeFlash, make_pki, partition_table

NEW_PASS = "newnetpass1"


def old_nvs(key: bytes, ca_pem: str, *, with_network: bool = True) -> bytes:
    entries = [NvsEntry("torqva", "authkey", "hex2bin", key.hex()),
               NvsEntry("torqva", "cfg", "hex2bin", "07" * 300)]                  # saved runtime limits: must survive
    if with_network:
        entries += [NvsEntry("torqva_ota", "ssid", "string", "HomeNet"), NvsEntry("torqva_ota", "pass", "string", "password1"),
                    NvsEntry("torqva_ota", "base", "string", "https://10.0.0.2:8443"), NvsEntry("torqva_ota", "ca", "string", ca_pem.strip())]
    entries += [NvsEntry("torqva_ota", "last", "string", "3.0.0"), NvsEntry("torqva_ota", "lver", "string", "3.0.0"),     # OTA last-known-good: must survive
                NvsEntry("torqva_ota", "att_ver", "string", "3.1.1")]
    return encode_partition(group_by_namespace(entries))


def build_rig(tmp_path, *, supports_staging=True, with_network=True, usb_unplug_after=5.0, networks=None, **flash_kw):
    secrets = tmp_path / "secrets"
    ca_pem = make_pki(secrets)
    ks = KeyStore(str(tmp_path / "device_keys.json"))
    key = ks.provision(DEVICE)
    flash = bytearray(0x10000)
    flash[0x8000:0x8000 + 0xC00] = partition_table()
    flash[NVS_OFFSET:NVS_OFFSET + NVS_SIZE] = old_nvs(key, ca_pem, with_network=with_network)
    original = bytes(flash)
    clock = Clock()
    fake = FakeFlash(flash, **flash_kw)
    nets = networks if networks is not None else {"HomeNet": {"password": "password1", "gateway_ok": True}, "NewNet": {"password": NEW_PASS, "gateway_ok": True}}
    bridge = FakeBridge(ks, clock, flash=fake, supports_staging=supports_staging, usb_unplug_after=usb_unplug_after, networks=nets, start_on="usb",
                        committed=("HomeNet", "password1") if with_network else ("", ""))
    history = JobHistory(tmp_path / "history.json", wall=clock)
    lock = OperationLock()
    prov = WifiProvisioner(bridge, secrets_dir=secrets, flash_factory=lambda port: fake, lan_ip=lambda: "192.168.1.50", lock=lock, history=history,
                           clock=clock, sleep=clock.sleep, wall=clock, run_async=False, phase_timeout_s=30, job_timeout_s=240, wireless_timeout_s=60)
    return {"prov": prov, "bridge": bridge, "fake": fake, "flash": flash, "original": original, "key": key, "ca": ca_pem, "ks": ks, "secrets": secrets, "clock": clock,
            "history": history, "lock": lock, "tmp": tmp_path}


@pytest.fixture
def rig(tmp_path):
    return build_rig(tmp_path)


def start(rig, **over):
    args = dict(device_id=DEVICE, port="COM7", ssid="NewNet", password=NEW_PASS, base_url=BASE, user="ops", confirm_physical=True)
    args.update(over)
    return rig["prov"].start(**args)


def nvs_of(rig):
    return logical_view(parse_partition(bytes(rig["flash"][NVS_OFFSET:NVS_OFFSET + NVS_SIZE])))


# ------------------------------------------------------------------ NVS codec

def test_encoder_matches_supported_cli_byte_for_byte(tmp_path):
    entries = [NvsEntry("torqva", "authkey", "hex2bin", "ab" * 32), NvsEntry("torqva", "cfg", "hex2bin", "01" * 300), NvsEntry("torqva", "ver", "u8", "7"),
               NvsEntry("torqva_ota", "ssid", "string", "Home Net"), NvsEntry("torqva_ota", "ca", "string", "X" * 1500)]
    csv = tmp_path / "in.csv"
    rows = ["key,type,encoding,value", "torqva,namespace,,", f"authkey,data,hex2bin,{'ab' * 32}", f"cfg,data,hex2bin,{'01' * 300}", "ver,data,u8,7", "torqva_ota,namespace,,",
            'ssid,data,string,"Home Net"', f'ca,data,string,"{"X" * 1500}"']
    csv.write_text("\n".join(rows) + "\n")
    out = tmp_path / "out.bin"
    subprocess.run([sys.executable, "-m", "esp_idf_nvs_partition_gen", "generate", str(csv), str(out), "0x5000"], check=True, capture_output=True)
    image = encode_partition(entries)
    assert len(image) == 0x5000 and image == out.read_bytes()


def test_parse_round_trip_preserves_every_entry_type():
    entries = [NvsEntry("ns_a", "u8k", "u8", "200"), NvsEntry("ns_a", "i8k", "i8", "-5"), NvsEntry("ns_a", "u32k", "u32", "4000000000"),
               NvsEntry("ns_a", "i64k", "i64", "-9000000000"), NvsEntry("ns_a", "s", "string", "héllo"), NvsEntry("ns_b", "blob", "hex2bin", "00ff" * 100)]
    assert logical_view(parse_partition(encode_partition(entries))) == {(e.namespace, e.key): (e.encoding, e.value) for e in entries}


def test_corrupt_entry_crc_is_refused():
    image = bytearray(encode_partition([NvsEntry("torqva", "ver", "u8", "7")]))
    image[64 + 4] ^= 0xFF
    with pytest.raises(NvsError, match="CRC"):
        parse_partition(bytes(image))


def test_corrupt_page_header_is_refused():
    image = bytearray(encode_partition([NvsEntry("torqva", "ver", "u8", "7")]))
    image[10] ^= 0x01
    with pytest.raises(NvsError, match="header CRC"):
        parse_partition(bytes(image))


def test_erased_partition_parses_empty():
    assert parse_partition(b"\xff" * NVS_SIZE) == {}


# ------------------------------------------------------------------ validation

@pytest.mark.parametrize("ssid,pw,ok", [("HomeNet", "password1", True), ("", "password1", False), ("x" * 33, "password1", False), ('bad"ssid', "password1", False),
                                         ("back\\slash", "password1", False), ("ok", "short", False), ("ok", "p" * 64, False), ("ok", "p" * 63, True)])
def test_wifi_validation(ssid, pw, ok):
    assert (validate_wifi(ssid, pw) == []) is ok


def test_base_url_validation():
    assert validate_base_url(BASE) == []
    assert validate_base_url("http://10.0.0.2:8443")
    assert validate_base_url("https://" + "a" * 130)
    assert validate_base_url("https://x y")
    assert validate_base_url("https://")


# ------------------------------------------------------------------ the one planner (shared by the service and scripts/setup/provision_wireless.py)

def _existing(rig):
    return parse_partition(rig["original"][NVS_OFFSET:NVS_OFFSET + NVS_SIZE])


def test_direct_plan_replaces_only_managed_keys_and_keeps_everything_else(tmp_path):
    rig = build_rig(tmp_path)
    plan = plan_network_config(_existing(rig), device_key=rig["key"], identity="reused", ssid="NewNet", password=NEW_PASS, base_url=BASE, ca_pem=rig["ca"], stage_capable=False)
    got = {(e.namespace, e.key): e for e in plan.entries}
    assert not plan.staged and "does not report" in plan.note
    assert got[("torqva_ota", "ssid")].value == "NewNet"
    for kept in (("torqva", "cfg"), ("torqva_ota", "last"), ("torqva_ota", "lver"), ("torqva_ota", "att_ver")):
        assert kept in got
    assert got[("torqva", "authkey")].value == rig["key"].hex()


def test_staged_plan_leaves_the_working_network_untouched(tmp_path):
    rig = build_rig(tmp_path)
    plan = plan_network_config(_existing(rig), device_key=rig["key"], identity="reused", ssid="NewNet", password=NEW_PASS, base_url=BASE, ca_pem=rig["ca"], stage_capable=True, trial_s=75)
    got = {(e.namespace, e.key): e.value for e in plan.entries}
    assert plan.staged and plan.note == ""
    assert (got[("torqva_ota", "ssid")], got[("torqva_ota", "pass")]) == ("HomeNet", "password1")        # working network still stored
    assert (got[("torqva_ota", "n_ssid")], got[("torqva_ota", "n_pass")], got[("torqva_ota", "n_tr")], got[("torqva_ota", "n_try")]) == ("NewNet", NEW_PASS, "75", "0")


def test_staging_is_not_used_when_there_is_nothing_to_fall_back_to_or_trust_changes(tmp_path):
    blank = build_rig(tmp_path / "a", with_network=False)
    p1 = plan_network_config(_existing(blank), device_key=blank["key"], identity="reused", ssid="NewNet", password=NEW_PASS, base_url=BASE, ca_pem=blank["ca"], stage_capable=True)
    assert not p1.staged and "no stored working network" in p1.note
    rig = build_rig(tmp_path / "b")
    p2 = plan_network_config(_existing(rig), device_key=rig["key"], identity="reused", ssid="NewNet", password=NEW_PASS, base_url=BASE, ca_pem="-----BEGIN CERTIFICATE-----\nOTHER\n-----END CERTIFICATE-----", stage_capable=True)
    assert not p2.staged and "trust anchor" in p2.note


def test_a_stale_staged_trial_is_replaced_not_stacked(tmp_path):
    rig = build_rig(tmp_path)
    ex = _existing(rig)
    ex[("torqva_ota", "n_ssid")] = NvsEntry("torqva_ota", "n_ssid", "string", "Ancient")
    plan = plan_network_config(ex, device_key=rig["key"], identity="reused", ssid="NewNet", password=NEW_PASS, base_url=BASE, ca_pem=rig["ca"], stage_capable=False)
    assert ("torqva_ota", "n_ssid") not in {(e.namespace, e.key) for e in plan.entries}


def test_identity_is_never_changed_by_a_network_update(tmp_path):
    rig = build_rig(tmp_path)
    key, how = resolve_identity(_existing(rig), rig["ks"], DEVICE)
    assert (key, how) == (rig["key"], "reused")
    other = KeyStore(str(tmp_path / "other_keys.json"))
    other.provision(DEVICE)                                                       # a different key for the same id
    with pytest.raises(ProvisioningError) as e1:
        resolve_identity(_existing(rig), other, DEVICE)
    assert e1.value.code == "KEY_MISMATCH"
    empty = KeyStore(str(tmp_path / "empty_keys.json"))
    with pytest.raises(ProvisioningError) as e2:
        resolve_identity(_existing(rig), empty, DEVICE)                           # the board has a key this backend does not know
    assert e2.value.code == "IDENTITY_UNKNOWN"
    k3, how3 = resolve_identity({}, empty, DEVICE)                                # a blank board gets a new identity
    assert how3 == "created" and empty.get(DEVICE) == k3


def test_partition_layout_must_match_the_pinned_table_and_must_not_overlap():
    check_partition_table(partition_table())
    bad = bytearray(partition_table())
    struct.pack_into("<I", bad, 4, 0x8000)
    with pytest.raises(ProvisioningError) as exc:
        check_partition_table(bytes(bad))
    assert exc.value.code == "PARTITION_LAYOUT_MISMATCH"
    overlap = bytearray(partition_table())
    struct.pack_into("<I", overlap, 32 + 4, 0xA000)                               # otadata moved into the NVS range
    with pytest.raises(ProvisioningError) as exc2:
        check_partition_table(bytes(overlap))
    assert "overlaps" in exc2.value.message


def test_constants_match_the_real_partition_table_pinned_by_platformio():
    """The NVS range used for reading AND writing comes from the same constants; they must equal the CSV the firmware is built with."""
    ini = (Path(__file__).resolve().parents[2] / "firmware" / "platformio.ini").read_text()
    assert "board_build.partitions = default_8MB.csv" in ini
    csv = Path.home() / ".platformio" / "packages" / "framework-arduinoespressif32" / "tools" / "partitions" / "default_8MB.csv"
    if not csv.exists():
        pytest.skip("PlatformIO Arduino framework is not installed here")
    row = next(ln for ln in csv.read_text().splitlines() if ln.startswith("nvs,"))
    name, ptype, sub, off, size = [c.strip() for c in row.split(",")][:5]
    assert (ptype, sub, int(off, 16), int(size, 16)) == ("data", "nvs", NVS_OFFSET, NVS_SIZE)


# ------------------------------------------------------------------ PKI

def test_trust_anchor_must_issue_the_gateway_certificate(tmp_path):
    secrets = tmp_path / "s"
    make_pki(secrets)
    pem, detail = pki.read_trust_anchor(secrets)
    assert pem and "chains" in detail
    make_pki(tmp_path / "other")
    (secrets / "tls" / "bench_ca.pem").write_text((tmp_path / "other" / "tls" / "bench_ca.pem").read_text())
    pem2, detail2 = pki.read_trust_anchor(secrets)
    assert pem2 is None and "not issued" in detail2


def test_gateway_certificate_must_name_the_backend_address(rig):
    with pytest.raises(ProvisioningError) as exc:
        start(rig, base_url="https://192.168.9.9:8443")                           # the laptop moved: the certificate names the old address
    assert exc.value.code == "GATEWAY_CERT_HOST_MISMATCH" and rig["fake"].writes == []


def test_reissuing_the_gateway_certificate_fixes_a_changed_laptop_address(rig):
    prov = rig["prov"]
    assert not pki.gateway_cert_covers(rig["secrets"], "192.168.9.9")
    result = prov.reissue_gateway_cert("192.168.9.9")
    assert result["restart_required"] is True
    assert pki.gateway_cert_covers(rig["secrets"], "192.168.9.9")
    pem, detail = pki.read_trust_anchor(rig["secrets"])
    assert pem is not None                                                         # same CA: boards that already trust it keep trusting it
    job = start(rig, base_url="https://192.168.9.9:8443")
    assert job["state"] == "PAIRED_WIRELESS"


def test_reissue_refuses_hostnames_and_a_missing_ca_key(rig):
    with pytest.raises(ProvisioningError) as e1:
        rig["prov"].reissue_gateway_cert("evil.example")
    assert e1.value.code == "BAD_HOST"
    (rig["secrets"] / "tls" / "bench_ca_key.pem").unlink()
    with pytest.raises(ProvisioningError) as e2:
        rig["prov"].reissue_gateway_cert("192.168.9.9")
    assert e2.value.code == "CA_KEY_MISSING"


# ------------------------------------------------------------------ job: staged path

def test_staged_success_keeps_the_old_network_in_nvs_commits_after_pairing_and_verifies_everything(rig):
    job = start(rig)
    assert job["state"] == "PAIRED_WIRELESS", job
    assert job["staged"] is True and job["wireless"] is True and job["identity"] == "reused"
    c = job["checks"]
    assert c["authenticated_session"] and c["telemetry_fresh"] and c["wireless_session"] and c["wireless_telemetry"]
    assert c["console"] == "ok" and c["ota_ready"] == "ok"
    assert rig["bridge"].commit_calls == 1 and rig["bridge"].committed_ssid == "NewNet"
    logical = nvs_of(rig)                                                          # what is on the board's flash
    assert logical[("torqva_ota", "ssid")] == ("string", "HomeNet")              # the previous network was NOT overwritten by the write
    assert logical[("torqva_ota", "n_ssid")] == ("string", "NewNet")
    assert rig["fake"].writes == [(NVS_OFFSET, NVS_SIZE)] and rig["fake"].resets == 1
    assert bytes(rig["flash"][:NVS_OFFSET]) == rig["original"][:NVS_OFFSET]       # bootloader, partition table untouched
    assert bytes(rig["flash"][NVS_OFFSET + NVS_SIZE:]) == rig["original"][NVS_OFFSET + NVS_SIZE:]


def test_staged_network_that_never_pairs_is_never_committed_and_the_board_restores_the_old_one(tmp_path):
    rig = build_rig(tmp_path, networks={"HomeNet": {"password": "password1", "gateway_ok": True}, "NewNet": {"password": "different-password", "gateway_ok": True}})
    job = start(rig)                                                              # wrong password for NewNet
    assert job["state"] == "WIRELESS_PENDING" and job["wireless"] is False
    assert "HomeNet" in job["detail"] and rig["bridge"].commit_calls == 0
    rig["clock"].sleep(120)                                                       # the trial window passes
    for _ in range(10):                                                           # the board needs a few seconds to rejoin its working network
        snap = rig["bridge"].snapshot()
        if snap["transport"]:
            break
        rig["clock"].sleep(2)
    assert snap["transport"]["kind"] == "wifi" and snap["net_info"]["ssid"] == "HomeNet"      # back on the working network by itself
    assert snap["wifi_state"]["trial"] is False and snap["wifi_state"]["active_ssid"] == "HomeNet"


def test_unreachable_gateway_on_the_new_network_is_not_pairing(tmp_path):
    rig = build_rig(tmp_path, networks={"HomeNet": {"password": "password1", "gateway_ok": True}, "NewNet": {"password": NEW_PASS, "gateway_ok": False}})
    job = start(rig)
    assert job["state"] == "WIRELESS_PENDING" and rig["bridge"].commit_calls == 0


def test_unknown_network_is_not_pairing(tmp_path):
    rig = build_rig(tmp_path)
    job = start(rig, ssid="NoSuchNet")
    assert job["state"] == "WIRELESS_PENDING" and rig["bridge"].commit_calls == 0


# ------------------------------------------------------------------ job: direct path

def test_firmware_without_staging_writes_directly_and_says_so(tmp_path):
    rig = build_rig(tmp_path, supports_staging=False)
    job = start(rig)
    assert job["state"] == "PAIRED_WIRELESS" and job["staged"] is False and "does not report" in job["stage_note"]
    assert rig["bridge"].commit_calls == 0
    assert nvs_of(rig)[("torqva_ota", "ssid")] == ("string", "NewNet")


def test_a_blank_board_is_provisioned_directly_with_a_new_identity_kept_consistent(tmp_path):
    rig = build_rig(tmp_path, with_network=False)
    job = start(rig)
    assert job["state"] == "PAIRED_WIRELESS" and job["staged"] is False and "no stored working network" in job["stage_note"]
    assert nvs_of(rig)[("torqva", "authkey")] == ("hex2bin", rig["key"].hex())


# ------------------------------------------------------------------ preservation (every mode)

@pytest.mark.parametrize("supports_staging", [True, False])
def test_unrelated_nvs_entries_runtime_limits_ota_recovery_and_identity_survive(tmp_path, supports_staging):
    rig = build_rig(tmp_path, supports_staging=supports_staging)
    before = nvs_of(rig)
    job = start(rig)
    assert job["state"] == "PAIRED_WIRELESS"
    after = nvs_of(rig)
    for kept in (("torqva", "cfg"), ("torqva_ota", "last"), ("torqva_ota", "lver"), ("torqva_ota", "att_ver"), ("torqva", "authkey")):
        assert after[kept] == before[kept], kept
    assert rig["ks"].get(DEVICE) == rig["key"]                                    # the key store was not rotated either


# ------------------------------------------------------------------ refusals before anything is written

def test_key_mismatch_between_the_board_and_the_key_store_is_refused_without_writing(rig):
    entries = dict(_existing(rig))
    entries[("torqva", "authkey")] = NvsEntry("torqva", "authkey", "hex2bin", "cd" * 32)
    rig["flash"][NVS_OFFSET:NVS_OFFSET + NVS_SIZE] = encode_partition(group_by_namespace(list(entries.values())))
    job = start(rig)
    assert job["state"] == "FAILED" and job["error_code"] == "KEY_MISMATCH" and rig["fake"].writes == []
    assert rig["lock"].quarantined is None                                        # nothing was written: no uncertainty


def test_wrong_chip_damaged_nvs_and_a_missing_nvs_partition_are_refused_before_writing(tmp_path):
    r1 = build_rig(tmp_path / "a", chip="ESP32-C3")
    assert start(r1)["error_code"] == "WRONG_CHIP" and r1["fake"].writes == []
    r2 = build_rig(tmp_path / "b")
    r2["flash"][NVS_OFFSET + 64 + 4] ^= 0xFF
    assert start(r2)["error_code"] == "NVS_UNREADABLE" and r2["fake"].writes == []
    r3 = build_rig(tmp_path / "c")
    r3["flash"][0x8000:0x8000 + 0xC00] = b"\xff" * 0xC00
    assert start(r3)["error_code"] == "PARTITION_LAYOUT_MISMATCH" and r3["fake"].writes == []


def test_identity_mismatch_motor_not_idle_and_wifi_connected_are_refused(rig):
    rig["bridge"].device_id = "RIG-9"
    with pytest.raises(ProvisioningError) as e1:
        start(rig)
    assert e1.value.code == "IDENTITY_MISMATCH"
    rig["bridge"].device_id = DEVICE
    rig["bridge"].drive = "RUNNING"
    with pytest.raises(ProvisioningError) as e2:
        start(rig)
    assert e2.value.code == "NOT_SAFE_STATE"
    rig["bridge"].drive = "IDLE"
    rig["bridge"].usb_attached = False
    rig["bridge"].joined_at = 0.0                                                 # the board is on Wi-Fi
    with pytest.raises(ProvisioningError) as e3:
        start(rig)
    assert e3.value.code == "USE_WIRELESS_NETWORK_CHANGE"
    assert rig["fake"].writes == []


def test_confirmation_inputs_and_trust_anchor_are_required(rig):
    for kw, code in (({"confirm_physical": False}, "PHYSICAL_CONFIRMATION_REQUIRED"), ({"port": "/etc/passwd"}, "BAD_PORT"), ({"password": "short"}, "INVALID_INPUT"),
                     ({"device_id": "bad id!"}, "BAD_DEVICE_ID")):
        with pytest.raises(ProvisioningError) as exc:
            start(rig, **kw)
        assert exc.value.code == code
    assert PASSWORD not in str(exc.value)
    (rig["secrets"] / "tls" / "bench_ca.pem").unlink()
    with pytest.raises(ProvisioningError) as e2:
        start(rig)
    assert e2.value.code == "TRUST_ANCHOR_MISSING"


def test_concurrent_operation_is_refused_and_released_after_a_clean_failure(rig):
    held = rig["lock"].try_acquire("wireless_deploy")
    with pytest.raises(ProvisioningError) as exc:
        start(rig)
    assert exc.value.code == "BUSY" and "wireless_deploy" in exc.value.message and rig["fake"].writes == []
    held.release()
    rig["fake"].chip = "ESP32-C3"
    start(rig)
    assert rig["lock"].active is None


# ------------------------------------------------------------------ uncertain flash state: quarantine and recovery

def test_failed_verification_quarantines_the_lock_and_a_verified_provisioning_clears_it(tmp_path):
    rig = build_rig(tmp_path, fail_readback=True)
    job = start(rig)
    assert job["state"] == "FAILED" and job["error_code"] == "NVS_VERIFY_FAILED" and job["unknown_device_state"] is True
    assert rig["fake"].resets == 0                                                # never restarted onto an unverified configuration
    assert rig["lock"].quarantined and rig["history"].quarantine
    for other in ("wireless_deploy", "usb_flash", "wifi_network_switch"):
        with pytest.raises(OperationBusy) as busy:
            rig["lock"].try_acquire(other)
        assert "recovery required" in str(busy.value)
    assert rig["prov"].status()["available"] is False and rig["prov"].status()["available_for_usb"] is True
    rig["fake"].fail_readback = False                                             # the cable is reseated; try again
    refused = start(rig)
    assert refused["error_code"] == "NVS_UNREADABLE" and "rebuild" in refused["detail"]     # the failed write left a damaged partition: never merged blindly
    assert rig["lock"].quarantined                                                # and a refusal does not clear the block
    again = start(rig, erase_damaged_nvs=True)                                    # the operator explicitly chooses to rebuild it
    assert again["state"] == "PAIRED_WIRELESS" and again["checks"]["nvs_rebuilt"] is True
    assert nvs_of(rig)[("torqva", "authkey")] == ("hex2bin", rig["key"].hex())    # identity rewritten from the key store, not invented
    assert rig["lock"].quarantined is None and rig["history"].quarantine is None


def test_a_write_that_dies_midway_quarantines_instead_of_releasing(tmp_path):
    rig = build_rig(tmp_path, explode_on_write=True)
    job = start(rig)
    assert job["state"] == "FAILED" and job["write_state"] == "writing" and job["unknown_device_state"] is True
    assert rig["lock"].quarantined and "uncertain" in rig["lock"].quarantined["reason"]


def test_operator_can_clear_the_recovery_block_explicitly(tmp_path):
    rig = build_rig(tmp_path, fail_readback=True)
    start(rig)
    assert rig["lock"].quarantined
    rig["prov"].clear_recovery("ops")
    assert rig["lock"].quarantined is None and rig["history"].quarantine is None
    rig["lock"].try_acquire("wireless_deploy").release()


def test_restart_that_never_reconnects_is_reported_after_a_verified_write(tmp_path):
    rig = build_rig(tmp_path)
    rig["bridge"].connect_failures = 10_000
    job = start(rig)
    assert job["error_code"] == "RESTART_FAILED" and "NVS write was verified" in job["detail"]
    assert rig["lock"].quarantined is None                                        # the write WAS verified: the state is known


def test_the_usb_connection_is_restored_after_a_failure(tmp_path):
    rig = build_rig(tmp_path, chip="ESP32-C3")
    assert rig["bridge"].usb_attached is True
    job = start(rig)
    assert job["error_code"] == "WRONG_CHIP"
    assert rig["bridge"].usb_attached is True and rig["bridge"].autoconnect.paused == 0
    assert any("restored" in ln for ln in job["logs"])


def test_run_exceeding_its_time_budget_stops_before_touching_the_board(rig):
    rig["prov"].job_timeout_s = -1
    job = start(rig)
    assert job["error_code"] == "TIMEOUT" and rig["fake"].writes == []


# ------------------------------------------------------------------ backend restart and history

def test_history_survives_a_restart_and_never_contains_secrets(rig):
    job = start(rig)
    path = rig["tmp"] / "history.json"
    text = path.read_text()
    assert PASSWORD not in text and NEW_PASS not in text and "BEGIN CERTIFICATE" not in text and rig["key"].hex() not in text
    again = JobHistory(path)
    stored = again.get(job["id"])
    assert stored["state"] == "PAIRED_WIRELESS" and stored["ssid"] == "NewNet"
    assert rig["prov"].history_list(5)[0]["id"] == job["id"]


def test_a_job_running_when_the_backend_stopped_is_marked_interrupted(tmp_path):
    path = tmp_path / "history.json"
    h = JobHistory(path)
    h.put({"id": "aaaaaaaaaaaa", "kind": "usb_provisioning", "state": "READING_NVS", "write_state": "none", "ssid": "x", "device_id": DEVICE, "logs": [], "recovery": []})
    h.put({"id": "bbbbbbbbbbbb", "kind": "network_switch", "state": "SWITCHING", "write_state": "none", "ssid": "x", "device_id": DEVICE, "logs": [], "recovery": []})
    lock = OperationLock()
    bridge = FakeBridge(KeyStore(str(tmp_path / "k.json")), Clock())
    prov = WifiProvisioner(bridge, secrets_dir=tmp_path, lock=lock, history=JobHistory(path))
    a, b = prov.get("aaaaaaaaaaaa"), prov.get("bbbbbbbbbbbb")
    assert a["state"] == "INTERRUPTED" and a["error_code"] == "BACKEND_RESTARTED" and not a.get("unknown_device_state")
    assert b["state"] == "INTERRUPTED" and "returns to its previous network" in b["detail"]
    assert lock.quarantined is None                                               # neither had written flash


def test_an_interrupted_flash_write_quarantines_the_lock_after_a_restart(tmp_path):
    path = tmp_path / "history.json"
    h = JobHistory(path)
    h.put({"id": "cccccccccccc", "kind": "usb_provisioning", "state": "WRITING_NVS", "write_state": "writing", "ssid": "x", "device_id": DEVICE, "logs": [], "recovery": []})
    lock = OperationLock()
    prov = WifiProvisioner(FakeBridge(KeyStore(str(tmp_path / "k.json")), Clock()), secrets_dir=tmp_path, lock=lock, history=JobHistory(path))
    c = prov.get("cccccccccccc")
    assert c["state"] == "INTERRUPTED" and c["unknown_device_state"] is True and "unknown" in c["detail"]
    assert lock.quarantined and "unknown" in lock.quarantined["reason"]
    with pytest.raises(OperationBusy):
        lock.try_acquire("wireless_deploy")
    lock.try_acquire("wifi_provisioning").release()                               # the recovery path itself stays open
    # and it is persistent: a second restart still blocks
    lock2 = OperationLock()
    WifiProvisioner(FakeBridge(KeyStore(str(tmp_path / "k.json")), Clock()), secrets_dir=tmp_path, lock=lock2, history=JobHistory(path))
    assert lock2.quarantined


def test_a_corrupt_history_file_is_set_aside_not_fatal(tmp_path):
    path = tmp_path / "history.json"
    path.write_text("{ this is not json")
    h = JobHistory(path)
    assert h.recent() == [] and (tmp_path / "history.corrupt").exists()


def test_a_stuck_job_is_reported_as_stalled(rig):
    prov = rig["prov"]
    stale = {"id": "dddddddddddd", "state": "WRITING_NVS", "updated_at": rig["clock"]() - 500}
    assert prov._stalled(stale)["stalled"] is True
    assert prov._stalled({**stale, "state": "FAILED"})["stalled"] is False


# ------------------------------------------------------------------ credential leakage

def test_password_never_appears_in_job_logs_history_responses_or_repr(rig):
    job = start(rig)
    for blob in (json.dumps(job), json.dumps(rig["prov"].get(job["id"])), json.dumps(rig["prov"].history_list(5)), repr(rig["prov"].jobs), (rig["tmp"] / "history.json").read_text()):
        assert NEW_PASS not in blob and PASSWORD not in blob
    assert "NewNet" in json.dumps(job)


def test_status_reports_readiness_without_secrets(rig):
    st = rig["prov"].status()
    assert st["trust_anchor"] is True and st["default_backend_url"] == BASE and st["gateway_cert_ok"] is True
    assert "BEGIN" not in json.dumps(st) and "PRIVATE" not in json.dumps(st)


# ------------------------------------------------------------------ HTTP surface

TOKENS = {"a": "admin", "o": "operator", "v": "viewer"}
H = lambda t: {"Authorization": f"Bearer {t}"}


@pytest.fixture
def client(rig, tmp_path):
    from torqva.service import SimulationService
    svc = SimulationService(store=str(tmp_path / "torqva.db"))
    svc.provisioner = rig["prov"]
    from torqva.device.network_switch import NetworkSwitcher
    svc.network_switcher = NetworkSwitcher(rig["prov"], run_async=False)
    auth = TokenAuth([{"sha256": hashlib.sha256(t.encode()).hexdigest(), "user": f"{r}-u", "role": r} for t, r in TOKENS.items()])
    app = FastAPI()
    app.include_router(create_router(svc, auth))
    return TestClient(app), rig


def test_http_start_requires_admin_and_never_echoes_password(client):
    c, rig = client
    body = {"device_id": DEVICE, "port": "COM7", "ssid": "NewNet", "password": NEW_PASS, "base_url": "", "confirm_physical": True}
    assert c.post("/api/torqva/provisioning/jobs", headers=H("o"), json=body).status_code == 403
    r = c.post("/api/torqva/provisioning/jobs", headers=H("a"), json=body)
    assert r.status_code == 200, r.text
    assert NEW_PASS not in r.text
    job_id = r.json()["id"]
    g = c.get(f"/api/torqva/provisioning/jobs/{job_id}", headers=H("v"))
    assert g.status_code == 200 and NEW_PASS not in g.text
    h = c.get("/api/torqva/provisioning/history", headers=H("v"))
    assert h.status_code == 200 and h.json()["jobs"][0]["id"] == job_id and NEW_PASS not in h.text and "logs" not in h.json()["jobs"][0]


def test_http_validation_error_does_not_echo_password(client):
    c, _ = client
    body = {"device_id": DEVICE, "port": "COM7", "ssid": "NewNet", "password": "short", "confirm_physical": True}
    r = c.post("/api/torqva/provisioning/jobs", headers=H("a"), json=body)
    assert r.status_code == 422 and "short" not in r.text


def test_http_status_unknown_job_recovery_and_gateway_cert(client):
    c, rig = client
    assert c.get("/api/torqva/provisioning/status", headers=H("v")).status_code == 200
    assert c.get("/api/torqva/provisioning/jobs/deadbeef", headers=H("v")).status_code == 404
    assert c.post("/api/torqva/provisioning/recovery/clear", headers=H("o"), json={"confirm": True}).status_code == 403
    assert c.post("/api/torqva/provisioning/recovery/clear", headers=H("a"), json={"confirm": False}).status_code == 409
    rig["lock"].quarantine("test", "x")
    assert c.post("/api/torqva/provisioning/recovery/clear", headers=H("a"), json={"confirm": True}).json() == {"cleared": True}
    assert rig["lock"].quarantined is None
    r = c.post("/api/torqva/provisioning/gateway-cert", headers=H("a"), json={"host": "192.168.9.9"})
    assert r.status_code == 200 and r.json()["restart_required"] is True
    assert c.post("/api/torqva/provisioning/gateway-cert", headers=H("v"), json={"host": "192.168.9.9"}).status_code == 403
    bad = c.post("/api/torqva/provisioning/gateway-cert", headers=H("a"), json={"host": "evil.example"})
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "BAD_HOST"
