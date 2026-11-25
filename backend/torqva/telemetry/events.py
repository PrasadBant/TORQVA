"""Bounded event and telemetry delivery to browser subscribers."""

import collections
import threading
import time
from typing import Any, Deque, Dict, List, Optional

class EventHub:
    """Fan-out of bridge events to WebSocket clients. Thread-safe publish; each client has a bounded queue (drop-oldest) and telemetry is coalesced (latest only)."""

    def __init__(self, max_queue: int = 100):
        self.max_queue = max_queue
        self._clients: List["HubClient"] = []
        self._lock = threading.Lock()

    def subscribe(self) -> "HubClient":
        c = HubClient(self.max_queue)
        with self._lock:
            self._clients.append(c)
        return c

    def unsubscribe(self, c: "HubClient") -> None:
        with self._lock:
            if c in self._clients:
                self._clients.remove(c)

    def publish(self, name: str, data: Optional[Dict[str, Any]] = None) -> None:
        ev = {"type": "event", "name": name, "data": data or {}, "ts": time.time()}
        with self._lock:
            cs = list(self._clients)
        for c in cs:
            c.push(ev)

    @property
    def client_count(self) -> int:
        with self._lock:
            return len(self._clients)


class HubClient:
    def __init__(self, max_queue: int):
        self._q: Deque[Dict[str, Any]] = collections.deque(maxlen=max_queue)       # drop-oldest when a slow client cannot keep up
        self._tel: Optional[Dict[str, Any]] = None
        self._lock = threading.Lock()
        self.dropped = 0

    def push(self, ev: Dict[str, Any]) -> None:
        with self._lock:
            if ev["name"] == "telemetry":
                self._tel = ev                                                   # coalesce: only the latest telemetry is kept
                return
            if len(self._q) == self._q.maxlen:
                self.dropped += 1
            self._q.append(ev)

    def drain(self, include_telemetry: bool) -> List[Dict[str, Any]]:
        with self._lock:
            out = list(self._q); self._q.clear()
            if include_telemetry and self._tel is not None:
                out.append(self._tel); self._tel = None
            return out
