"""Guarded ESP32-S3 USB application flashing jobs.

Only stored, validated releases may be flashed. The service is opt-in and never
uses a shell. A successful esptool process is TRANSFER_COMPLETE, not VERIFIED;
verification requires a reconnected authenticated TORQVA device reporting the
expected firmware version.
"""
from __future__ import annotations

import importlib.util
import os
import re
import subprocess
import sys
import threading
import time
from typing import Any, Dict

from torqva.device.operation_lock import DEVICE_OPERATIONS, OperationBusy

from .firmware import FirmwareError, FirmwareManager


class UsbFlasher:
    def __init__(self, manager: FirmwareManager):
        self.fm = manager; self.jobs: Dict[str, Dict[str, Any]] = {}; self.lock = threading.RLock()

    def status(self) -> Dict[str, Any]:
        enabled = os.environ.get("TORQVA_USB_FLASH_ENABLED", "0") == "1"
        esptool = importlib.util.find_spec("esptool") is not None
        return {"available": enabled and esptool, "enabled": enabled, "esptool": esptool,
                "detail": "USB flashing enabled; every operation still requires admin authorization and authoritative safety checks." if enabled and esptool else
                          "Set TORQVA_USB_FLASH_ENABLED=1 and install esptool in the backend environment. Physical flashing still requires explicit operator authorization."}

    def _public(self, job: Dict[str, Any]) -> Dict[str, Any]:
        return {k: v for k, v in job.items() if k not in {"process"}}

    def refresh(self, job: Dict[str, Any]) -> None:
        if job["state"] != "RECONNECTION_REQUIRED": return
        dev = self.fm.device()
        if dev.get("connected") and dev.get("session_active") and dev.get("device_id") == job["device_id"]:
            if dev.get("firmware") == job["version"]:
                job.update({"state": "VERIFIED", "completed_at": time.time(), "detail": "the authenticated device reconnected and reported the expected firmware identity"})
            else:
                job.update({"state": "VERIFICATION_FAILED", "completed_at": time.time(), "detail": f"device reports {dev.get('firmware')!r}, expected {job['version']!r}"})

    def get(self, jid: str) -> Dict[str, Any]:
        job = self.jobs.get(jid)
        if not job: raise FirmwareError("UNKNOWN_USB_JOB", "no such USB flashing job", 404)
        self.refresh(job); return self._public(job)

    def start(self, rid: str, device_id: str, port: str, user: str, confirm_physical: bool, allow_rollback: bool = False) -> Dict[str, Any]:
        if not self.status()["available"]: raise FirmwareError("USB_FLASH_UNAVAILABLE", self.status()["detail"], 503)
        if not confirm_physical: raise FirmwareError("PHYSICAL_CONFIRMATION_REQUIRED", "confirm that motor power is disconnected and USB recovery is intended", 409)
        if not re.fullmatch(r"(?i)COM\d{1,4}|/dev/(ttyUSB|ttyACM)\d+", port or ""):
            raise FirmwareError("BAD_PORT", "select a supported serial port")
        rec = self.fm.release(rid); dev = self.fm.device(); tr = dev.get("transport") or {}
        why = []
        if not rec.get("deployable"): why.append("release did not pass every validation check")
        if not dev.get("connected") or not dev.get("handshake") or not dev.get("session_active"): why.append("an authenticated TORQVA device must be connected before USB flashing")
        if device_id and dev.get("device_id") != device_id: why.append("connected device identity does not match the selected target")
        if dev.get("drive") != "IDLE": why.append("motor drive is not confirmed idle" if dev.get("drive") is None else "motor drive is not idle")
        if dev.get("safety_state") == "EMERGENCY_STOP": why.append("a safety trip is latched")
        if tr.get("kind") != "usb" or tr.get("port") != port: why.append("selected port is not the authenticated device's owned USB transport")
        from .firmware import version_compare
        cmp = version_compare(rec["version"], dev.get("firmware") or "")
        if cmp is not None and cmp <= 0 and not allow_rollback: why.append("reinstall or downgrade requires explicit restore authorization")
        if why: raise FirmwareError("NOT_ELIGIBLE", "; ".join(why), 409)
        try:
            held = DEVICE_OPERATIONS.try_acquire("usb_flash")
        except OperationBusy as busy:
            raise FirmwareError("BUSY", f"{busy.active} is running; wait for it to finish", 409) from busy
        jid = os.urandom(6).hex(); job = {"id": jid, "release": rid, "version": rec["version"], "device_id": device_id, "port": port,
             "requested_by": user, "requested_at": time.time(), "state": "QUEUED", "detail": "", "logs": [], "progress": 0}
        self.jobs[jid] = job
        self.fm.store.append_history({"kind": "usb_flash_requested", "deployment": jid, "release": rid, "version": rec["version"], "device": device_id, "port": port, "by": user, "at": job["requested_at"]})
        threading.Thread(target=self._run, args=(job, rec, held), daemon=True, name=f"usb-flash-{jid}").start()
        return self._public(job)

    def _run(self, job: Dict[str, Any], rec: Dict[str, Any], held: Any = None) -> None:
        try:
            job.update({"state": "RELEASING_PORT", "detail": "releasing TORQVA serial ownership before invoking esptool"})
            if self.fm.bridge is not None and hasattr(self.fm.bridge, "disconnect"): self.fm.bridge.disconnect()
            # underscore spellings: the only ones esptool 4.x accepts, and still accepted (as aliases) by esptool 5.x
            cmd = [sys.executable, "-m", "esptool", "--chip", "esp32s3", "--port", job["port"], "--baud", "460800", "write_flash", "--flash_mode", "keep", "--flash_freq", "keep", "--flash_size", "keep", "0x10000", str(self.fm.store.image_path(rec["sha256"]))]
            job.update({"state": "TRANSFERRING", "detail": "esptool is writing the signed application image"})
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, shell=False)
            job["process"] = proc
            for line in iter(proc.stdout.readline, ''):
                line = line.rstrip(); job["logs"] = (job["logs"] + [line])[-400:]
                match = re.search(r"\((\d+) %\)", line)
                if match: job["progress"] = min(100, int(match.group(1)))
            code = proc.wait(timeout=10)
            if code != 0: raise RuntimeError(f"esptool exited with code {code}")
            job.update({"state": "RECONNECTION_REQUIRED", "progress": 100, "detail": "transfer completed; reconnect the device so TORQVA can verify its reported firmware identity"})
            self.fm.store.append_history({"kind": "usb_flash_transfer_complete", "deployment": job["id"], "release": job["release"], "version": job["version"], "device": job["device_id"], "at": time.time()})
        except Exception as exc:  # a process failure is reported, never promoted to success
            job.update({"state": "FAILED", "completed_at": time.time(), "detail": f"USB flash failed: {type(exc).__name__}: {exc}"})
            self.fm.store.append_history({"kind": "usb_flash_result", "deployment": job["id"], "release": job["release"], "result": "FAILED", "reason": job["detail"], "at": job["completed_at"]})
        finally:
            job.pop("process", None)
            if held is not None:
                held.release()
