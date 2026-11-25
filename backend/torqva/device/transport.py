"""USB serial and in-memory implementations of the device transport."""

import collections
import os
import re
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional

from torqva.device.wire_protocol import MAX_LINE

class TransportError(Exception):
    """A serial-layer failure with a classified code taken from the REAL underlying error text (never guessed)."""

    def __init__(self, message: str, code: str = "TRANSPORT_ERROR", detail: str = ""):
        super().__init__(message)
        self.code, self.detail = code, detail or message


# code -> (operator-facing summary, recovery steps). Only the codes actually established by the underlying error are ever reported.
ERROR_HELP: Dict[str, Any] = {
    "ACCESS_DENIED": ("Windows refused to open the port (access denied).",
                      ["Windows denies access when ANOTHER program already has the port open or the account lacks permission; it does not say which program.",
                       "Close the Arduino IDE Serial Monitor (or quit the Arduino IDE), PlatformIO/VS Code serial monitors, PuTTY/Tera Term and any other terminal, then press Connect again.",
                       "If it still fails, unplug and re-plug the USB cable (this releases stale handles) and retry. Do not terminate processes you do not recognise."]),
    "PORT_NOT_FOUND": ("The port does not exist (any more).", ["Check the cable and that the board is powered; re-plug it, refresh the port list and select the current port (the number can change)."]),
    "DEVICE_ERROR": ("Windows reports the USB serial device is not functioning.", ["Re-plug the cable, try another USB port/cable, and check Device Manager for a driver problem on the device."]),
    "OPEN_TIMEOUT": ("Opening the port timed out.", ["Re-plug the cable and retry; check the driver in Device Manager."]),
    "OPEN_FAILED": ("The port could not be opened.", ["See the technical detail below; re-plug the device and retry."]),
    "DEVICE_DISAPPEARED": ("The device stopped responding or was unplugged.", ["Check the cable and power, then reconnect from this page. Nothing is replayed after reconnecting."]),
    "HANDSHAKE_TIMEOUT": ("The port is open but no valid TORQVA status frame has arrived.",
                          ["The attached firmware may not be TORQVA firmware (wire protocol 1), the board may be in bootloader mode, or opening the port reset the board: wait a few seconds.",
                           "Nothing is flashed or sent by TORQVA. If the board runs different firmware, that is a human decision."]),
    "HANDSHAKE_INVALID": ("The device sent data, but it is not valid TORQVA wire protocol 1.", ["Check which firmware is running and its protocol version; TORQVA never treats an invalid handshake as a physical device."]),
    "IDENTITY_MISMATCH": ("The device identity does not match the expected id.", ["Connect the intended device or correct the expected id."]),
    "CONNECT_IN_PROGRESS": ("A connection attempt is already in progress.", ["Wait for it to finish."]),
}


# Windows error codes whose meaning does not depend on the message language. Python maps some of them onto a misleading exception class
# (ERROR_GEN_FAILURE 31, "a device attached to the system is not functioning", becomes PermissionError), so the code is read first.
_WINERROR_CODES = {5: "ACCESS_DENIED", 2: "PORT_NOT_FOUND", 31: "DEVICE_ERROR"}


def _winerror_code(exc: BaseException, low: str) -> Optional[int]:
    """The Windows error code of `exc`: its own winerror attribute, else the code pyserial embeds in its message, either as
    repr(WinError) ("PermissionError(13, 'Access is denied.', None, 5)") or as str(WinError) ("[WinError 5] Access is denied")."""
    w = getattr(exc, "winerror", None)
    if isinstance(w, int):
        return w
    m = re.search(r"\(\s*\d+\s*,.*,\s*none\s*,\s*(\d+)\s*\)", low) or re.search(r"\[winerror (\d+)\]", low)
    return int(m.group(1)) if m else None


def classify_open_error(exc: BaseException) -> "tuple[str, str]":
    """(code, detail) from the exact exception text. pyserial wraps the Windows error in a SerialException whose message embeds repr(WinError).
    An error that matches no known pattern is OPEN_FAILED: a cause is never guessed. `detail` is always the full original text."""
    t = f"{type(exc).__name__}: {exc}"
    low = t.lower()
    code = _WINERROR_CODES.get(_winerror_code(exc, low))
    if code:
        return code, t
    if isinstance(exc, PermissionError) or "permissionerror(13" in low or "access is denied" in low or re.search(r"winerror 5\b", low) or ", 5)" in low and "permissionerror" in low:
        return "ACCESS_DENIED", t
    if isinstance(exc, FileNotFoundError) or "filenotfounderror(2" in low or "cannot find the file specified" in low or re.search(r"winerror 2\b", low) or "no such file" in low:
        return "PORT_NOT_FOUND", t
    if "not functioning" in low or re.search(r"winerror 31\b", low) or "oserror(22" in low:
        return "DEVICE_ERROR", t
    if "semaphore timeout" in low or re.search(r"winerror 121\b", low) or "timed out" in low:
        return "OPEN_TIMEOUT", t
    return "OPEN_FAILED", t


_HOLDER_WATCHLIST = ("arduino ide.exe", "serial-monitor.exe", "serial-discovery.exe", "putty.exe", "ttermpro.exe", "mobaxterm.exe", "realterm.exe", "termite.exe", "esptool.exe", "platformio.exe", "pio.exe")


