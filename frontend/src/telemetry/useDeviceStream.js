import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { plainify } from '../shared/plain.js';
import { api, ApiError } from '../shared/api.js';
import { getToken } from '../access/token.js';

const defaultWs = (import.meta.env && import.meta.env.MODE === 'test') ? null : (url) => new WebSocket(url);
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

function deviceWebSocketUrl() {
  const configured = (import.meta.env && import.meta.env.VITE_WS_BASE_URL) || '';
  if (configured) return `${configured.replace(/\/$/, '')}/api/torqva/ws`;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/api/torqva/ws`;
}

/** Live device state: REST snapshot + read-only WebSocket with reconnection. Telemetry is only ever "live" while the server says it is fresh AND frames keep arriving.
 * When the backend cannot be reached (and the socket is not delivering), the last snapshot is kept but reported as NOT fresh: its values are the last ones
 * received, never live. A rejected session (HTTP 401, or the socket closed with 4401) calls onAuthLost. */
export function useDeviceStream(enabled, wsFactory = defaultWs, pollMs = 3000, onAuthLost) {
  const [snap, setSnap] = useState(null);
  const [commands, setCommands] = useState([]);
  const [events, setEvents] = useState([]);
  const [ws, setWs] = useState('idle');                 // idle | connecting | open | closed
  const [lastMsg, setLastMsg] = useState(null);
  const [error, setError] = useState(null);
  const [unreachable, setUnreachable] = useState(false);
  const [frameRate, setFrameRate] = useState(null);
  const frameTimesRef = useRef([]);
  const lastSocketUpdate = useRef(0);
  const alive = useRef(true);
  const authLost = useRef(onAuthLost);
  authLost.current = onAuthLost;

  // Repeated identical events (for example protocol errors from a board that sends non-TORQVA text) are merged into one row with a count, never listed thousands of times.
  const pushEvent = useCallback((e) => setEvents((x) => {
    const n = typeof e.data?.count === 'number' ? e.data.count : 1;
    if (x.length && x[0].name === e.name && x[0].data?.code === e.data?.code) return [{ ...x[0], ts: e.ts, total: (x[0].total || 1) + n }, ...x.slice(1)];
    return [{ ...e, total: n, k: `${e.ts}-${Math.random()}` }, ...x].slice(0, 40);
  }), []);
  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api.deviceStatus(), api.deviceCommands()]);
      if (!alive.current) return;
      if (isObj(s)) { setSnap(s); setError(null); setUnreachable(false); }
      if (isObj(c) && Array.isArray(c.commands)) setCommands(c.commands);
    } catch (e) {
      if (!alive.current) return;
      setError(e);
      if (e instanceof ApiError && e.status === 401) authLost.current?.();
      else if (!(e instanceof ApiError)) setUnreachable(true);          // network failure or timeout: the server is not answering (an HTTP error means it is)
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) return undefined;
    refresh();
    const poll = setInterval(() => {
      // Socket snapshots and events already carry device state; keep a slow REST reconciliation.
      if (Date.now() - lastSocketUpdate.current >= 30000) refresh();
    }, pollMs);
    let sock = null; let retry = 0; let timer = null;
    const open = () => {
      if (!wsFactory || !alive.current) return;
      setWs('connecting');
      try { sock = wsFactory(deviceWebSocketUrl()); } catch { setWs('closed'); return; }
      sock.onopen = () => { try { sock.send(JSON.stringify({ type: 'auth', token: getToken() })); } catch { /* socket closed before auth */ } };
      sock.onmessage = (ev) => {
        let m; try { m = plainify(JSON.parse(ev.data)); } catch { return; }          // malformed frames are ignored, never trusted; prose in product language
        if (!isObj(m)) return;
        const receivedAt = Date.now();
        setLastMsg(receivedAt);
        lastSocketUpdate.current = receivedAt;
        setUnreachable(false);
        if (m.type === 'snapshot' && isObj(m.data)) { retry = 0; setWs('open'); setSnap(m.data); if (Array.isArray(m.commands)) setCommands(m.commands); }
        else if (m.type === 'event' && typeof m.name === 'string') {
          if (m.name === 'telemetry' && isObj(m.data)) {
            const now = Date.now();
            frameTimesRef.current.push(now);
            if (frameTimesRef.current.length > 20) frameTimesRef.current.shift();
            if (frameTimesRef.current.length > 4) {
              const dt = (now - frameTimesRef.current[0]) / (frameTimesRef.current.length - 1) / 1000;
              if (dt > 0) setFrameRate(Math.min(30, Math.round(1 / dt)));
            }
            setSnap((s) => ({ ...(s || {}), ...m.data }));
          } else {
            pushEvent(m);
            if (m.name.startsWith('command_') && m.data?.id != null) {
              setCommands((previous) => [m.data, ...previous.filter((command) => command.id !== m.data.id)].slice(0, 100));
            }
            if (['device_disconnected', 'device_restarted', 'telemetry_stale', 'safety_fault_latched', 'device_state_changed', 'auth_failed', 'limits_confirmed', 'limits_rejected'].includes(m.name)) refresh();
          }
        }
      };
      const lost = (ev) => {
        if (!alive.current) return;
        lastSocketUpdate.current = 0;
        setWs('closed');
        if (ev?.code === 4401) { authLost.current?.(); return; }       // the server rejected the session: do not keep reconnecting with it
        retry += 1; timer = setTimeout(open, Math.min(15000, 1000 * 2 ** Math.min(retry, 4)));   // exponential backoff, capped
      };
      sock.onclose = lost;
      sock.onerror = () => { try { sock.close(); } catch { /* already closed */ } };
    };
    open();
    return () => { alive.current = false; clearInterval(poll); if (timer) clearTimeout(timer); if (sock) { sock.onclose = null; try { sock.close(); } catch { /* closing */ } } };
  }, [enabled, refresh, wsFactory, pollMs, pushEvent]);

  const shown = useMemo(() => (unreachable && snap ? { ...snap, telemetry_fresh: false } : snap), [unreachable, snap]);
  const connState = useMemo(() => {
    if (unreachable || !shown) return 'lost';
    if (shown.connection === 'CONNECTING') return 'searching';
    if (shown.connection === 'CONNECTED') return shown.telemetry_fresh ? 'connected' : 'stale';
    if (shown.autoconnect?.configured) return 'searching';
    return 'lost';
  }, [shown, unreachable]);

  const droppedCount = useMemo(() => {
    const c = shown?.counters || {};
    return (c.gaps || 0) + (c.missing || 0) + (c.malformed || 0);
  }, [shown]);

  return { snap: shown, setSnap, commands, events, ws, lastMsg, error, unreachable, refresh, connState, frameRate, droppedCount };
}
