"""Staged network switching, Wi-Fi scanning and recovery: the new network is only ever TRIED, committed after authenticated pairing with fresh telemetry, and otherwise the
board is verified back on its previous network. Uses the fake board in tests/wifi_fakes.py, which applies the same trial rules as the firmware."""
import json

import pytest

from torqva.access.device_keys import KeyStore
from torqva.device import pki
from torqva.device.network_switch import NetworkSwitcher
from torqva.device.operation_lock import OperationLock
from torqva.device.provisioning import JobHistory, ProvisioningError, WifiProvisioner, run_scan, signal_bars
from wifi_fakes import BASE, DEVICE, Clock, FakeBridge, make_pki

NEW_PASS = "newnetpass1"
NETS = {"HomeNet": {"password": "password1", "gateway_ok": True}, "NewNet": {"password": NEW_PASS, "gateway_ok": True}}


def build(tmp_path, *, networks=None, supports_staging=True, start_on="wifi"):
    secrets = tmp_path / "secrets"
    make_pki(secrets)
    ks = KeyStore(str(tmp_path / "device_keys.json"))
    ks.provision(DEVICE)
    clock = Clock()
    bridge = FakeBridge(ks, clock, networks={k: dict(v) for k, v in (networks or NETS).items()}, supports_staging=supports_staging, start_on=start_on)
    lock = OperationLock()
    prov = WifiProvisioner(bridge, secrets_dir=secrets, lan_ip=lambda: "192.168.1.50", lock=lock, history=JobHistory(tmp_path / "h.json", wall=clock),
                           clock=clock, sleep=clock.sleep, wall=clock, run_async=False, phase_timeout_s=30)
    return {"prov": prov, "bridge": bridge, "switch": NetworkSwitcher(prov, run_async=False), "clock": clock, "lock": lock, "secrets": secrets, "tmp": tmp_path}


@pytest.fixture
def rig(tmp_path):
    return build(tmp_path)


def switch(rig, **over):
    args = dict(device_id=DEVICE, ssid="NewNet", password=NEW_PASS, base_url=BASE, user="ops")
    args.update(over)
    return rig["switch"].start(**args)


# ------------------------------------------------------------------ the happy path

def test_switch_stages_pairs_verifies_then_commits_and_only_then(rig):
    job = switch(rig)
    assert job["state"] == "COMMITTED" and job["wireless"] is True, job
    b = rig["bridge"]
    assert len(b.stage_calls) == 1 and b.stage_calls[0]["ssid"] == "NewNet" and b.commit_calls == 1
    assert b.committed_ssid == "NewNet" and b.trial is False
    c = job["checks"]
    assert c["wireless_session"] and c["wireless_telemetry"] and c["identity"] and c["console"] == "ok" and c["ota_ready"] == "ok"
    assert job["previous_ssid"] == "HomeNet"
    assert rig["lock"].active is None


def test_commit_is_sent_only_after_the_board_is_paired_on_the_new_network(rig):
    order = []
    b = rig["bridge"]
    real_commit = b.request_wifi_commit

    def watched(user, role):
        snap = b.snapshot()
        order.append((snap["transport"]["kind"], snap["net_info"]["ssid"], snap["wifi_state"]["trial"], snap["telemetry_fresh"]))
        return real_commit(user, role)
    b.request_wifi_commit = watched
    switch(rig)
    assert order == [("wifi", "NewNet", True, True)]                                # on the NEW network, still on trial, telemetry fresh


# ------------------------------------------------------------------ failures: nothing is committed, the old network is verified back

@pytest.mark.parametrize("label,nets", [
    ("wrong password", {"HomeNet": {"password": "password1", "gateway_ok": True}, "NewNet": {"password": "another-secret", "gateway_ok": True}}),
    ("network unavailable", {"HomeNet": {"password": "password1", "gateway_ok": True}}),
    ("gateway unreachable on the new network", {"HomeNet": {"password": "password1", "gateway_ok": True}, "NewNet": {"password": NEW_PASS, "gateway_ok": False}}),
])
def test_new_network_that_cannot_pair_rolls_back_to_the_verified_previous_network(tmp_path, label, nets):
    rig = build(tmp_path, networks=nets)
    job = switch(rig)
    assert job["state"] == "ROLLED_BACK", (label, job)
    assert job["error_code"] == "PAIRING_TIMEOUT" and "HomeNet" in job["detail"] and rig["bridge"].commit_calls == 0
    assert rig["bridge"].committed_ssid == "HomeNet"
    snap = rig["bridge"].snapshot()                                                 # and the board really is back, authenticated, with fresh telemetry
    assert snap["transport"]["kind"] == "wifi" and snap["net_info"]["ssid"] == "HomeNet" and snap["session"]["active"] and snap["telemetry_fresh"]
    assert "password" in " ".join(job["recovery"]).lower() and rig["lock"].active is None


