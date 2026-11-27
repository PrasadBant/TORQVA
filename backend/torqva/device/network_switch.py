"""Staged Wi-Fi network change for a board that is already paired over Wi-Fi ("Change Network").

The working network is never overwritten to try a new one:

1. STAGING            the authenticated ``wifi_stage`` frame asks the board to TRY the new network. Its stored (working) network is untouched.
2. SWITCHING          the board drops this link, joins the new network, opens an authenticated TLS link back and reports ``trial=1``.
3. VERIFYING_PAIRING  identity, authenticated session and fresh telemetry on the NEW link; console and OTA readiness are recorded.
4. COMMITTING         only now is the authenticated ``wifi_commit`` sent, over the new link. The board makes the network permanent and reports the trial over.

If any of that fails or times out, nothing is committed: the board restores its previous network by itself when the trial ends. The job then waits for the board to
come back on the previous network and verifies identity, authentication and telemetry there before reporting ROLLED_BACK. A board that does not come back is reported
FAILED with USB recovery instructions, never as a success.
"""
from __future__ import annotations

import threading
import uuid
from typing import Any, Dict, Optional, Tuple

from torqva.device import pki
from torqva.device.operation_lock import OperationBusy
from torqva.device.provisioning import (
    ProvisioningError,
    WifiProvisioner,
    validate_base_url,
    validate_wifi,
)
from torqva.models.schemas import Role

DEFAULT_TRIAL_S = 120
ROLLBACK_MARGIN_S = 45.0         # extra time to see the board back on its previous network after the trial window


_STAGE_REJECTION = {
    "MOTOR_NOT_STOPPED": "the motor drive is not stopped; stop it before changing the network",
    "WIFI_STAGE_UNSUPPORTED": "this firmware cannot stage a network change; update the firmware or use USB Configure & Connect",
    "WRONG_SESSION": "the authenticated session changed; try again",
    "BAD_SSID": "the board rejected the network name", "BAD_PASSPHRASE": "the board rejected the password (8 to 63 characters)",
    "BAD_BASE_URL": "the board rejected the backend address", "BAD_TRIAL": "the board rejected the trial length",
    "WIFI_STAGE_FAILED": "the board could not start the trial",
}


