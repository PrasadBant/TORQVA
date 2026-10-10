/**
 * Robust WebSocket client with auto-reconnection, exponential backoff,
 * heartbeat ping/pong, and multi-subscriber event routing.
 */

class WebSocketService {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 15;
    this.reconnectDelay = 1000; // Starting delay in ms
    this.maxDelay = 15000;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.isConnected = false;
    this.url = this.getWebSocketUrl();
  }

  getWebSocketUrl() {
    if (import.meta.env.VITE_WS_URL) {
      return import.meta.env.VITE_WS_URL;
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:8000';
    return `${protocol}//${host}/ws`;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.startHeartbeat();
        this.emit('ws_status', { connected: true, reconnecting: false });
      };

      this.ws.onmessage = (event) => {
        if (event.data === 'pong') {
          return;
        }

        try {
          const payload = JSON.parse(event.data);
          if (payload && payload.type) {
            this.emit(payload.type, payload.data);
          }
        } catch (err) {
          console.warn('[WS] Failed to parse message JSON:', event.data);
        }
      };

      this.onerror = (err) => {
        console.warn('[WS] Socket error:', err);
        this.emit('ws_status', { connected: false, error: err });
      };

      this.ws.onclose = (event) => {
        this.isConnected = false;
        this.stopHeartbeat();
        this.emit('ws_status', { connected: false, reconnecting: true });
        this.scheduleReconnect();
      };
    } catch (err) {
      console.error('[WS] Connection init error:', err);
      this.scheduleReconnect();
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('ping');
      }
    }, 15000);
  }

  stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn('[WS] Max reconnect attempts reached. Waiting for user reload or retry.');
      this.emit('ws_status', { connected: false, reconnecting: false, maxRetriesReached: true });
      return;
    }

    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts), this.maxDelay);
    const jitter = delay * (0.8 + Math.random() * 0.4);

    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, jitter);
  }

  subscribe(eventType, callback) {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType).add(callback);

    // Return un-subscribe function
    return () => {
      const set = this.listeners.get(eventType);
      if (set) {
        set.delete(callback);
        if (set.size === 0) {
          this.listeners.delete(eventType);
        }
      }
    };
  }

  emit(eventType, data) {
    const set = this.listeners.get(eventType);
    if (set) {
      set.forEach((cb) => {
        try {
          cb(data);
        } catch (err) {
          console.error(`[WS] Error in subscriber callback for ${eventType}:`, err);
        }
      });
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }
}

export const wsService = new WebSocketService();
export default wsService;
