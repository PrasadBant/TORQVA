"""HTTP surface of the Firmware Manager (firmware.py). Mounted by torqva.api.create_router.

Authority: reading (device firmware status, releases, deployments) needs any signed-in role; uploading a release and deploying it are ADMIN only and audited.
The two device-facing routes (/firmware/ota/{release}/manifest and /image) take no bearer token (the device has none): they need the one-time token of the
active deployment, are valid only for that release, and answer every failure the same way. They must be served over HTTPS at the device-facing URL
(TORQVA_OTA_PUBLIC_BASE_URL, behind a TLS-terminating reverse proxy or uvicorn --ssl-*): the device verifies the certificate and never falls back to HTTP.
Nothing here starts, stops or configures the motor.
"""
from __future__ import annotations

from typing import Any, Callable, Dict

from fastapi import Depends, File, Form, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel, Field

from .auth import Principal
from .firmware import FirmwareError, FirmwareManager
from .schemas import Role

MAX_UPLOAD_READ = 8 * 1024 * 1024          # read at most this much from a request, whatever the configured image limit


class DeployIn(BaseModel):
    release_id: str = Field(pattern=r"^[0-9a-f]{12}$")
    device_id: str = Field(default="", max_length=64)
    confirm: str = Field(default="", max_length=120)
    bench_power_disconnected: bool = False


def _http(e: FirmwareError) -> HTTPException:
    return HTTPException(status_code=e.status, detail={"code": e.code, "message": e.detail})


def add_firmware_routes(r, service, need: Callable, audit: Callable) -> None:
    if getattr(service, "firmware", None) is None:
        service.firmware = FirmwareManager(getattr(service, "bridge", None))
    fm: FirmwareManager = service.firmware

    @r.get("/firmware/status")
    def firmware_status(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        dev = fm.device()
        return {"device": dev, "config": fm.config(), "current": fm.current(), "eligibility": fm.eligibility(None, dev.get("device_id") or ""),
                "motor_operation": "Firmware updates never enable motor operation. Physical operation stays governed by Device & Safety (commissioning, interlocks, Safety Supervisor)."}

    @r.get("/firmware/releases")
    def firmware_releases(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        return {"releases": fm.releases(), "config": fm.config()}

    @r.get("/firmware/releases/{rid}")
    def firmware_release(rid: str, p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        try:
            rec = fm.public_release(fm.release(rid))
        except FirmwareError as e:
            raise _http(e)
        dev = fm.device()
        rec["eligibility"] = fm.eligibility(fm.release(rid), dev.get("device_id") or "")
        return rec

    @r.post("/firmware/releases")
    async def firmware_upload(file: UploadFile = File(...), signature: str = Form(""), version: str = Form(""), notes: str = Form(""), description: str = Form(""),
                              p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        name = (file.filename or "").lower()
        if not name.endswith(".bin"):
            raise HTTPException(status_code=400, detail={"code": "NOT_A_BIN", "message": "upload the compiled application image (.bin); source files, bootloaders and partition tables are not accepted"})
        data = await file.read(min(MAX_UPLOAD_READ, fm.max_bytes + 1))
        if len(data) > fm.max_bytes:
            raise HTTPException(status_code=413, detail={"code": "TOO_LARGE", "message": f"larger than the inactive OTA partition ({fm.max_bytes} bytes)"})
        try:
            rec = fm.upload(data, signature[:200], p.user, version.strip()[:24], notes, description)
        except FirmwareError as e:
            audit(p, "firmware_upload_rejected", file=name[:64], code=e.code)
            raise _http(e)
        audit(p, "firmware_uploaded", release=rec["id"], version=rec["version"], sha256=rec["sha256"], deployable=rec["deployable"])
        return rec

    @r.post("/firmware/deployments")
    def firmware_deploy(body: DeployIn, p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        try:
            dep = fm.deploy(body.release_id, body.device_id, p.user, body.confirm, body.bench_power_disconnected)
        except FirmwareError as e:
            audit(p, "firmware_deploy_refused", release=body.release_id, device=body.device_id, code=e.code, reason=e.detail[:200])
            raise _http(e)
        audit(p, "firmware_deploy_requested", deployment=dep["id"], release=dep["release"], version=dep["version"], device=dep["device_id"], state=dep["state"])
        return dep

    @r.get("/firmware/deployments")
    def firmware_deployments(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        return {"current": fm.current(), "history": fm.store.history(200)}

    @r.get("/firmware/deployments/{dep_id}")
    def firmware_deployment(dep_id: str, p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        try:
            return fm.deployment(dep_id)
        except FirmwareError as e:
            raise _http(e)

    # ---- device-facing (one-time token; no bearer)
    @r.get("/firmware/ota/{rid}/manifest")
    def ota_manifest(rid: str, t: str = Query("", max_length=64)) -> Dict[str, Any]:
        try:
            return fm.manifest(rid, t)
        except FirmwareError:
            raise HTTPException(status_code=403, detail="download not authorized")

    @r.get("/firmware/ota/{rid}/image")
    def ota_image(rid: str, t: str = Query("", max_length=64)) -> Response:
        try:
            data = fm.image(rid, t)
        except FirmwareError:
            raise HTTPException(status_code=403, detail="download not authorized")
        return Response(content=data, media_type="application/octet-stream", headers={"Cache-Control": "no-store", "Content-Length": str(len(data))})
