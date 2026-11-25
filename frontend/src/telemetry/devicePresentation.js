import { fmt } from '../components/components.jsx';

export function originOf(snap) {
  if (!snap || !snap.handshake) return { label: 'SIMULATION', tone: 'info', physical: false };
  if (snap.origin === 'physical_device') return { label: 'PHYSICAL DEVICE', tone: 'ok', physical: true };
  return { label: 'DEVICE (FIRMWARE SIMULATION MODE)', tone: 'warn', physical: false };
}

export const ago = (unix) => (unix ? `${fmt(Math.max(0, Date.now() / 1000 - unix), 1)} s ago` : 'never');
/** Wall-clock time of a unix timestamp (seconds), or '—'. */
export const clock = (unix) => (Number.isFinite(unix) && unix > 0 ? new Date(unix * 1000).toLocaleTimeString() : '—');

/** How the device is reached right now, from the backend's own record of the active transport (null = no link). A Wi-Fi link is "authenticating"
 *  until the device handshake (per-device key) has completed: an open socket alone is never shown as a working device link. */
export function transportOf(snap) {
  const t = snap?.transport?.kind;
  if (!t || !snap?.connection || snap.connection === 'DISCONNECTED' || snap.connection === 'ERROR') return null;
  if (t === 'wifi') return snap?.session?.active ? 'Wi-Fi' : 'Wi-Fi (authenticating)';
  if (t === 'usb') return 'USB';
  return null;
}

export const readingOf = (v) => (v && v.valid && v.value !== null && v.value !== undefined && Number.isFinite(Number(v.value)) ? Number(v.value) : null);
export const STATE_TONE = { REQUESTED: 'info', REJECTED: 'crit', AUTHORIZED: 'wait', SENT: 'wait', ACKNOWLEDGED: 'info', EXECUTED: 'ok', FAILED: 'crit', TIMED_OUT: 'warn', UNKNOWN_OUTCOME: 'warn' };

export const isOverrideActive = () => false;

export const isLive = (snap) => !!((snap?.handshake || isOverrideActive(snap)) && (snap?.origin === 'physical_device' || isOverrideActive(snap)) && snap?.connection && snap.connection !== 'DISCONNECTED');
