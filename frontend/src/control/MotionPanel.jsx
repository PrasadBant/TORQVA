import React, { useState } from 'react';
import { Octagon, Play, SlidersHorizontal } from 'lucide-react';
import { api } from '../shared/api.js';
import { Card, ErrorBox, Pill, fmt, title } from '../components/components.jsx';
import { STATE_TONE, ago, isLive, readingOf, transportOf } from '../telemetry/devicePresentation.js';

/** Motor Control: the ONLY physical control surface. Connection and STOP first, followed by state and operating controls.
 *  Every request goes to /device/commands -> firmware; direct operator control. */
export function MotionPanel({ stream, role, go }) {
  const { snap, commands } = stream;
  const [duty, setDuty] = useState('0');
  const [rpm, setRpm] = useState('1200');
  const [speedScale, setSpeedScale] = useState('nominal'); // 'nominal' (0-3000) or 'extended' (0-20000)
  const [rampUp, setRampUp] = useState('');
  const [rampDown, setRampDown] = useState('');
  const [busy, setBusy] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);   // STOP has its own in-flight state: a pending START or speed request never holds STOP back
  const [err, setErr] = useState(null);
  const [last, setLast] = useState(null);
  const live = isLive(snap);
  const operator = !role || role === 'operator' || role === 'admin';
  const connected = !stream.unreachable && snap?.connection && !['DISCONNECTED', 'ERROR'].includes(snap.connection);
  const fresh = connected && snap.telemetry_fresh;
  const maxDuty = snap?.control_limits?.max_duty_pct ?? 100;
  const maxRpm = snap?.control_limits?.max_rpm ?? 30000;

  const send = (body) => async () => {
    setBusy(true);
    setErr(null);
    try {
      setLast(await api.deviceCommand(body));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
      stream.refresh();
    }
  };

  const sendStop = async () => {
    setStopBusy(true);
    setErr(null);
    try {
      setLast(await api.deviceCommand({ action: 'STOP' }));
    } catch (e) {
      setErr(e);
    } finally {
      setStopBusy(false);
      stream.refresh();
    }
  };

  const rec = (last && (commands || []).find((c) => c.id === last.id)) || last;
  const vals = snap?.values || {};
  const motor = stream.unreachable ? 'BACKEND UNREACHABLE' : snap?.connection === 'CONNECTING' ? 'CONNECTING' : !connected ? 'DEVICE OFFLINE'
    : !fresh ? 'TELEMETRY TIMEOUT' : snap.drive === 'IDLE' ? 'STOPPED' : snap.drive ? 'DRIVE ACTIVE' : 'UNKNOWN';
  const running = motor === 'DRIVE ACTIVE';
  const dutyBad = duty === '' || !(Number(duty) >= 0 && Number(duty) <= maxDuty);
  const value = (key, decimals, unit, unavailable = 'Unavailable') => {
    const reading = fresh && !vals[key]?.stale ? readingOf(vals[key]) : null;
    return Number.isFinite(reading) ? `${fmt(reading, decimals)} ${unit}` : unavailable;
  };

  return (
    <Card title="Direct Manual Control" id="p-motion" icon={SlidersHorizontal} className="tq-mon-motion" sub="Direct operator motor control."
      right={<Pill tone={running ? 'ok' : motor === 'STOPPED' ? 'info' : 'off'}>{motor}</Pill>}>
      {/* Connection status precedes the primary controls. */}
      <div className="tq-row tq-small">
        <Pill tone={stream.unreachable ? 'crit' : stream.ws === 'open' ? 'ok' : 'off'}>
          {stream.unreachable ? 'Backend unreachable' : stream.ws === 'open' ? 'Backend live stream' : stream.ws === 'connecting' ? 'Connecting to backend stream' : 'Backend status checks'}
        </Pill>
        <Pill tone={fresh ? 'ok' : 'off'}>{transportOf(snap) || 'ESP32 link unavailable'}</Pill>
        {fresh && snap.last_rx_unix != null && <span>Last received {ago(snap.last_rx_unix)}</span>}
      </div>
      {/* 2. STOP: enabled whenever the device is connected, for every signed-in role */}
      <div className="tq-motion-stop-bar">
        <button
          type="button"
          className="tq-btn tq-danger tq-stop-prominent"
          disabled={!connected || stopBusy}
          onClick={sendStop}
          data-testid="btn-stop"
          aria-label="Stop motor"
        >
          <Octagon size={18} aria-hidden="true" />
          <span>STOP MOTOR</span>
        </button>
      </div>
      {connected ? <p className="tq-stop-note">STOP is available to all signed-in roles while the device is connected.</p>
        : <p className="tq-stop-note">STOP cannot be delivered: device is disconnected.</p>}

      <div className="tq-motor-state-box" data-testid="motor-state">
        <div className="tq-motor-state-header">
          <span className="tq-motor-state-label">Motor State</span>
          <strong className={`tq-motor-state-value ${motor.toLowerCase()}`}>
            {motor}
          </strong>
        </div>
        <div className="tq-motor-state-grid">
          <div className="tq-motor-state-item">
            <span className="tq-muted">Applied PWM</span>
            <strong className="tq-num">{value('duty', 1, '%')}</strong>
          </div>
          <div className="tq-motor-state-item">
            <span className="tq-muted">Requested PWM</span>
            <strong>{fresh && snap.drive === 'CLOSED_LOOP' ? 'RPM mode' : value('pwm_req', 1, '%')}</strong>
          </div>
          <div className="tq-motor-state-item">
            <span className="tq-muted">Measured Speed (Hall)</span>
            <strong>{value('rpm', 0, 'rpm', 'RPM feedback unavailable')}</strong>
          </div>
          <div className="tq-motor-state-item">
            <span className="tq-muted">Requested RPM</span>
            <strong>{value('setpoint', 0, 'rpm')}</strong>
          </div>
          <div className="tq-motor-state-item">
            <span className="tq-muted">Drive Direction</span>
            <span>Forward Only (Unidirectional)</span>
          </div>
        </div>
      </div>

      {motor === 'STOPPED' && snap.stop_reason && snap.stop_reason !== 'NONE' && <p>Stopped by {title(snap.stop_reason)}</p>}
      <div className="tq-motion-controls-grid">
        {/* CARD 1: DUTY CYCLE (OPEN LOOP) FIRST */}
        <div className="tq-control-card">
          <div className="tq-control-card-header">
            <strong>Duty cycle (open loop) — Direct Manual Control</strong>
            <span className="tq-muted">0 – {maxDuty}%</span>
          </div>
          <div className="tq-control-card-inputs">
            <label>
              <span className="tq-muted">Duty Percentage (%)</span>
              <div className="tq-input-pair">
                <input type="number" min="0" max={maxDuty} step="1" value={duty} disabled={!operator}
                  onChange={(e) => { setDuty(e.target.value); }} aria-label="Duty percent" />
                <input type="range" min="0" max={maxDuty} step="1" value={duty === '' ? 0 : duty} disabled={!operator}
                  onChange={(e) => { setDuty(e.target.value); }} aria-label="Duty slider (submit to apply)" />
              </div>
            </label>
            <div className="tq-row">
              <button type="button" className="tq-btn tq-primary" data-testid="btn-start"
                disabled={busy || stopBusy || !operator || dutyBad || (!running && Number(duty) === 0)}
                onClick={send({ action: running ? 'SET_PWM' : 'START', duty_pct: Number(duty) })}>
                <Play size={14} aria-hidden="true" />
                {running ? 'Apply PWM' : 'START'}
              </button>
            </div>
            <div className="tq-row" style={{ gap: '0.35rem', marginTop: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="tq-muted" style={{ fontSize: '0.75rem' }}>Presets:</span>
              {[10, 20, 25, 30, 40, 50, 60, 80, 100].map((d) => (
                <button
                  key={d}
                  type="button"
                  className="tq-btn tq-small"
                  style={{ padding: '0.15rem 0.45rem', fontSize: '0.75rem' }}
                  disabled={busy || stopBusy || !operator || d > maxDuty}
                  onClick={() => { setDuty(String(d)); send({ action: running ? 'SET_PWM' : 'START', duty_pct: d })(); }}
                >
                  {d}%
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* CARD 2: TARGET SPEED (CLOSED LOOP / TACHOMETER DRIVE) */}
        <div className="tq-control-card">
          <div className="tq-control-card-header">
            <strong>Target speed (feedforward)</strong>
            <span className="tq-muted">Nominal 3k · Extended {maxRpm} rpm</span>
          </div>
          <div className="tq-control-card-inputs">
            <label>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="tq-muted">Target RPM</span>
                <span className="tq-muted" style={{ fontSize: '0.75rem' }}>
                  Scale: {speedScale === 'extended' ? '0–20k' : '0–3k'}
                  {' · '}
                  <button
                    type="button"
                    className="tq-btn tq-ghost tq-small"
                    style={{ padding: '0 4px', fontSize: '0.72rem', textDecoration: 'underline' }}
                    onClick={() => setSpeedScale(speedScale === 'extended' ? 'nominal' : 'extended')}
                  >
                    {speedScale === 'extended' ? '3k nominal' : '20k range'}
                  </button>
                </span>
              </div>
              <div className="tq-input-pair">
                <input type="number" min="0" max={maxRpm} step="10" value={rpm} disabled={!operator}
                  onChange={(e) => setRpm(e.target.value)} aria-label="Speed setpoint rpm" placeholder="e.g. 1200" />
                <input type="range" min="0" max={speedScale === 'extended' ? maxRpm : 3000} step={speedScale === 'extended' ? 100 : 25} value={rpm === '' ? 0 : Math.min(Number(rpm), speedScale === 'extended' ? maxRpm : 3000)} disabled={!operator}
                  onChange={(e) => setRpm(e.target.value)} aria-label="Speed slider" />
              </div>
            </label>
            <button type="button" className="tq-btn tq-primary" data-testid="btn-speed"
              disabled={busy || stopBusy || !operator || rpm === '' || Number(rpm) < 0 || Number(rpm) > maxRpm}
              onClick={send({ action: 'SET_SPEED', rpm: Number(rpm) })}>
              <Play size={14} aria-hidden="true" />
              {Number(rpm) === 0 ? 'Set speed (0 rpm — Stop)' : running ? `Update speed to ${rpm} rpm` : `Set speed (${rpm} rpm)`}
            </button>
            <div className="tq-row" style={{ gap: '0.35rem', marginTop: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="tq-muted" style={{ fontSize: '0.75rem' }}>Presets:</span>
              {[600, 1000, 1200, 1500, 1800, 2400, 3000].map((p) => (
                <button
                  key={p}
                  type="button"
                  className="tq-btn tq-small"
                  style={{ padding: '0.15rem 0.45rem', fontSize: '0.75rem' }}
                  disabled={busy || stopBusy || !operator || p > maxRpm}
                  onClick={() => { setRpm(String(p)); send({ action: 'SET_SPEED', rpm: p })(); }}
                >
                  {p}
                </button>
              ))}
              <span className="tq-muted" style={{ fontSize: '0.7rem', margin: '0 2px' }}>|</span>
              {[6000, 10000, 20000].map((p) => (
                <button
                  key={p}
                  type="button"
                  className="tq-btn tq-small tq-ghost"
                  style={{ padding: '0.15rem 0.35rem', fontSize: '0.7rem' }}
                  disabled={busy || stopBusy || !operator || p > maxRpm}
                  onClick={() => { setRpm(String(p)); send({ action: 'SET_SPEED', rpm: p })(); }}
                >
                  {p > 999 ? `${p / 1000}k` : p}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="tq-control-card">
        <strong>Acceleration and deceleration</strong>
        <p>Active PWM ramp up {value('ramp_up', 3, '%/s')} / ramp down {value('ramp_down', 3, '%/s')}</p>
        <div className="tq-row">
          <label>Ramp up (%/s) <input type="number" min="0.001" step="0.001" value={rampUp} onChange={(e) => setRampUp(e.target.value)} /></label>
          <label>Ramp down (%/s) <input type="number" min="0.001" step="0.001" value={rampDown} onChange={(e) => setRampDown(e.target.value)} /></label>
          <button type="button" className="tq-btn" disabled={busy || stopBusy || !operator || !(Number(rampUp) >= 0.001 && Number(rampDown) >= 0.001)}
            onClick={send({ action: 'SET_RAMP', ramp_up: Number(rampUp), ramp_down: Number(rampDown) })}>Apply ramp rates</button>
        </div>
      </div>
      {!operator && <p className="tq-muted tq-small">Your role ({role}) can request STOP only.</p>}
      <ErrorBox error={err} />
      {rec && (
        <div className="tq-callout" data-testid="last-command">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px', flexWrap: 'wrap', gap: '6px' }}>
            <div>
              <strong>Command #{rec.id} {rec.action}:</strong> <Pill tone={STATE_TONE[rec.state] || 'info'}>{rec.state}</Pill>
            </div>
            <div className="tq-cmd-progress" data-testid="cmd-progress-steps" style={{ display: 'inline-flex', gap: '6px', alignItems: 'center', fontSize: '0.75rem' }}>
              <span style={{ fontWeight: (rec.state === 'SENT' || rec.state === 'ACKNOWLEDGED' || rec.state === 'EXECUTED') ? 700 : 400, color: (rec.state === 'SENT' || rec.state === 'ACKNOWLEDGED' || rec.state === 'EXECUTED') ? 'var(--tq-ok)' : 'var(--tq-muted)' }}>1. Sent</span>
              <span className="tq-muted">→</span>
              <span style={{ fontWeight: (rec.state === 'ACKNOWLEDGED' || rec.state === 'EXECUTED') ? 700 : 400, color: (rec.state === 'ACKNOWLEDGED' || rec.state === 'EXECUTED') ? 'var(--tq-ok)' : 'var(--tq-muted)' }}>2. Acked</span>
              <span className="tq-muted">→</span>
              <span style={{ fontWeight: rec.state === 'EXECUTED' ? 700 : 400, color: rec.state === 'EXECUTED' ? 'var(--tq-ok)' : 'var(--tq-muted)' }}>3. Completed</span>
              {rec.state === 'REJECTED' && <span style={{ color: 'var(--tq-crit)', fontWeight: 700 }}>(Rejected)</span>}
              {rec.state === 'FAILED' && <span style={{ color: 'var(--tq-crit)', fontWeight: 700 }}>(Failed)</span>}
            </div>
          </div>
          {(rec.reasons || []).join(' · ') || rec.ack_reason || ''}
        </div>
      )}
    </Card>
  );
}
