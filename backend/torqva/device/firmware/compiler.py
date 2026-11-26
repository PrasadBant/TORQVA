"""Isolated Docker + PlatformIO Firmware Compilation Engine.

Supports:
  - Single source files: .ino, .cpp, .c, .h, .hpp
  - Multi-file source editor projects (file path -> source text)
  - Project ZIP archives (validated against path traversal, symlinks, and oversized inputs)
  - Direct compiled .bin application images (validated, not compiled)

Isolation guarantees:
  - Runs inside `torqva-pio:latest` via `docker run --rm`
  - `--network none` (all PlatformIO toolchains/libs are pre-baked in `/opt/pio`)
  - `--read-only` root filesystem + isolated `/workspace` mount for the single job only
  - `--cap-drop ALL`, `--security-opt no-new-privileges`, memory/CPU/PID limits
  - Zero access to host secrets, `device_keys.json`, or private ECDSA signing keys
  - Optional post-build release signing occurs strictly on the host AFTER the container exits
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from torqva.device.firmware.firmware import (
    CHIP_ESP32S3,
    FirmwareError,
    FirmwareManager,
    canonical,
    firmware_identity,
    parse_esp_image,
    parse_version,
)

REPO_ROOT = Path(__file__).resolve().parents[4]
FW_SCAFFOLD_DIR = REPO_ROOT / "firmware"
DOCKER_IMAGE = os.environ.get("TORQVA_PIO_IMAGE", "torqva-pio:latest")
COMPILE_TIMEOUT_S = int(os.environ.get("TORQVA_COMPILE_TIMEOUT_S", "180"))
MAX_ZIP_BYTES = 10 * 1024 * 1024
MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024
MAX_PROJECT_FILES = 200
MAX_SOURCE_FILE_BYTES = 512 * 1024

ALLOWED_SOURCE_EXTS = {".ino", ".cpp", ".c", ".h", ".hpp"}
ALLOWED_ZIP_EXTS = ALLOWED_SOURCE_EXTS | {".ini", ".csv", ".json", ".txt", ".md"}
VALID_PROFILES = {
    "esp32s3_wireless": "Production wireless + motor controller (esp32s3_wireless)",
    "esp32s3": "Production USB + OTA (esp32s3)",
    "esp32s3_ota_led_v112": "Wireless OTA LED Bench (esp32s3_ota_led_v112)",
}

DIAGNOSTIC_RE = re.compile(
    r"^(?P<file>[^\s:][^:]*):(?P<line>\d+):(?P<col>\d+):\s*(?P<severity>fatal error|error|warning|note):\s*(?P<message>.+)$"
)
RAM_RE = re.compile(r"RAM:\s+\[.*?\]\s+([\d.]+)%\s+\(used\s+(\d+)\s+bytes\s+from\s+(\d+)\s+bytes\)")
FLASH_RE = re.compile(r"Flash:\s+\[.*?\]\s+([\d.]+)%\s+\(used\s+(\d+)\s+bytes\s+from\s+(\d+)\s+bytes\)")


class CompilerError(Exception):
    def __init__(self, code: str, detail: str, status: int = 400):
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.status = status


def docker_status() -> Dict[str, Any]:
    """Check real Docker daemon availability and whether the compilation image is present."""
    try:
        info_proc = subprocess.run(
            ["docker", "info", "--format", "{{.ServerVersion}}"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if info_proc.returncode != 0:
            err = (info_proc.stderr or info_proc.stdout or "docker info failed").strip()
            return {"available": False, "server_version": None, "image": DOCKER_IMAGE, "image_ready": False, "error": err}
        server_ver = info_proc.stdout.strip()
        img_proc = subprocess.run(
            ["docker", "image", "inspect", DOCKER_IMAGE, "--format", "{{.Id}}"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        image_ready = img_proc.returncode == 0
        return {
            "available": True,
            "server_version": server_ver,
            "image": DOCKER_IMAGE,
            "image_ready": image_ready,
            "image_id": img_proc.stdout.strip()[:19] if image_ready else None,
            "error": None if image_ready else f"Docker image {DOCKER_IMAGE!r} not built yet",
        }
    except FileNotFoundError:
        return {"available": False, "server_version": None, "image": DOCKER_IMAGE, "image_ready": False, "error": "docker CLI not found on PATH"}
    except subprocess.TimeoutExpired:
        return {"available": False, "server_version": None, "image": DOCKER_IMAGE, "image_ready": False, "error": "docker daemon timed out"}
    except OSError as exc:
        return {"available": False, "server_version": None, "image": DOCKER_IMAGE, "image_ready": False, "error": str(exc)}


def _safe_rel_path(raw: str) -> str:
    norm = raw.replace("\\", "/").strip().lstrip("/")
    if not norm or ".." in norm.split("/") or norm.startswith("/") or ":" in norm:
        raise CompilerError("BAD_PATH", f"unsafe relative path: {raw!r}")
    if any(part.startswith(".") and part not in (".", ) for part in norm.split("/")):
        raise CompilerError("BAD_PATH", f"hidden files are not permitted in workspace: {raw!r}")
    return norm


def _parse_diagnostics(lines: List[str]) -> List[Dict[str, Any]]:
    diags: List[Dict[str, Any]] = []
    for ln in lines:
        m = DIAGNOSTIC_RE.match(ln.strip())
        if m:
            diags.append({
                "file": m.group("file").replace("/workspace/", ""),
                "line": int(m.group("line")),
                "col": int(m.group("col")),
                "severity": m.group("severity"),
                "message": m.group("message").strip(),
            })
    return diags[:100]


def _extract_memory_usage(text: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    rm = RAM_RE.search(text)
    if rm:
        out["ram_pct"] = float(rm.group(1))
        out["ram_used_bytes"] = int(rm.group(2))
        out["ram_total_bytes"] = int(rm.group(3))
    fm = FLASH_RE.search(text)
    if fm:
        out["flash_pct"] = float(fm.group(1))
        out["flash_used_bytes"] = int(fm.group(2))
        out["flash_total_bytes"] = int(fm.group(3))
    return out


PUBLIC_BOARD_SOURCES = (
    "main.cpp",
    "drivers/config_pins.h",
    "communication/ota_esp32.h",
    "communication/ota_esp32.cpp",
    "communication/usb_out.h",
    "communication/usb_out.cpp",
    "communication/wifi_link.h",
    "communication/wifi_link.cpp",
)


def _copy_public_scaffold(job_dir: Path, public_key_pem_path: Optional[str]) -> None:
    """Populate job_dir with ONLY public firmware sources (never private keys, host secrets, or backend data)."""
    if not FW_SCAFFOLD_DIR.exists():
        raise CompilerError("SCAFFOLD_MISSING", "ESP32 firmware scaffold not found", 500)
    shutil.copy2(FW_SCAFFOLD_DIR / "platformio.ini", job_dir / "platformio.ini")
    lib_dst = job_dir / "lib" / "torqva_core"
    shutil.copytree(FW_SCAFFOLD_DIR / "lib" / "torqva_core", lib_dst)
    src_dst = job_dir / "src"
    src_dst.mkdir(parents=True, exist_ok=True)
    for fname in PUBLIC_BOARD_SOURCES:
        p = FW_SCAFFOLD_DIR / "src" / fname
        if p.exists():
            destination = src_dst / fname
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, destination)
    # Public verification key header (NEVER any private signing key)
    if public_key_pem_path and Path(public_key_pem_path).exists():
        pem_text = Path(public_key_pem_path).read_text(encoding="utf-8", errors="replace").strip()
        if "PRIVATE" in pem_text:
            raise CompilerError("UNSAFE_KEY", "refusing to place a private key inside firmware build workspace", 500)
        lines = pem_text.splitlines()
        body = "\n".join(f'    "{ln}\\n"' for ln in lines)
        (src_dst / "ota_pubkey.h").write_text(
            "// Public verification key exported for compilation (not a secret).\n"
            f"#pragma once\nstatic const char TORQVA_OTA_PUBKEY_PEM[] =\n{body};\n",
            encoding="utf-8",
        )
    elif (FW_SCAFFOLD_DIR / "src" / "ota_pubkey.h").exists():
        shutil.copy2(FW_SCAFFOLD_DIR / "src" / "ota_pubkey.h", src_dst / "ota_pubkey.h")


def _wrap_arduino_sketch(sketch_code: str, version: str, src_dir: Path, filename: str = "sketch.ino") -> None:
    """Integrate a user-uploaded Arduino (.ino) or standalone C++ sketch into TORQVA wireless firmware
    so that it retains Wi-Fi connectivity, OTA update handler, TORQVA_FW_ID, and TORQVA protocol."""
    has_torqva_fw = "TORQVA_FW_ID" in sketch_code and "ota_platform_start" in sketch_code
    if has_torqva_fw:
        # User provided full TORQVA firmware main source: write directly as main.cpp
        (src_dir / "main.cpp").write_text(sketch_code, encoding="utf-8")
        return

    # Standalone Arduino/C++ sketch: preserve user setup()/loop() via wrapper macros inside a separate unit
    # and call them cleanly alongside TORQVA's wireless + OTA tasks.
    wrapped_user = (
        "#include <Arduino.h>\n"
        "#define setup torqva_user_setup\n"
        "#define loop torqva_user_loop\n"
        f"// --- User sketch ({filename}) ---\n"
        + sketch_code
        + "\n#undef setup\n#undef loop\n"
    )
    (src_dir / "user_sketch.cpp").write_text(wrapped_user, encoding="utf-8")

    # Hook torqva_user_setup / torqva_user_loop cleanly into main.cpp
    main_path = src_dir / "main.cpp"
    main_txt = main_path.read_text(encoding="utf-8")
    if "torqva_user_setup" not in main_txt:
        hook_decl = (
            "\nextern void torqva_user_setup();\n"
            "extern void torqva_user_loop();\n"
            "static void user_sketch_task(void*) {\n"
            "    torqva_user_setup();\n"
            "    for (;;) { torqva_user_loop(); delay(10); }\n"
            "}\n"
        )
        main_txt = main_txt.replace("void setup() {", hook_decl + "\nvoid setup() {", 1)
        main_txt = main_txt.replace(
            "ota_platform_start(",
            "xTaskCreatePinnedToCore(user_sketch_task, \"user_sketch\", 4096, nullptr, 1, nullptr, 1);\n    ota_platform_start(",
            1,
        )
        main_path.write_text(main_txt, encoding="utf-8")


def _extract_zip_into_workspace(zip_bytes: bytes, job_dir: Path, target_version: str) -> None:
    if len(zip_bytes) > MAX_ZIP_BYTES:
        raise CompilerError("ZIP_TOO_LARGE", f"ZIP archive exceeds {MAX_ZIP_BYTES} bytes", 413)
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as exc:
        raise CompilerError("BAD_ZIP", f"invalid ZIP archive: {exc}") from exc

    infos = zf.infolist()
    if len(infos) > MAX_PROJECT_FILES:
        raise CompilerError("TOO_MANY_FILES", f"ZIP archive contains more than {MAX_PROJECT_FILES} entries")

    total_uncompressed = 0
    extracted: Dict[str, bytes] = {}
    for info in infos:
        if info.is_dir():
            continue
        # Reject symlinks (external_attr Unix symlink bit 0120000)
        if (info.external_attr >> 16) & 0o170000 == 0o120000:
            raise CompilerError("UNSAFE_ZIP", f"symlinks are not allowed in ZIP: {info.filename!r}")
        rel = _safe_rel_path(info.filename)
        total_uncompressed += info.file_size
        if total_uncompressed > MAX_UNCOMPRESSED_BYTES:
            raise CompilerError("ZIP_TOO_LARGE", "uncompressed ZIP contents exceed 20 MB", 413)
        ext = Path(rel).suffix.lower()
        if ext not in ALLOWED_ZIP_EXTS:
            raise CompilerError("UNSUPPORTED_FILE", f"file extension {ext!r} not allowed in ZIP ({rel})")
        extracted[rel] = zf.read(info)

    # Strip common single top-level directory if present (e.g. my_fw/src/main.cpp -> src/main.cpp)
    tops = {p.split("/", 1)[0] for p in extracted if "/" in p}
    if len(tops) == 1 and all("/" in p for p in extracted):
        prefix = next(iter(tops)) + "/"
        extracted = {p[len(prefix):]: b for p, b in extracted.items()}

    src_dir = job_dir / "src"
    has_ino = any(p.endswith(".ino") for p in extracted)
    has_main = any(p in ("src/main.cpp", "main.cpp") for p in extracted)

    for rel, content in extracted.items():
        if rel in ("platformio.ini",):
            continue  # Keep validated partition table & TORQVA wireless flags
        dest_rel = rel if (rel.startswith("src/") or rel.startswith("include/") or rel.startswith("lib/")) else f"src/{rel}"
        dest = (job_dir / dest_rel).resolve()
        if job_dir.resolve() not in dest.parents:
            raise CompilerError("BAD_PATH", f"path escapes workspace: {rel!r}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        if rel.endswith(".ino") and not has_main:
            _wrap_arduino_sketch(content.decode("utf-8", errors="replace"), target_version, src_dir, filename=rel)
        else:
            dest.write_bytes(content)

    if not has_ino and not has_main:
        # Check if user put another .cpp with setup()/loop()
        for rel, content in extracted.items():
            if rel.endswith(".cpp"):
                txt = content.decode("utf-8", errors="replace")
                if "void setup(" in txt and "void loop(" in txt:
                    _wrap_arduino_sketch(txt, target_version, src_dir, filename=rel)
                    break


def _apply_version_to_platformio(job_dir: Path, version: str, profile: str) -> None:
    ini_path = job_dir / "platformio.ini"
    ini = ini_path.read_text(encoding="utf-8")
    # Pin espressif32 to match the offline Docker toolchain and resolve libs from /opt/pio_libs offline
    ini = re.sub(r"^platform\s*=\s*espressif32\s*$", "platform = espressif32@7.1.3", ini, flags=re.MULTILINE)
    ini = re.sub(r"lib_deps\s*=.*?(?=\n\[|\n[a-z_]+\s*=|\Z)", "lib_extra_dirs = /opt/pio_libs\n", ini, flags=re.DOTALL)
    # Append/override TORQVA_FW_VERSION in the selected env build_flags
    ver_flag = f'-DTORQVA_FW_VERSION=\\"{version}\\"'
    section = f"[env:{profile}]"
    if section not in ini:
        raise CompilerError("BAD_PROFILE", f"unsupported build profile {profile!r}")
    idx = ini.index(section)
    next_sec = ini.find("\n[env:", idx + len(section))
    block = ini[idx:] if next_sec < 0 else ini[idx:next_sec]
    if "TORQVA_FW_VERSION" in block:
        block = re.sub(r'-DTORQVA_FW_VERSION=\\"[^"]*\\"', ver_flag, block)
    elif "build_flags =" in block:
        block = block.replace("build_flags =", f"build_flags = {ver_flag}", 1)
    else:
        block = block.rstrip() + f"\nbuild_flags = ${{env:esp32s3.build_flags}} {ver_flag}\n"
    new_ini = (ini[:idx] + block) if next_sec < 0 else (ini[:idx] + block + ini[next_sec:])
    ini_path.write_text(new_ini, encoding="utf-8")


def _sign_if_configured(bin_bytes: bytes, version: str) -> str:
    """Host-only release signing after Docker exits. Never exposes key path or material to containers."""
    key_path = os.environ.get("TORQVA_OTA_SIGNING_KEY", "").strip()
    if not key_path or not Path(key_path).exists():
        return ""
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        import base64

        pw_env = os.environ.get("TORQVA_OTA_SIGNING_PASSPHRASE")
        pw = pw_env.encode("utf-8") if pw_env else None
        key = serialization.load_pem_private_key(Path(key_path).read_bytes(), password=pw)
        sha = hashlib.sha256(bin_bytes).hexdigest()
        msg = canonical(version, len(bin_bytes), sha)
        sig = base64.b64encode(key.sign(msg.encode("utf-8"), ec.ECDSA(hashes.SHA256()))).decode("ascii")
        return sig
    except Exception:
        return ""


class FirmwareCompiler:
    """Manages isolated Docker+PlatformIO compilation jobs, workspace templates, and release registration."""

    def __init__(self, firmware_manager: FirmwareManager, work_root: Optional[str] = None, auto_run: bool = True):
        self.fm = firmware_manager
        self.work_root = Path(work_root or (Path(firmware_manager.store.root) / "compile_jobs"))
        self.work_root.mkdir(parents=True, exist_ok=True)
        self.auto_run = auto_run
        self._lock = threading.RLock()
        self.jobs: Dict[str, Dict[str, Any]] = {}

    def default_workspace_files(self) -> Dict[str, str]:
        """Return editable project source files from firmware/src (never includes secrets)."""
        files: Dict[str, str] = {}
        src_dir = FW_SCAFFOLD_DIR / "src"
        for name in PUBLIC_BOARD_SOURCES:
            p = src_dir / name
            if p.exists():
                files[f"src/{name}"] = p.read_text(encoding="utf-8")
        return files

    def templates(self) -> List[Dict[str, Any]]:
        return [
            {
                "id": "torqva_wireless",
                "name": "TORQVA Wireless Firmware (Production)",
                "profile": "esp32s3_wireless",
                "description": "Full TORQVA ESP32-S3 motor controller + telemetry + Wi-Fi TLS link + OTA.",
                "files": self.default_workspace_files(),
            },
            {
                "id": "arduino_sketch_ota",
                "name": "Custom Arduino (.ino) + TORQVA OTA Bridge",
                "profile": "esp32s3_wireless",
                "description": "Standalone Arduino sketch automatically bridged with TORQVA Wi-Fi, OTA & mDNS.",
                "files": {
                    "src/custom_sketch.ino": (
                        "// Custom Arduino sketch integrated with TORQVA wireless OTA.\n"
                        "// Wi-Fi link, OTA updates, telemetry, and mDNS remain active automatically.\n\n"
                        "void setup() {\n"
                        "  // Add custom peripheral setup here\n"
                        "}\n\n"
                        "void loop() {\n"
                        "  // Runs concurrently with TORQVA control and wireless OTA tasks\n"
                        "  delay(100);\n"
                        "}\n"
                    )
                },
            },
            {
                "id": "ota_led_bench",
                "name": "TORQVA OTA LED Bench (v1.1.2)",
                "profile": "esp32s3_ota_led_v112",
                "description": "GPIO 5 LED bench firmware with Wi-Fi link and OTA self-test (no motor hardware).",
                "files": self.default_workspace_files(),
            },
        ]

    def _next_suggested_version(self) -> str:
        """Pick a version higher than both the connected device and any uploaded release."""
        candidates: List[str] = ["1.1.3"]
        dev_fw = (self.fm.device() or {}).get("firmware")
        if dev_fw and parse_version(dev_fw):
            candidates.append(dev_fw)
        for rel in self.fm.releases():
            v = rel.get("version")
            if v and parse_version(v):
                candidates.append(v)
        best = max(candidates, key=lambda s: parse_version(s) or (0, 0, 0, 0, ""))
        maj, min_, pat, _, _ = parse_version(best) or (1, 1, 2, 1, "")
        return f"{maj}.{min_}.{pat + 1}"

    def start_compile(
        self,
        *,
        user: str,
        version: str = "",
        profile: str = "esp32s3_wireless",
        files: Optional[Dict[str, str]] = None,
        single_filename: Optional[str] = None,
        single_bytes: Optional[bytes] = None,
        signature: str = "",
        notes: str = "",
        description: str = "",
        auto_upload: bool = True,
        auto_deploy: bool = False,
        device_id: str = "",
    ) -> Dict[str, Any]:
        if profile not in VALID_PROFILES:
            raise CompilerError("BAD_PROFILE", f"unsupported profile {profile!r}")
        target_ver = (version or "").strip() or self._next_suggested_version()
        if parse_version(target_ver) is None:
            raise CompilerError("BAD_VERSION", f"invalid semantic version {target_ver!r} (expected MAJOR.MINOR.PATCH)")
        if not files and not single_bytes:
            raise CompilerError("NO_SOURCE", "provide source files, a .zip project, or a .bin image")

        job_id = secrets.token_hex(6)
        job_dir = (self.work_root / job_id).resolve()
        job_dir.mkdir(parents=True, exist_ok=True)

        # Direct .bin shortcut: skip Docker compilation, run compatibility validation directly
        if single_filename and single_filename.lower().endswith(".bin") and single_bytes is not None:
            return self._handle_direct_bin(
                job_id=job_id,
                data=single_bytes,
                user=user,
                version=version.strip(),
                signature=signature,
                notes=notes,
                description=description,
                auto_upload=auto_upload,
                auto_deploy=auto_deploy,
                device_id=device_id,
            )

        # Populate isolated workspace
        _copy_public_scaffold(job_dir, self.fm.verifier.path)
        src_dir = job_dir / "src"

        if single_bytes is not None and single_filename:
            ext = Path(single_filename).suffix.lower()
            if ext == ".zip":
                _extract_zip_into_workspace(single_bytes, job_dir, target_ver)
            elif ext in ALLOWED_SOURCE_EXTS:
                if len(single_bytes) > MAX_SOURCE_FILE_BYTES:
                    raise CompilerError("FILE_TOO_LARGE", f"source file exceeds {MAX_SOURCE_FILE_BYTES} bytes", 413)
                txt = single_bytes.decode("utf-8", errors="replace")
                safe_name = _safe_rel_path(Path(single_filename).name)
                if ext == ".ino":
                    _wrap_arduino_sketch(txt, target_ver, src_dir, filename=safe_name)
                elif safe_name == "main.cpp":
                    (src_dir / "main.cpp").write_text(txt, encoding="utf-8")
                else:
                    if ext == ".cpp" and "void setup(" in txt and "void loop(" in txt and "TORQVA_FW_ID" not in txt:
                        _wrap_arduino_sketch(txt, target_ver, src_dir, filename=safe_name)
                    else:
                        (src_dir / safe_name).write_text(txt, encoding="utf-8")
            else:
                raise CompilerError("UNSUPPORTED_FILE", f"unsupported file extension {ext!r}")

        if files:
            if len(files) > MAX_PROJECT_FILES:
                raise CompilerError("TOO_MANY_FILES", "too many files in editor project")
            for raw_path, content in files.items():
                rel = _safe_rel_path(raw_path)
                ext = Path(rel).suffix.lower()
                if ext not in ALLOWED_SOURCE_EXTS:
                    raise CompilerError("UNSUPPORTED_FILE", f"unsupported extension {ext!r} for {rel}")
                if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_SOURCE_FILE_BYTES:
                    raise CompilerError("FILE_TOO_LARGE", f"file {rel} exceeds {MAX_SOURCE_FILE_BYTES} bytes")
                if ext == ".ino":
                    _wrap_arduino_sketch(content, target_ver, src_dir, filename=rel)
                else:
                    dest_rel = rel if (rel.startswith("src/") or rel.startswith("include/") or rel.startswith("lib/")) else f"src/{rel}"
                    dest = (job_dir / dest_rel).resolve()
                    if job_dir.resolve() not in dest.parents:
                        raise CompilerError("BAD_PATH", f"unsafe path {rel!r}")
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_text(content, encoding="utf-8")

        _apply_version_to_platformio(job_dir, target_ver, profile)

        job = {
            "id": job_id,
            "state": "QUEUED",
            "profile": profile,
            "version": target_ver,
            "requested_by": user,
            "created_at": time.time(),
            "finished_at": None,
            "duration_s": None,
            "logs": [f"[torqva] Prepared isolated workspace for {target_ver} ({profile})"],
            "diagnostics": [],
            "memory": {},
            "compatibility": {},
            "release": None,
            "deployment": None,
            "error": None,
            "_dir": str(job_dir),
            "_sig": signature,
            "_notes": notes or f"Compiled from source ({profile})",
            "_desc": description,
            "_auto_upload": auto_upload,
            "_auto_deploy": auto_deploy,
            "_device_id": device_id,
        }
        with self._lock:
            self.jobs[job_id] = job
            if len(self.jobs) > 40:
                oldest = sorted(self.jobs.values(), key=lambda j: j["created_at"])[0]["id"]
                if oldest != job_id:
                    self.jobs.pop(oldest, None)

        if self.auto_run:
            t = threading.Thread(target=self._run_job, args=(job_id,), daemon=True, name=f"torqva-compile-{job_id}")
            t.start()
        return self.public_job(job)

    def _handle_direct_bin(
        self,
        *,
        job_id: str,
        data: bytes,
        user: str,
        version: str,
        signature: str,
        notes: str,
        description: str,
        auto_upload: bool,
        auto_deploy: bool,
        device_id: str,
    ) -> Dict[str, Any]:
        logs = [f"[torqva] Received pre-compiled .bin image ({len(data)} bytes); verifying compatibility..."]
        try:
            sig = signature.strip()
            ident = firmware_identity(data)
            if not sig:
                sig = _sign_if_configured(data, ident["ver"])
            rec, checks = self.fm.validate(data, sig, version)
            compat = self._compatibility_report(data, rec)
            rel_out = None
            dep_out = None
            if auto_upload:
                rel_out = self.fm.upload(data, sig, user, version, notes, description)
                logs.append(f"[torqva] Registered release {rel_out['id']} (v{rel_out['version']}, deployable={rel_out['deployable']})")
                if auto_deploy and rel_out.get("deployable"):
                    dep_out = self.fm.deploy(rel_out["id"], device_id, user)
                    logs.append(f"[torqva] Initiated OTA deployment {dep_out['id']}")
            job = {
                "id": job_id,
                "state": "SUCCEEDED",
                "profile": rec.get("profile", ""),
                "version": rec["version"],
                "requested_by": user,
                "created_at": time.time(),
                "finished_at": time.time(),
                "duration_s": 0.0,
                "logs": logs,
                "diagnostics": [],
                "memory": {"flash_used_bytes": len(data), "flash_total_bytes": self.fm.max_bytes, "flash_pct": round(100.0 * len(data) / self.fm.max_bytes, 1)},
                "compatibility": compat,
                "release": rel_out,
                "deployment": dep_out,
                "error": None,
            }
        except FirmwareError as exc:
            logs.append(f"[error] {exc.code}: {exc.detail}")
            job = {
                "id": job_id,
                "state": "FAILED",
                "profile": "",
                "version": version,
                "requested_by": user,
                "created_at": time.time(),
                "finished_at": time.time(),
                "duration_s": 0.0,
                "logs": logs,
                "diagnostics": [{"file": "firmware.bin", "line": 0, "col": 0, "severity": "error", "message": f"{exc.code}: {exc.detail}"}],
                "memory": {},
                "compatibility": {},
                "release": None,
                "deployment": None,
                "error": f"{exc.code}: {exc.detail}",
            }
        with self._lock:
            self.jobs[job_id] = job
        return self.public_job(job)

    def _compatibility_report(self, bin_data: bytes, rec: Dict[str, Any]) -> Dict[str, Any]:
        has_wifi = b"wss://" in bin_data or b"/api/torqva/device/link" in bin_data or b"wifi_link" in bin_data
        has_ota = b"TORQVA_FW_ID:" in bin_data and (b"/api/torqva/firmware/ota/" in bin_data or b"torqva_ota" in bin_data)
        return {
            "esp32s3_image": rec.get("chip") == "esp32s3",
            "torqva_fw_id": True,
            "partition_fit": rec.get("size", 0) <= self.fm.max_bytes,
            "retains_wifi_link": has_wifi,
            "retains_ota": has_ota,
            "size_bytes": rec.get("size", 0),
            "sha256": rec.get("sha256", ""),
        }

    def _run_job(self, job_id: str) -> None:
        with self._lock:
            job = self.jobs[job_id]
            # A queued job can be cancelled before its worker acquires the
            # lock.  Do not let that worker resurrect it as COMPILING.
            if job.get("_cancel_requested") or job.get("state") == "CANCELLED":
                return
            job["state"] = "COMPILING"
            job_dir = Path(job["_dir"])
            profile = job["profile"]
            target_ver = job["version"]
            job["_container"] = f"torqva-build-{job_id}"

        t0 = time.monotonic()
        container_name = f"torqva-build-{job_id}"
        cmd = [
            "docker", "run", "--rm",
            "--name", container_name,
            "--network", "none",
            "--read-only",
            "--tmpfs", "/tmp:rw,exec,nosuid,size=512m",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--memory", "2g",
            "--cpus", "2",
            "--pids-limit", "256",
            "-e", "PLATFORMIO_CORE_DIR=/tmp/pio",
            "-e", "PLATFORMIO_SETTING_ENABLE_TELEMETRY=false",
            "-e", "HOME=/tmp",
            "-v", f"{str(job_dir)}:/workspace:rw",
            DOCKER_IMAGE,
            "sh", "-c", f"mkdir -p /tmp/pio && ln -sfn /opt/pio/platforms /opt/pio/packages /tmp/pio/ && exec pio run -e {profile}",
        ]
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            with self._lock: job["_process"] = proc
            deadline = t0 + COMPILE_TIMEOUT_S
            assert proc.stdout is not None
            for raw_line in proc.stdout:
                ln = raw_line.rstrip("\r\n")
                with self._lock:
                    if len(job["logs"]) < 1500:
                        job["logs"].append(ln)
                    cancelled = bool(job.get("_cancel_requested"))
                if cancelled:
                    proc.kill(); subprocess.run(["docker", "rm", "-f", container_name], capture_output=True)
                    with self._lock: job.update({"state": "CANCELLED", "finished_at": time.time(), "duration_s": round(time.monotonic() - t0, 2), "error": "cancelled by operator"})
                    return
                if time.monotonic() > deadline:
                    proc.kill()
                    subprocess.run(["docker", "rm", "-f", container_name], capture_output=True)
                    raise CompilerError("COMPILE_TIMEOUT", f"compilation exceeded {COMPILE_TIMEOUT_S} s limit")
            rc = proc.wait(timeout=10)
            elapsed = round(time.monotonic() - t0, 2)
            full_log = "\n".join(job["logs"])
            diags = _parse_diagnostics(job["logs"])
            mem = _extract_memory_usage(full_log)
            if rc != 0:
                with self._lock:
                    job.update({
                        "state": "FAILED",
                        "finished_at": time.time(),
                        "duration_s": elapsed,
                        "diagnostics": diags,
                        "memory": mem,
                        "error": f"PlatformIO build exited with code {rc}",
                    })
                return

            bin_path = job_dir / ".pio" / "build" / profile / "firmware.bin"
            if not bin_path.exists():
                raise CompilerError("NO_BINARY", "build succeeded but firmware.bin was not produced", 500)

            bin_data = bin_path.read_bytes()
            with self._lock:
                job["state"] = "VALIDATING"
                job["logs"].append(f"[torqva] Validating compiled binary ({len(bin_data)} bytes)...")

            sig = (job.get("_sig") or "").strip()
            if not sig:
                sig = _sign_if_configured(bin_data, target_ver)
                if sig:
                    with self._lock:
                        job["logs"].append("[torqva] Signed release image on host (outside build container).")

            rec, checks = self.fm.validate(bin_data, sig, target_ver)
            compat = self._compatibility_report(bin_data, rec)
            if not compat["retains_ota"] or (profile in ("esp32s3_wireless", "esp32s3_ota_led_v112") and not compat["retains_wifi_link"]):
                raise CompilerError("INCOMPATIBLE_FIRMWARE", "compiled image is missing TORQVA Wi-Fi or OTA support")

            rel_out = None
            dep_out = None
            if job.get("_auto_upload", True):
                rel_out = self.fm.upload(bin_data, sig, job["requested_by"], target_ver, job.get("_notes", ""), job.get("_desc", ""))
                with self._lock:
                    job["logs"].append(f"[torqva] Release {rel_out['id']} stored (v{rel_out['version']}, deployable={rel_out['deployable']})")
                if job.get("_auto_deploy") and rel_out.get("deployable"):
                    dep_out = self.fm.deploy(rel_out["id"], job.get("_device_id", ""), job["requested_by"])
                    with self._lock:
                        job["logs"].append(f"[torqva] Deployment {dep_out['id']} started wirelessly")

            with self._lock:
                job.update({
                    "state": "SUCCEEDED",
                    "finished_at": time.time(),
                    "duration_s": elapsed,
                    "diagnostics": diags,
                    "memory": mem,
                    "compatibility": compat,
                    "release": rel_out,
                    "deployment": dep_out,
                })
        except (CompilerError, FirmwareError) as exc:
            with self._lock:
                job.update({
                    "state": "FAILED",
                    "finished_at": time.time(),
                    "duration_s": round(time.monotonic() - t0, 2),
                    "error": f"{exc.code}: {exc.detail}",
                })
                job["logs"].append(f"[error] {exc.code}: {exc.detail}")
        except Exception as exc:
            with self._lock:
                job.update({
                    "state": "FAILED",
                    "finished_at": time.time(),
                    "duration_s": round(time.monotonic() - t0, 2),
                    "error": f"INTERNAL_COMPILE_ERROR: {exc}",
                })
                job["logs"].append(f"[error] {exc}")
        finally:
            with self._lock:
                job.pop("_process", None); job.pop("_container", None)
            shutil.rmtree(job_dir, ignore_errors=True)

    def cancel_job(self, job_id: str) -> Dict[str, Any]:
        with self._lock:
            job = self.jobs.get(job_id)
            if not job: raise CompilerError("UNKNOWN_JOB", "no such compilation job", 404)
            if job["state"] not in ("QUEUED", "COMPILING"):
                raise CompilerError("NOT_CANCELLABLE", f"build is {job['state']}, not queued or compiling", 409)
            job["_cancel_requested"] = True
            job["logs"].append("[torqva] Cancellation requested by operator")
            if job["state"] == "QUEUED": job.update({"state": "CANCELLED", "finished_at": time.time(), "error": "cancelled by operator"})
            return self.public_job(job)

    def public_job(self, job: Dict[str, Any]) -> Dict[str, Any]:
        return {k: v for k, v in job.items() if not k.startswith("_")}

    def get_job(self, job_id: str) -> Dict[str, Any]:
        with self._lock:
            job = self.jobs.get(job_id)
            if not job:
                raise CompilerError("UNKNOWN_JOB", "no such compilation job", 404)
            return self.public_job(job)

    def list_jobs(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [self.public_job(j) for j in sorted(self.jobs.values(), key=lambda x: x["created_at"], reverse=True)]