def test_a_board_that_does_not_come_back_is_failed_with_usb_recovery_not_reported_as_success(tmp_path):
    rig = build(tmp_path, networks={"HomeNet": {"password": "password1", "gateway_ok": True}})          # NewNet unknown
    b = rig["bridge"]
    real_stage = b.request_wifi_stage

    def stage_then_lose_the_old_network(*a, **k):
        r = real_stage(*a, **k)
        b.networks["HomeNet"]["gateway_ok"] = False                                  # e.g. the router went away meanwhile
        return r
    b.request_wifi_stage = stage_then_lose_the_old_network
    job = switch(rig)
    assert job["state"] == "FAILED" and job["error_code"] == "DEVICE_LOST"
    assert any("USB" in step for step in job["recovery"]) and job["wireless"] is False and b.commit_calls == 0


def test_a_rejected_stage_is_a_plain_failure_with_nothing_to_roll_back(rig):
    rig["bridge"].stage_reject = "MOTOR_NOT_STOPPED"
    job = switch(rig)
    assert job["state"] == "FAILED" and job["error_code"] == "STAGE_REJECTED" and "stop" in job["detail"]
    assert rig["bridge"].commit_calls == 0 and rig["bridge"].committed_ssid == "HomeNet"
    assert rig["clock"]() < 1000 + 30                                               # it did not wait out a trial for something that never started


def test_a_commit_the_board_refuses_leaves_the_board_to_restore_its_old_network(rig):
    b = rig["bridge"]
    real = b.request_wifi_commit

    def refuse(user, role):
        return True, "", b._ack("REJECTED", "NO_TRIAL")
    b.request_wifi_commit = refuse
    job = switch(rig)
    assert job["state"] == "ROLLED_BACK" and job["error_code"] == "COMMIT_REJECTED"
    assert b.committed_ssid == "HomeNet"
    b.request_wifi_commit = real


def test_a_commit_that_lands_without_an_acknowledgement_is_confirmed_from_the_boards_own_state(rig):
    b = rig["bridge"]
    real = b.request_wifi_commit

    def lost_ack(user, role):
        real(user, role)                                                            # the board did commit...
        return True, "", 999_999                                                     # ...but its acknowledgement never reached us
    b.request_wifi_commit = lost_ack
    job = switch(rig)
    assert job["state"] == "COMMITTED" and "applied after all" in job["detail"]
    assert b.committed_ssid == "NewNet"


# ------------------------------------------------------------------ refusals before anything is staged

@pytest.mark.parametrize("mutate,code", [
    (lambda r: setattr(r["bridge"], "supports_staging", False), "UNSUPPORTED_FIRMWARE"),
    (lambda r: setattr(r["bridge"], "drive", "RUNNING"), "NOT_SAFE_STATE"),
    (lambda r: setattr(r["bridge"], "device_id", "RIG-9"), "IDENTITY_MISMATCH"),
    (lambda r: [setattr(r["bridge"], k, v) for k, v in (("trial", True), ("trial_ssid", "HomeNet"), ("trial_pass", "password1"), ("trial_end", r["clock"]() + 100))], "TRIAL_ACTIVE"),
])
def test_switch_refusals(rig, mutate, code):
    mutate(rig)
    with pytest.raises(ProvisioningError) as exc:
        switch(rig)
    assert exc.value.code == code
    assert rig["bridge"].stage_calls == [] and rig["lock"].active is None


def test_switch_over_usb_is_sent_to_configure_and_connect(tmp_path):
    rig = build(tmp_path, start_on="usb")
    with pytest.raises(ProvisioningError) as exc:
        switch(rig)
    assert exc.value.code == "USE_USB_PROVISIONING"


def test_switch_needs_a_gateway_certificate_that_names_the_backend_address(rig):
    with pytest.raises(ProvisioningError) as exc:
        switch(rig, base_url="https://192.168.77.7:8443")
    assert exc.value.code == "GATEWAY_CERT_HOST_MISMATCH" and rig["bridge"].stage_calls == []


def test_switch_validates_input_and_rejects_concurrent_operations(rig):
    for kw in ({"password": "short"}, {"ssid": ""}, {"base_url": "http://x"}, {"trial_s": 5}):
        with pytest.raises(ProvisioningError) as exc:
            switch(rig, **kw)
        assert exc.value.code == "INVALID_INPUT"
    rig["lock"].try_acquire("usb_flash")
    with pytest.raises(ProvisioningError) as busy:
        switch(rig)
    assert busy.value.code == "BUSY" and "usb_flash" in busy.value.message


def test_switch_never_leaks_the_password(rig):
    job = switch(rig)
    blob = json.dumps(job) + json.dumps(rig["prov"].history_list(5)) + (rig["tmp"] / "h.json").read_text() + repr(rig["prov"].jobs)
    assert NEW_PASS not in blob and "password1" not in blob


