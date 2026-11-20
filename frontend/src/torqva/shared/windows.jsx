import React, { useState } from 'react';
import { RotateCcw, Clock } from 'lucide-react';
import { api } from '../api.js';

export const TELEMETRY_WINDOWS = [
  { seconds: 1, label: '1s' },
  { seconds: 10, label: '10s' },
  { seconds: 30, label: '30s' },
  { seconds: 60, label: '60s' },
  { seconds: 180, label: '3min' },
  { seconds: 300, label: '5min' },
];

export function windowName(sec) {
  const found = TELEMETRY_WINDOWS.find((w) => w.seconds === Number(sec));
  return found ? found.label : `${sec}s`;
}

/** Shared Telemetry Windows selector and Session History Reset button */
export function TelemetryWindowControl({
  seconds = 60,
  onChange,
  role = 'operator',
  onReset,
  className = '',
  showReset = true,
  testid = 'telemetry-windows-control',
}) {
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState(null);

  const handleReset = async () => {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm('Reset telemetry view buffers and session history? (Live device or simulator will continue running)')) {
      return;
    }
    setResetting(true);
    setResetMsg(null);
    try {
      await api.resetHistory();
      if (onReset) onReset();
      setResetMsg('Cleared');
      setTimeout(() => setResetMsg(null), 2500);
    } catch (e) {
      setResetMsg('Failed');
      setTimeout(() => setResetMsg(null), 2500);
    } finally {
      setResetting(false);
    }
  };

  const isOperator = role === 'operator' || role === 'admin';

  return (
    <div
      className={`tq-window-toolbar ${className}`.trim()}
      data-testid={testid}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}
    >
      <span className="tq-toolbar-label" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
        <Clock size={13} aria-hidden="true" /> Time window
      </span>
      <div className="tq-seg" role="group" aria-label="Telemetry window duration">
        {TELEMETRY_WINDOWS.map((w) => (
          <button
            key={w.seconds}
            type="button"
            className="tq-btn"
            aria-pressed={Number(seconds) === w.seconds}
            onClick={() => onChange && onChange(w.seconds)}
            data-testid={`window-btn-${w.label}`}
          >
            {w.label}
          </button>
        ))}
      </div>

      {showReset && (
        <button
          type="button"
          className="tq-btn tq-ghost"
          onClick={handleReset}
          disabled={!isOperator || resetting}
          data-testid="history-reset-btn"
          title="Reset session history and view buffers (operator/admin)"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', padding: '3px 8px' }}
        >
          <RotateCcw size={12} className={resetting ? 'spin' : ''} aria-hidden="true" />
          <span>{resetMsg || 'Reset History'}</span>
        </button>
      )}
    </div>
  );
}
