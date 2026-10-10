"""
WebSocket Connection Manager.
Handles multi-client subscriptions, broadcast events, connection heartbeats,
and dead connection pruning.
"""

import json
import logging
from typing import Set, Any
from fastapi import WebSocket

logger = logging.getLogger("websocket_manager")


class WebSocketManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        """Accept incoming client connection and register into pool."""
        await websocket.accept()
        self.active_connections.add(websocket)
        logger.info(f"WebSocket client connected. Total clients: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket) -> None:
        """Unregister a disconnected client."""
        self.active_connections.discard(websocket)
        logger.info(f"WebSocket client disconnected. Total clients: {len(self.active_connections)}")

    async def broadcast(self, event_type: str, data: Any) -> None:
        """
        Broadcast structured event message to all connected clients.
        Payload format: {"type": <event_type>, "data": <data>}
        """
        if not self.active_connections:
            return

        message = json.dumps({"type": event_type, "data": data})
        dead_connections = set()

        for connection in list(self.active_connections):
            try:
                await connection.send_text(message)
            except Exception as e:
                logger.warning(f"Failed to send to client ({e}), queueing removal.")
                dead_connections.add(connection)

        for dead in dead_connections:
            self.disconnect(dead)

    def get_active_count(self) -> int:
        """Return number of currently active WebSocket subscribers."""
        return len(self.active_connections)


# Global singleton instance
ws_manager = WebSocketManager()