def possible_port_holders() -> List[str]:
    """HINT ONLY (Windows): running programs that commonly keep a serial port open. This is not proof of ownership; it never kills anything."""
    if os.name != "nt":
        return []
    try:
        out = subprocess.run(["tasklist", "/fo", "csv", "/nh"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return []
    found = sorted({line.split('","')[0].strip('"') for line in out.splitlines() if line.split('","')[0].strip('"').lower() in _HOLDER_WATCHLIST})
    return found


class Transport:
    def open(self) -> None: raise NotImplementedError
    def read_line(self, timeout: float) -> Optional[bytes]: raise NotImplementedError          # None = timeout; b"" never; raises TransportError when the device is gone
    def write(self, data: bytes) -> None: raise NotImplementedError
    def close(self) -> None: raise NotImplementedError


ESPRESSIF_USB_VID = 0x303A                     # Espressif's own USB controllers (ESP32-S3 USB-Serial/JTAG = 303A:1001)


def _espressif_usb(port: str) -> bool:
    """True when `port` is an Espressif native USB serial port. Any lookup failure means False: the port then opens exactly as before."""
    try:
        from serial.tools import list_ports
        return any(p.device == port and p.vid == ESPRESSIF_USB_VID for p in list_ports.comports())
    except Exception:                                                                              # noqa: BLE001 - no port listing: keep the generic open
        return False


class SerialTransport(Transport):
    kind = "usb"
    """pyserial transport. Bounded line assembly (oversized lines are discarded up to the next newline). Close releases the port."""

    def __init__(self, port: str, baud: int = 115200):
        self.port, self.baud = port, baud
        self._s = None
        self._buf = bytearray()
        self._discard = False

    def open(self) -> None:
        try:
            import serial
        except ImportError as e:                                                                   # pragma: no cover
            raise TransportError("pyserial is not installed") from e
        try:
            if _espressif_usb(self.port):
                # The ESP32-S3's own USB-Serial/JTAG port (USB VID 0x303A) resets the chip when RTS is asserted while DTR is not (esptool's reset). pyserial
                # applies the two lines while opening, and their order can look like that reset; a reset of an image in PENDING_VERIFY aborts it. So the
                # lines are fixed BEFORE opening (one DCB on Windows) to DTR on / RTS off: never a reset, and the normal "terminal connected" state.
                # (DTR off as well was tried on the bench, 5 Nov: no reset, but the host stopped receiving after ~80 s with heavy loss.)
                s = serial.Serial()
                s.port, s.baudrate, s.timeout, s.write_timeout, s.bytesize, s.parity, s.stopbits = self.port, self.baud, 0.2, 1.0, 8, "N", 1
                s.dtr = True
                s.rts = False
                if os.name != "nt":
                    s.exclusive = True
                s.open()
                self._s = s
            else:
                self._s = serial.Serial(self.port, self.baud, timeout=0.2, write_timeout=1.0, bytesize=8, parity="N", stopbits=1, exclusive=True) if os.name != "nt" else \
                    serial.Serial(self.port, self.baud, timeout=0.2, write_timeout=1.0, bytesize=8, parity="N", stopbits=1)
                try:
                    self._s.dtr = False
                    self._s.rts = False
                except Exception:
                    pass
        except Exception as e:
            code, detail = classify_open_error(e)
            raise TransportError(f"cannot open {self.port}: {e}", code, detail) from e

    def read_line(self, timeout: float) -> Optional[bytes]:
        if self._s is None:
            raise TransportError("closed")
        end = time.monotonic() + timeout
        while True:
            i = self._buf.find(b"\n")
            if i >= 0:
                line = bytes(self._buf[:i]).rstrip(b"\r"); del self._buf[:i + 1]
                if self._discard:
                    self._discard = False
                    continue
                return line if len(line) <= MAX_LINE else line[:MAX_LINE + 1]                       # parse_frame rejects it as OVERSIZE
            if len(self._buf) > MAX_LINE * 2:                                                      # no newline within the bound: drop it and skip to the next newline
                self._buf.clear(); self._discard = True
            if time.monotonic() >= end:
                return None
            try:
                chunk = self._s.read(max(1, min(256, self._s.in_waiting or 1)))
            except Exception as e:
                raise TransportError(f"read failed: {e}", "DEVICE_DISAPPEARED", f"{type(e).__name__}: {e}") from e
            if chunk:
                self._buf += chunk

    def write(self, data: bytes) -> None:
        if self._s is None:
            raise TransportError("closed")
        try:
            self._s.write(data); self._s.flush()
        except Exception as e:
            raise TransportError(f"write failed: {e}", "DEVICE_DISAPPEARED", f"{type(e).__name__}: {e}") from e

    def close(self) -> None:
        s, self._s = self._s, None
        if s is not None:
            try:
                s.close()
            except Exception:                                                                      # pragma: no cover
                pass


class MemoryTransport(Transport):
    """In-memory transport for tests (NOT a device)."""
    kind = "test"

    def __init__(self):
        self._q: "collections.deque[Any]" = collections.deque(maxlen=1000)
        self._cv = threading.Condition()
        self.written: List[bytes] = []
        self.is_open = False
        self.fail_writes = False

    def open(self) -> None:
        self.is_open = True

    def feed(self, line: "bytes | str") -> None:
        with self._cv:
            self._q.append(line if isinstance(line, bytes) else line.encode())
            self._cv.notify()

    def disconnect_device(self) -> None:
        with self._cv:
            self._q.append(TransportError("device unplugged"))
            self._cv.notify()

    def read_line(self, timeout: float) -> Optional[bytes]:
        with self._cv:
            if not self._q:
                self._cv.wait(timeout)
            if not self._q:
                return None
            item = self._q.popleft()
        if isinstance(item, Exception):
            raise item
        return item

    def write(self, data: bytes) -> None:
        if self.fail_writes:
            raise TransportError("write failed")
        self.written.append(data)

    def close(self) -> None:
        self.is_open = False
