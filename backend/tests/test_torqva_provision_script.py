"""scripts/setup/provision_wireless.py is a front end for the shared provisioning code: it must preserve unrelated NVS entries, reuse the device key, refuse unsafe layouts and
never write secrets to disk when flashing. The board is a FakeFlash; no port is opened."""
import importlib.util
import sys
from pathlib import Path

import pytest

from torqva.access.device_keys import KeyStore
from torqva.device.nvs import NVS_OFFSET, NVS_SIZE, logical_view, parse_partition
from wifi_fakes import DEVICE, FakeFlash, make_pki, partition_table
from test_torqva_wifi_provisioning import old_nvs

TOOL = Path(__file__).resolve().parents[2] / "scripts" / "setup" / "provision_wireless.py"


@pytest.fixture
def pw():
    spec = importlib.util.spec_from_file_location("provision_wireless_under_test", str(TOOL))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def board(tmp_path, *, with_network=True):
    secrets = tmp_path / "private_secrets"
    ca_pem = make_pki(secrets)
    keys = tmp_path / "device_keys.json"
    key = KeyStore(str(keys)).provision(DEVICE)
    flash = bytearray(0x10000)
    flash[0x8000:0x8000 + 0xC00] = partition_table()
    flash[NVS_OFFSET:NVS_OFFSET + NVS_SIZE] = old_nvs(key, ca_pem, with_network=with_network)
    return secrets, keys, key, flash, FakeFlash(flash)


def test_offline_image_for_a_dumped_board_keeps_every_unrelated_entry_and_the_identity(pw, tmp_path):
    secrets, keys, key, flash, _ = board(tmp_path)
    dump = bytes(flash[NVS_OFFSET:NVS_OFFSET + NVS_SIZE])
    out = tmp_path / "merged.bin"
    pw.build_nvs_image(device_id=DEVICE, ssid="BenchNet", password="bench-password-1", base_url="https://192.168.1.50:8443", ca_pem_path=secrets / "tls" / "bench_ca.pem",
                       keys_file=keys, out_bin=out, existing_nvs=dump)
    merged = logical_view(parse_partition(out.read_bytes()))
    before = logical_view(parse_partition(dump))
    assert merged[("torqva_ota", "ssid")] == ("string", "BenchNet")
    for kept in (("torqva", "cfg"), ("torqva_ota", "last"), ("torqva_ota", "lver"), ("torqva_ota", "att_ver"), ("torqva", "authkey")):
        assert merged[kept] == before[kept]
    assert out.stat().st_size == NVS_SIZE


def test_a_different_key_in_the_key_store_is_refused_by_the_script_too(pw, tmp_path):
    secrets, keys, key, flash, _ = board(tmp_path)
    other_keys = tmp_path / "other.json"
    KeyStore(str(other_keys)).provision(DEVICE)
    with pytest.raises(Exception) as exc:
        pw.build_nvs_image(device_id=DEVICE, ssid="BenchNet", password="bench-password-1", base_url="https://192.168.1.50:8443", ca_pem_path=secrets / "tls" / "bench_ca.pem",
                           keys_file=other_keys, out_bin=tmp_path / "x.bin", existing_nvs=bytes(flash[NVS_OFFSET:NVS_OFFSET + NVS_SIZE]))
    assert "KEY_MISMATCH" in repr(exc.value) or "key" in str(exc.value).lower()


def run_main(pw, monkeypatch, tmp_path, secrets, keys, fake, *extra, password="bench-password-1"):
    monkeypatch.setattr(pw, "EsptoolFlash", lambda port: fake)
    monkeypatch.setattr(pw.getpass, "getpass", lambda prompt="": password)
    monkeypatch.setattr(sys, "argv", ["provision_wireless.py", "--secrets-dir", str(secrets), "--ip", "192.168.1.50", "--keys-file", str(keys), "--ssid", "BenchNet",
                                      "--flash", "--motor-power-disconnected", *extra])
    monkeypatch.setattr(pw, "ensure_signing_keys", lambda *a, **k: {"fingerprint": "0" * 16, "pub": "pub.pem"})            # do not touch firmware/src/ota_pubkey.h
    return pw.main()


def test_flash_path_reads_merges_writes_only_nvs_verifies_and_restarts(pw, monkeypatch, tmp_path, capsys):
    secrets, keys, key, flash, fake = board(tmp_path)
    before = bytes(flash)
    assert run_main(pw, monkeypatch, tmp_path, secrets, keys, fake) == 0
    assert fake.writes == [(NVS_OFFSET, NVS_SIZE)] and fake.resets == 1
    assert bytes(flash[:NVS_OFFSET]) == before[:NVS_OFFSET] and bytes(flash[NVS_OFFSET + NVS_SIZE:]) == before[NVS_OFFSET + NVS_SIZE:]
    after = logical_view(parse_partition(bytes(flash[NVS_OFFSET:NVS_OFFSET + NVS_SIZE])))
    assert after[("torqva_ota", "ssid")] == ("string", "BenchNet")
    for kept in (("torqva", "cfg"), ("torqva_ota", "last"), ("torqva_ota", "lver"), ("torqva_ota", "att_ver")):
        assert kept in after                                                           # the OTA last-known-good record and the saved limits survive
    assert after[("torqva", "authkey")] == ("hex2bin", key.hex())
    out = capsys.readouterr()
    assert "bench-password-1" not in out.out + out.err


def test_flash_path_leaves_no_secret_file_behind(pw, monkeypatch, tmp_path):
    secrets, keys, key, flash, fake = board(tmp_path)
    import tempfile
    root = Path(tempfile.gettempdir())
    before = {p.name for p in root.glob("torqva_nvs*")}
    run_main(pw, monkeypatch, tmp_path, secrets, keys, fake)
    assert {p.name for p in root.glob("torqva_nvs*")} == before                         # the old script wrote and deleted temp CSV/bin files; this one writes none


def test_flash_path_refuses_a_damaged_partition_unless_told_to_rebuild(pw, monkeypatch, tmp_path):
    secrets, keys, key, flash, fake = board(tmp_path)
    flash[NVS_OFFSET + 64 + 4] ^= 0xFF
    assert run_main(pw, monkeypatch, tmp_path, secrets, keys, fake) == 1 and fake.writes == []
    assert run_main(pw, monkeypatch, tmp_path, secrets, keys, fake, "--erase-damaged-nvs") == 0 and fake.writes == [(NVS_OFFSET, NVS_SIZE)]


def test_flash_path_refuses_a_wrong_partition_layout(pw, monkeypatch, tmp_path):
    secrets, keys, key, flash, fake = board(tmp_path)
    flash[0x8000:0x8000 + 0xC00] = b"\xff" * 0xC00
    assert run_main(pw, monkeypatch, tmp_path, secrets, keys, fake) == 1 and fake.writes == []


def test_flash_path_refuses_weak_passwords_without_touching_the_board(pw, monkeypatch, tmp_path):
    secrets, keys, key, flash, fake = board(tmp_path)
    assert run_main(pw, monkeypatch, tmp_path, secrets, keys, fake, password="short") == 2 and fake.writes == []
