"""HTTP surface of the Firmware Manager (firmware.py). Mounted by torqva.api.create_router.

Authority: reading (device firmware status, releases, deployments) needs any signed-in role; uploading a release and deploying it are ADMIN only and audited.
The two device-facing routes (/firmware/ota/{release}/manifest and /image) take no bearer token (the device has none): they need the one-time token of the
active deployment, are valid only for that release, and answer every failure the same way. They must be served over HTTPS at the device-facing URL
(TORQVA_OTA_PUBLIC_BASE_URL, behind a TLS-terminating reverse proxy or uvicorn --ssl-*): the device verifies the certificate and never falls back to HTTP.
Nothing here starts, stops or configures the motor.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from fastapi import Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from .auth import Principal
from .compiler import CompilerError, FirmwareCompiler, docker_status
from .firmware import FirmwareError, FirmwareManager
from .schemas import Role

MAX_UPLOAD_READ = 8 * 1024 * 1024          # read at most this much from a request, whatever the configured image limit
MAX_SOURCE_UPLOAD = 10 * 1024 * 1024


class DeployIn(BaseModel):
    release_id: str = Field(pattern=r"^[0-9a-f]{12}$")
    device_id: str = Field(default="", max_length=64)


class RollbackIn(BaseModel):
    release_id: Optional[str] = Field(default=None, pattern=r"^[0-9a-f]{12}$")
    device_id: str = Field(default="", max_length=64)
    slot_rollback: bool = False


class CompileEditorIn(BaseModel):
    files: Dict[str, str]
    version: str = Field(default="", max_length=24)
    profile: str = Field(default="esp32s3_wireless", max_length=40)
    notes: str = Field(default="", max_length=2000)
    description: str = Field(default="", max_length=500)
    signature: str = Field(default="", max_length=200)
    auto_upload: bool = True
    auto_deploy: bool = False
    device_id: str = Field(default="", max_length=64)


def _http(e: FirmwareError) -> HTTPException:
    return HTTPException(status_code=e.status, detail={"code": e.code, "message": e.detail})


def _chttp(e: CompilerError) -> HTTPException:
    return HTTPException(status_code=e.status, detail={"code": e.code, "message": e.detail})


def add_firmware_routes(r, service, need: Callable, audit: Callable) -> None:
    if getattr(service, "firmware", None) is None:
        service.firmware = FirmwareManager(getattr(service, "bridge", None))
    fm: FirmwareManager = service.firmware
    if getattr(service, "compiler", None) is None:
        service.compiler = FirmwareCompiler(fm)
    comp: FirmwareCompiler = service.compiler

    @r.get("/firmware/docker")
    def firmware_docker(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        return docker_status()

    @r.get("/firmware/workspace/templates")
    def firmware_templates(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        return {"templates": comp.templates(), "profiles": ["esp32s3_wireless", "esp32s3", "esp32s3_ota_led_v112"]}

    @r.get("/firmware/workspace/files")
    def firmware_workspace_files(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        return {"files": comp.default_workspace_files()}

    @r.post("/firmware/compile/editor")
    def firmware_compile_editor(body: CompileEditorIn, p: Principal = Depends(need(Role.ADMIN))) -> Dict[str, Any]:
        try:
            job = comp.start_compile(
                user=p.user,
                version=body.version,
                profile=body.profile,
                files=body.files,
                signature=body.signature,
                notes=body.notes,
                description=body.description,
                auto_upload=body.auto_upload,
                auto_deploy=body.auto_deploy,
                device_id=body.device_id,
            )
        except CompilerError as e:
            raise _chttp(e)
        audit(p, "firmware_compile_started", job=job["id"], profile=job["profile"], version=job["version"], auto_deploy=body.auto_deploy)
        return job

    @r.post("/firmware/compile/upload")
    async def firmware_compile_upload(
        file: UploadFile = File(...),
        version: str = Form(""),
        profile: str = Form("esp32s3_wireless"),
        signature: str = Form(""),
        notes: str = Form(""),
        description: str = Form(""),
        auto_upload: bool = Form(True),
        auto_deploy: bool = Form(False),
        device_id: str = Form(""),
        p: Principal = Depends(need(Role.ADMIN)),
    ) -> Dict[str, Any]:
        data = await file.read(MAX_SOURCE_UPLOAD + 1)
        if len(data) > MAX_SOURCE_UPLOAD:
            raise HTTPException(status_code=413, detail={"code": "TOO_LARGE", "message": "uploaded file exceeds 10 MB"})
        try:
            job = comp.start_compile(
                user=p.user,
                version=version,
                profile=profile,
                single_filename=file.filename or "sketch.ino",
                single_bytes=data,
                signature=signature,
                notes=notes,
                description=description,
                auto_upload=auto_upload,
                auto_deploy=auto_deploy,
                device_id=device_id,
            )
        except CompilerError as e:
            raise _chttp(e)
        audit(p, "firmware_compile_upload", job=job["id"], filename=(file.filename or "")[:64], profile=job["profile"])
        return job

    @r.get("/firmware/compile")
    def firmware_compile_list(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        return {"jobs": comp.list_jobs()}

    @r.get("/firmware/compile/{job_id}")
    def firmware_compile_status(job_id: str, p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        try:
            return comp.get_job(job_id)
        except CompilerError as e:
            raise _chttp(e)

    @r.post("/firmware/rollback")
    def firmware_rollback(body: RollbackIn, p: Principal = Depends(need(Role.ADMIN))) -> Dict[str, Any]:
        try:
            if body.slot_rollback or not body.release_id:
                res = fm.rollback_slot(p.user, p.role)
                audit(p, "firmware_slot_rollback", user=p.user)
                return res
            dep = fm.deploy(body.release_id, body.device_id, p.user, rollback=True)
            audit(p, "firmware_rollback_requested", deployment=dep["id"], release=dep["release"], version=dep["version"], device=dep["device_id"])
            return dep
        except FirmwareError as e:
            raise _http(e)

    @r.get("/firmware/status")
    def firmware_status(p: Principal = Depends(need(Role.VIEWER))) -> Dict[str, Any]:
        dev = fm.device()
        return {"device": dev, "config": fm.config(), "current": fm.current(), "eligibility": fm.eligibility(None, dev.get("device_id") or ""),
                "motor_operation": "Firmware updates never enable motor operation. Physical operation is directly controlled by the operator on Overview."}

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
                              p: Principal = Depends(need(Role.ADMIN))) -> Dict[str, Any]:
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
    def firmware_deploy(body: DeployIn, p: Principal = Depends(need(Role.ADMIN))) -> Dict[str, Any]:
        try:
            dep = fm.deploy(body.release_id, body.device_id, p.user)
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
    def ota_image(rid: str, request: Request, t: str = Query("", max_length=64)) -> Response:
        try:
            path = fm.image_file(rid, t)
        except FirmwareError:
            raise HTTPException(status_code=403, detail="download not authorized")
        rng = request.headers.get("range", "").strip()
        if rng.startswith("bytes="):
            total = path.stat().st_size
            spec = rng[6:].split(",", 1)[0].strip()
            s_part, _, e_part = spec.partition("-")
            try:
                start = int(s_part) if s_part else max(0, total - int(e_part))
                end = int(e_part) if (s_part and e_part) else total - 1
            except ValueError:
                start, end = -1, -1
            if start < 0 or end < start or start >= total:
                raise HTTPException(status_code=416, detail="requested range not satisfiable", headers={"Content-Range": f"bytes */{total}"})
            end = min(end, total - 1)
            with path.open("rb") as fh:
                fh.seek(start)
                chunk = fh.read(end - start + 1)
            return Response(
                content=chunk,
                status_code=206,
                media_type="application/octet-stream",
                headers={
                    "Content-Range": f"bytes {start}-{end}/{total}",
                    "Accept-Ranges": "bytes",
                    "Content-Length": str(len(chunk)),
                    "Cache-Control": "no-store",
                },
            )
        return FileResponse(path, media_type="application/octet-stream", headers={"Cache-Control": "no-store", "Accept-Ranges": "bytes"})