def test_switch_is_recorded_in_the_persistent_history(rig):
    job = switch(rig)
    stored = JobHistory(rig["tmp"] / "h.json").get(job["id"])
    assert stored["kind"] == "network_switch" and stored["state"] == "COMMITTED" and stored["previous_ssid"] == "HomeNet"


# ------------------------------------------------------------------ scanning

def scan(rig, **kw):
    return run_scan(rig["bridge"], "ops", lock=rig["lock"], clock=rig["clock"], sleep=rig["clock"].sleep, cache=kw.pop("cache", {}), **kw)


def test_scan_lists_networks_with_signal_security_band_and_marks_current_and_configured(rig):
    res = scan(rig)
    names = [n["ssid"] for n in res["networks"]]
    assert names == ["HomeNet", "OtherNet"]                                         # strongest first
    home, other = res["networks"]
    assert home["bars"] == 4 and other["bars"] == 2 and home["security"] == "WPA2" and other["security"] == "WPA2/WPA3"
    assert home["band"] == "2.4 GHz" and home["frequency_mhz"] == 2437 and home["current"] is True and home["configured"] is True
    assert other["current"] is False and "2.4 GHz" in res["note"] and "5 GHz" in res["note"] and "Hidden" in res["note"]
    assert rig["bridge"].scan_calls == 1


def test_scan_results_are_cached_so_repeated_requests_do_not_interrupt_the_link(rig):
    cache = {}
    scan(rig, cache=cache)
    again = scan(rig, cache=cache)
    assert again["cached"] is True and rig["bridge"].scan_calls == 1
    rig["clock"].sleep(60)
    scan(rig, cache=cache)
    assert rig["bridge"].scan_calls == 2


@pytest.mark.parametrize("mutate,code", [
    (lambda r: setattr(r["bridge"], "drive", "RUNNING"), "NOT_SAFE_STATE"),
    (lambda r: setattr(r["bridge"], "supports_staging", False), "UNSUPPORTED_FIRMWARE"),
    (lambda r: r["lock"].try_acquire("wifi_provisioning"), "BUSY"),
])
def test_scan_is_refused_when_it_could_interrupt_something(rig, mutate, code):
    mutate(rig)
    with pytest.raises(ProvisioningError) as exc:
        scan(rig)
    assert exc.value.code == code and rig["bridge"].scan_calls == 0


def test_scan_needs_an_authenticated_link_and_explains_manual_entry(tmp_path):
    rig = build(tmp_path, start_on=None)                                            # no link at all
    with pytest.raises(ProvisioningError) as exc:
        scan(rig)
    assert exc.value.code == "NO_AUTHENTICATED_LINK" and "by hand" in exc.value.message


def test_scan_failures_are_reported_with_a_reason(rig):
    rig["bridge"].scan_fail = "SCAN_BUSY"
    with pytest.raises(ProvisioningError) as exc:
        scan(rig)
    assert exc.value.code == "SCAN_FAILED" and "10 seconds" in exc.value.message


def test_signal_bars():
    assert [signal_bars(x) for x in (-40, -60, -70, -90, None)] == [4, 3, 2, 1, 0]


def test_current_network_details_for_the_status_panel(rig):
    cur = rig["prov"].status()["current_network"]                                    # the board reports its network on the Wi-Fi link
    assert cur["connected"] and cur["transport"] == "wifi" and cur["device_id"] == DEVICE
    assert cur["ssid"] == "HomeNet" and cur["configured_ssid"] == "HomeNet" and cur["staging_supported"] is True
    assert cur["bars"] == 4 and cur["rssi"] == -55 and cur["band"] == "2.4 GHz" and cur["trial"] is False and cur["session_active"] and cur["telemetry_fresh"]


def test_a_board_back_on_its_old_network_as_a_proven_standby_link_counts_as_rolled_back(tmp_path):
    """Measured on RIG-1 (27 Nov): during the trial USB took the command session; when the board came back on its old network its Wi-Fi link was a STANDBY
    link that proved the device key. The job must recognise that (it used to report 'has not come back')."""
    rig = build(tmp_path, networks={"HomeNet": {"password": "password1", "gateway_ok": True}})          # the staged network does not exist
    b = rig["bridge"]
    real_stage, real_snap = b.request_wifi_stage, b.snapshot
    staged = {"on": False}

    def stage(*a, **k):
        staged["on"] = True
        return real_stage(*a, **k)

    def snap():
        s = real_snap()
        if staged["on"] and (s.get("transport") or {}).get("kind") == "wifi" and not (s.get("wifi_state") or {}).get("trial"):
            s = {**s, "transport": {"kind": "usb", "port": "COM10"}, "readiness": {"wifi_standby": {"state": "READY", "ready": True}}}
        return s
    b.request_wifi_stage, b.snapshot = stage, snap
    job = switch(rig)
    assert job["state"] == "ROLLED_BACK", job
    assert b.commit_calls == 0 and b.committed_ssid == "HomeNet"