class NetworkSwitcher:
    def __init__(self, prov: WifiProvisioner, *, run_async: bool = True):
        self.p = prov
        self.run_async = run_async

    def start(self, *, device_id: str, ssid: str, password: str, base_url: str, user: str, trial_s: int = 0,
              snapshot: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        p = self.p
        problems = validate_wifi(ssid, password)
        base_url = (base_url or "").strip() or p.default_base_url()
        problems += validate_base_url(base_url)
        if problems:
            raise ProvisioningError("INVALID_INPUT", "; ".join(problems), 422)
        if trial_s and not (30 <= trial_s <= 600):
            raise ProvisioningError("INVALID_INPUT", "trial length must be 30 to 600 seconds", 422)
        trial_s = trial_s or DEFAULT_TRIAL_S
        ca, ca_detail = pki.read_trust_anchor(p.secrets_dir)
        if ca is None:
            raise ProvisioningError("TRUST_ANCHOR_MISSING", ca_detail, 409)
        p.gateway_check(base_url)

        snap = snapshot if snapshot is not None else p._snapshot()
        if snap.get("connection") not in ("CONNECTED", "STALE"):
            raise ProvisioningError("NOT_CONNECTED", "the board is not connected", 409)
        if (snap.get("transport") or {}).get("kind") != "wifi":
            raise ProvisioningError("USE_USB_PROVISIONING", "Change Network works while the board is connected over Wi-Fi. Over USB, use Configure & Connect", 409)
        if snap.get("device_id") != device_id:
            raise ProvisioningError("IDENTITY_MISMATCH", f"the connected device is {snap.get('device_id')!r}, not {device_id!r}", 409)
        if not (snap.get("session") or {}).get("active"):
            raise ProvisioningError("NO_AUTHENTICATED_LINK", "the board has no authenticated session", 409)
        ws = snap.get("wifi_state") or {}
        if not ws.get("supported"):
            raise ProvisioningError("UNSUPPORTED_FIRMWARE", "this firmware cannot stage a network change; update the firmware over Wi-Fi first, or use USB Configure & Connect", 409)
        if ws.get("trial"):
            raise ProvisioningError("TRIAL_ACTIVE", "the board is already trying a network; wait for it to commit or return", 409)
        if snap.get("drive") != "IDLE":
            raise ProvisioningError("NOT_SAFE_STATE", "the motor drive is not confirmed idle; changing the network drops the link, which stops a running motor. Stop it first", 409)
        if snap.get("safety_state") == "EMERGENCY_STOP":
            raise ProvisioningError("NOT_SAFE_STATE", "a safety trip is latched; reset it first", 409)

        try:
            held = p.lock.try_acquire("wifi_network_switch")
        except OperationBusy as busy:
            raise ProvisioningError("BUSY", f"{busy.active} is running; wait for it to finish", 409) from busy

        now = p.wall()
        previous = ws.get("active_ssid") or (snap.get("net_info") or {}).get("ssid") or ""
        job = {"id": uuid.uuid4().hex[:12], "kind": "network_switch", "device_id": device_id, "port": "", "ssid": ssid, "base_url": base_url, "requested_by": user,
               "state": "QUEUED", "progress": 0, "detail": "queued", "logs": [], "created_at": now, "updated_at": now, "identity": "reused", "chip": None,
               "wireless": False, "checks": {}, "recovery": [], "staged": True, "stage_note": "", "previous_ssid": previous, "write_state": "none",
               "unknown_device_state": False, "wait_until": None, "trial_s": trial_s}
        with p._mu:
            p.jobs[job["id"]] = job
        p.history.put(p._public(job))
        secrets = {"password": password, "held": held}
        if self.run_async:
            threading.Thread(target=self._run, args=(job, secrets), daemon=True, name=f"wifi-switch-{job['id']}").start()
        else:
            self._run(job, secrets)
        return p._public(job)

    # ---------------------------------------------------------------- worker
    def _run(self, job: Dict[str, Any], secrets: Dict[str, Any]) -> None:
        p = self.p
        held = secrets["held"]
        t_stage = p.wall()
        failure: Optional[ProvisioningError] = None
        try:
            p._set(job, secrets, "STAGING", "asking the board to try the new network; its working network is not touched")
            ok, why, cid = p.bridge.request_wifi_stage(job["ssid"], secrets["password"], job["base_url"], job["trial_s"], job["requested_by"], Role.ADMIN)
            if not ok:
                raise ProvisioningError("STAGE_NOT_SENT", f"the stage request could not be sent ({why})", 409)
            self._check_stage_ack(cid)

            wait_s = max(20.0, job["trial_s"] - 25.0)
            job["wait_until"] = p.wall() + wait_s
            p._set(job, secrets, "SWITCHING", f"the board is joining {job['ssid']!r}; waiting up to {int(wait_s)} s for its authenticated link on the new network")
            ok, why = p.verifier.wait(lambda: self._on_trial_network(job, t_stage), wait_s, 2.0)
            if not ok:
                raise ProvisioningError("PAIRING_TIMEOUT", self._pairing_timeout_message(job, why), 409)

            p._set(job, secrets, "VERIFYING_PAIRING", "authenticated link, device identity and fresh telemetry confirmed on the new network")
            job["checks"].update({"wireless_session": True, "wireless_telemetry": True, "identity": True})
            job["checks"].update(p.verifier.extra_checks(t_stage))

            p._set(job, secrets, "COMMITTING", "committing the new network on the board")
            p.verifier.commit(job["device_id"], job["ssid"], job["requested_by"])
            job["wireless"] = True
            p._set(job, secrets, "COMMITTED", f"{job['ssid']!r} is now the board's permanent network")
        except ProvisioningError as exc:
            failure = exc
        except Exception as exc:                                              # noqa: BLE001
            failure = ProvisioningError("UNEXPECTED", f"{type(exc).__name__}: {exc}")
        try:
            if failure is not None:
                self._recover(job, secrets, failure)
        finally:
            held.release()
            p.history.put(p._public(job))

    def _check_stage_ack(self, cid: Optional[int]) -> None:
        """A rejection is final. A missing acknowledgement is not an error: the board may already have left this link to join the new network."""
        def acked() -> Tuple[bool, str]:
            a = self.p.bridge.sys_ack(cid)
            return (a is not None), "no acknowledgement yet"
        self.p.verifier.wait(acked, 6.0, 0.25)
        a = self.p.bridge.sys_ack(cid)
        if a is not None and a.get("status") == "REJECTED":
            reason = a.get("reason") or ""
            raise ProvisioningError("STAGE_REJECTED", _STAGE_REJECTION.get(reason, f"the board refused the change ({reason})"), 409)

    def _on_trial_network(self, job: Dict[str, Any], t_stage: float) -> Tuple[bool, str]:
        ok, why = self.p.verifier.wireless_ok(job["device_id"], job["ssid"], net_after=t_stage)
        if not ok:
            return False, why
        ws = (self.p.bridge.snapshot().get("wifi_state") or {})
        if not (ws.get("supported") and ws.get("trial")):
            return False, "the board does not report a network trial yet"
        return True, ""

    @staticmethod
    def _pairing_timeout_message(job: Dict[str, Any], last: str) -> str:
        return (f"the board did not complete an authenticated link on {job['ssid']!r} in time ({last}). Common causes: wrong password, a 5 GHz-only network, router client "
                "isolation, the laptop's firewall blocking the gateway port on that network, or a gateway certificate that does not name this laptop's address on that network.")

    def _recover(self, job: Dict[str, Any], secrets: Dict[str, Any], failure: ProvisioningError) -> None:
        """Nothing was committed. Wait for the board to restore its previous network and verify it there before saying so."""
        p = self.p
        if failure.code in ("STAGE_NOT_SENT", "STAGE_REJECTED"):                 # the board never left its network: there is nothing to roll back
            job["recovery"] = ["The board is unchanged and still on its network. Fix the reported problem and try again."]
            p._fail(job, secrets, failure.code, failure.message)
            return
        prev = job["previous_ssid"]
        t0 = p.wall()
        wait_s = float(job["trial_s"]) + 45.0
        p._set(job, secrets, "WAITING_ROLLBACK", f"{failure.message} Nothing was committed; waiting for the board to return to {prev!r}" if prev else
               f"{failure.message} Nothing was committed; waiting for the board to return to its previous network")
        job["wait_until"] = p.wall() + wait_s

        def back() -> Tuple[bool, str]:
            ws = p.bridge.snapshot().get("wifi_state") or {}
            if ws.get("trial") or not ws.get("supported"):
                return False, "the board still reports a trial"
            if ws.get("active_ssid") == job["ssid"]:                             # the commit did land after all
                ok, why = p.verifier.wireless_ok(job["device_id"], job["ssid"], net_after=t0)
                return (ok, why)
            ok, why = p.verifier.wireless_ok(job["device_id"], prev or None, net_after=t0)
            if ok:
                return ok, why
            # USB may hold the command session meanwhile: then the board's Wi-Fi link is a STANDBY link. A live standby link that proved this board's key
            # (device_link.py identity proof), from the address the board reports on the previous network, is the board back on that network.
            snap = p.bridge.snapshot()
            sb = (snap.get("readiness") or {}).get("wifi_standby") or {}
            ni = snap.get("net_info") or {}
            if sb.get("ready") and snap.get("device_id") == job["device_id"] and (prev is None or ni.get("ssid") == prev) and float(ni.get("updated_at") or 0) >= t0:
                return True, ""
            return ok, why

        ok, why = p.verifier.wait(back, wait_s, 2.0)
        ws = p.bridge.snapshot().get("wifi_state") or {}
        if ok and ws.get("active_ssid") == job["ssid"]:
            job["wireless"] = True
            p._set(job, secrets, "COMMITTED", f"the commit was applied after all: {job['ssid']!r} is the board's permanent network")
            return
        if ok:
            job["error_code"] = failure.code
            job["recovery"] = ["The new network was not changed on the board. Check the Wi-Fi password, that the network is 2.4 GHz, and that this laptop's gateway is reachable on it, then try again."]
            p._set(job, secrets, "ROLLED_BACK", f"{failure.message} The board is back on {prev!r}: authenticated, identity confirmed, telemetry fresh. Nothing was changed.")
            return
        job["recovery"] = ["Wait two more minutes; the board restores its previous network when its trial ends.",
                           "If it stays offline, connect it by USB with motor power disconnected and run Configure & Connect to set the network again."]
        p._fail(job, secrets, "DEVICE_LOST", f"{failure.message} The board has not come back on its previous network ({why}).")
