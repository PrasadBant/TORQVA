"""HTTP surface of Wi-Fi provisioning (torqva.device.provisioning / network_switch).

ADMIN starts jobs (they rewrite the board's NVS and restart it, or change its network) and may scan; any signed-in role may read status, history and job progress.
The Wi-Fi password is accepted only in the POST body, is never echoed back, never logged, never stored on a job record and never written to the audit log. Field
validation for the password happens in the service, not in pydantic, because FastAPI's 422 responses echo the offending input.
"""
from __future__ import annotations

from typing import Any, Callable, Dict

from fastapi import Depends, HTTPException, Query
from pydantic import BaseModel, Field

from torqva.access.auth import Principal
from torqva.device.provisioning import ProvisioningError, run_scan
from torqva.models.schemas import Role


class WifiProvisionIn(BaseModel):
    device_id: str = Field(max_length=32)
    port: str = Field(max_length=32)
    ssid: str = Field(max_length=64)
    password: str = Field(default="", max_length=256)          # validated by the service; never echoed
    base_url: str = Field(default="", max_length=256)           # empty = automatic LAN address
    confirm_physical: bool = False
    erase_damaged_nvs: bool = False                             # explicit recovery: rebuild an unreadable NVS partition (unreadable saved settings are lost)


class NetworkSwitchIn(BaseModel):
    device_id: str = Field(max_length=32)
    ssid: str = Field(max_length=64)
    password: str = Field(default="", max_length=256)
    base_url: str = Field(default="", max_length=256)
    trial_s: int = Field(default=0, ge=0, le=600)


class RecoveryClearIn(BaseModel):
    confirm: bool = False


class GatewayCertIn(BaseModel):
    host: str = Field(default="", max_length=64)                # empty = this laptop's detected LAN address


def add_provisioning_routes(r, service, need: Callable, audit: Callable) -> None:
    def _http(exc: ProvisioningError) -> HTTPException:
        return HTTPException(exc.status, {"code": exc.code, "message": exc.message})

    @r.get("/provisioning/status")
    def provisioning_status(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        return service.provisioner.status()

    @r.get("/provisioning/history")
    def provisioning_history(limit: int = Query(20, ge=1, le=100), p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        return {"jobs": service.provisioner.history_list(limit)}

    @r.post("/provisioning/scan")
    def provisioning_scan(p: Principal = Depends(need(Role.ADMIN))) -> Dict[str, Any]:
        prov = service.provisioner
        try:
            return run_scan(prov.bridge, p.user, lock=prov.lock, cache=prov._scan_cache, clock=prov.clock, sleep=prov.sleep)
        except ProvisioningError as exc:
            raise _http(exc)

    @r.post("/provisioning/jobs")
    def provisioning_start(body: WifiProvisionIn, p: Principal = Depends(need(Role.ADMIN))) -> Dict[str, Any]:
        prov = service.provisioner
        try:
            base_url = body.base_url.strip() or prov.default_base_url()
            job = prov.start(device_id=body.device_id.strip(), port=body.port.strip(), ssid=body.ssid, password=body.password,
                             base_url=base_url, user=p.user, confirm_physical=body.confirm_physical, erase_damaged_nvs=body.erase_damaged_nvs)
        except ProvisioningError as exc:
            raise _http(exc)
        # The audit record names the network but never the password, the key or the CA.
        audit(p, "device_wifi_provisioning_started", job=job["id"], device=job["device_id"], port=job["port"], ssid=job["ssid"], base_url=job["base_url"])
        return job

    @r.post("/provisioning/network-switch")
    def provisioning_switch(body: NetworkSwitchIn, p: Principal = Depends(need(Role.ADMIN))) -> Dict[str, Any]:
        try:
            job = service.network_switcher.start(device_id=body.device_id.strip(), ssid=body.ssid, password=body.password, base_url=body.base_url,
                                                 user=p.user, trial_s=body.trial_s)
        except ProvisioningError as exc:
            raise _http(exc)
        audit(p, "device_wifi_network_switch_started", job=job["id"], device=job["device_id"], ssid=job["ssid"], base_url=job["base_url"])
        return job

    @r.get("/provisioning/jobs/{job_id}")
    def provisioning_job(job_id: str, p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        try:
            return service.provisioner.get(job_id)
        except ProvisioningError as exc:
            raise _http(exc)

    @r.post("/provisioning/recovery/clear")
    def provisioning_recovery_clear(body: RecoveryClearIn, p: Principal = Depends(need(Role.ADMIN))) -> Dict[str, Any]:
        """Operator override after checking the board by hand. A verified USB provisioning run clears this by itself."""
        if not body.confirm:
            raise HTTPException(409, {"code": "CONFIRMATION_REQUIRED", "message": "confirm that you checked the board's configuration before clearing the recovery block"})
        service.provisioner.clear_recovery(p.user)
        audit(p, "device_wifi_recovery_cleared")
        return {"cleared": True}

    @r.post("/provisioning/gateway-cert")
    def provisioning_gateway_cert(body: GatewayCertIn, p: Principal = Depends(need(Role.ADMIN))) -> Dict[str, Any]:
        """Reissue the HTTPS gateway certificate for this laptop's current address (same bench CA, so provisioned boards keep trusting it). The gateway must be restarted."""
        prov = service.provisioner
        try:
            host = body.host.strip() or prov.lan_ip()
            result = prov.reissue_gateway_cert(host)
        except ProvisioningError as exc:
            raise _http(exc)
        audit(p, "gateway_certificate_reissued", host=host)
        return result
