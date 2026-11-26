"""Process-wide mutual exclusion for operations that touch the physical board.

Wi-Fi provisioning (USB NVS write + restart), network switching, USB firmware flashing and wireless firmware deployment each take the serial port, restart the
board or both. Running two of them at once could leave the board half-configured, so they all acquire this single lock. Acquisition never waits: a second request
gets a clear "busy" answer that names the operation already running.

Quarantine: when a flash write was started but its result is not known (the operation crashed, failed verification, or the backend restarted mid-write), releasing
the lock would hide that the board's configuration is uncertain. The lock is then *quarantined*: every operation except a USB provisioning run (which re-reads the
partition, rewrites it and verifies the result) is refused until that run succeeds or an operator explicitly clears it after checking the board.
"""
from __future__ import annotations

import threading
from typing import Dict, FrozenSet, Optional

# Operations allowed while quarantined: only the one that re-establishes a known state.
ALLOWED_WHEN_QUARANTINED: FrozenSet[str] = frozenset({"wifi_provisioning"})


class OperationBusy(RuntimeError):
    def __init__(self, active: str):
        super().__init__(f"another device operation is running: {active}")
        self.active = active


class OperationLock:
    def __init__(self) -> None:
        self._mu = threading.Lock()
        self._active: Optional[str] = None
        self._quarantine: Optional[Dict[str, str]] = None

    @property
    def active(self) -> Optional[str]:
        with self._mu:
            return self._active

    @property
    def quarantined(self) -> Optional[Dict[str, str]]:
        with self._mu:
            return None if self._quarantine is None else dict(self._quarantine)

    def try_acquire(self, name: str) -> "_Held":
        with self._mu:
            if self._active is not None:
                raise OperationBusy(self._active)
            if self._quarantine is not None and name not in ALLOWED_WHEN_QUARANTINED:
                raise OperationBusy(f"recovery required ({self._quarantine.get('reason', 'device state unknown')})")
            self._active = name
        return _Held(self, name)

    def quarantine(self, reason: str, job: str = "") -> None:
        """Mark the board's state as unknown. Survives until clear_quarantine()."""
        with self._mu:
            self._quarantine = {"reason": reason, "job": job}

    def clear_quarantine(self) -> None:
        with self._mu:
            self._quarantine = None

    def _release(self, name: str) -> None:
        with self._mu:
            if self._active == name:
                self._active = None


class _Held:
    """Context manager; releases the lock exactly once."""

    def __init__(self, lock: OperationLock, name: str):
        self._lock, self._name, self._done = lock, name, False

    def release(self) -> None:
        if not self._done:
            self._done = True
            self._lock._release(self._name)

    def __enter__(self) -> "_Held":
        return self

    def __exit__(self, *exc) -> None:
        self.release()


# One lock for the whole backend process (the device is a single physical resource).
DEVICE_OPERATIONS = OperationLock()
