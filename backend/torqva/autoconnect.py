"""Automatic device connection (physical-first operation).

With TORQVA_DEVICE_PORT set, only that port is used. Otherwise (default) the connector looks for USB-serial adapters that ESP32 boards use (allow-listed vendor ids: WCH CH340/CH343,
Silicon Labs CP210x, FTDI, Espressif native USB) and connects when EXACTLY ONE is present; several candidates are never guessed between. TORQVA_AUTOCONNECT=0 disables it entirely.
A single background thread
tries to open that ONE port through the bridge (which still owns the port, serialises opens and requires the TORQVA handshake before anything is shown as a device) and retries
with a fixed back-off while disconnected. It never starts a motor, never sends a command, never replays anything, and it stops trying after an operator-requested disconnect until
an operator connects again. A failed attempt is reported honestly (no silent fallback to simulation).
"""
from __future__ import annotations

import logging
import re
import threading
import time
from typing import Any, Callable, Dict, Optional

from .serial_bridge import DeviceBridge, SerialTransport, TransportError

log = logging.getLogger("torqva.autoconnect")
# vendor ids of the USB-serial bridges / native USB used by ESP32 boards. A port is only ever opened if its USB vendor id is on this list.
KNOWN_VIDS = {0x1A86, 0x10C4, 0x0403, 0x303A}
_PORT = re.compile(r"^(COM[0-9]{1,3}|/dev/(tty|cu)[A-Za-z0-9._-]{1,40})$")


def _list_usb_ports() -> list:
    """Names of present serial ports whose USB vendor id is allow-listed. Lists only; opens nothing."""
    try:
        from serial.tools import list_ports
    except ImportError:
        return []
    return sorted(p.device for p in list_ports.comports() if getattr(p, "vid", None) in KNOWN_VIDS)


class AutoConnector:
    def __init__(self, bridge: DeviceBridge, port: Optional[str], baud: int = 115200, interval_s: float = 1.0, scan: bool = True, lister: Optional[Callable[[], list]] = None,
                 factory: Optional[Callable[[str, int], Any]] = None, clock: Callable[[], float] = time.monotonic):
        self.bridge, self.baud, self.interval_s, self._clock = bridge, baud, interval_s, clock
        self.port = port if port and _PORT.match(port) else None
        self.scan = scan and not port
        self._lister = lister or _list_usb_ports
        self.candidates: list = []
        self.configured_value = port or None
        self._factory = factory or (lambda p, b: SerialTransport(p, b))
        self.paused = False                       # set by an operator-requested disconnect
        self.last_error: Optional[str] = None
        self.attempts = 0
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    @property
    def configured(self) -> bool:
        return self.port is not None or self.scan

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False

    def status(self) -> Dict[str, Any]:
        return {"configured": self.configured, "port": self.port, "scan": self.scan, "candidates": list(self.candidates), "paused": self.paused, "attempts": self.attempts, "last_error": self.last_error,
                "note": (None if self.configured and (self.port or self.candidates) else ("no USB-serial device found yet; plug in the board and it connects automatically" if self.scan else ("TORQVA_DEVICE_PORT is not a valid port name; nothing will be opened" if self.configured_value else "no device port is configured (set TORQVA_DEVICE_PORT); connect from the Device page")))}

    def try_once(self) -> bool:
        """One connection attempt if (and only if) it is appropriate. Returns True if an attempt was made."""
        if not self.configured or self.paused or self.bridge.connected:
            return False
        port = self.port
        if port is None:
            self.candidates = [p for p in self._lister() if _PORT.match(p)]
            if len(self.candidates) != 1:
                self.last_error = None if not self.candidates else "several USB-serial devices are present; choose one on the Device page"
                return False
            port = self.candidates[0]
        self.attempts += 1
        try:
            self.bridge.connect(self._factory(port, self.baud))
            self.last_error = None
        except (TransportError, RuntimeError, ValueError) as e:       # in progress / already owned / open failed: reported, never hidden, never a fallback
            self.last_error = str(e)[:200]
            log.warning("auto-connect to %s failed: %s", port, self.last_error)
        return True

    def start(self) -> None:
        if not self.configured or self._thread is not None:
            return
        def loop() -> None:
            while not self._stop.is_set():
                self.try_once()
                self._stop.wait(self.interval_s)
        self._thread = threading.Thread(target=loop, name="torqva-autoconnect", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
