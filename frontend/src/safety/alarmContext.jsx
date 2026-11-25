import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { AlertTriangle, Bell, BellOff, Volume2, VolumeX, ShieldAlert } from 'lucide-react';

export const AlarmContext = createContext(null);

export function useAlarmContext() {
  const ctx = useContext(AlarmContext);
  if (!ctx) {
    // Return safe fallback if not wrapped
    return {
      threshold: 3000,
      clearThreshold: 2900,
      active: false,
      hallInvalid: false,
      muted: false,
      muteRemaining: 0,
      mute: () => {},
      unmute: () => {},
      setThreshold: () => {},
      evaluate: () => {},
    };
  }
  return ctx;
}

export function AlarmProvider({ children }) {
  const [threshold, setThresholdState] = useState(3000);
  const [active, setActive] = useState(false);
  const [hallInvalid, setHallInvalid] = useState(false);
  const [muted, setMuted] = useState(false);
  const [muteRemaining, setMuteRemaining] = useState(0);

  const muteTimerRef = useRef(null);
  const muteIntervalRef = useRef(null);

  const clearThreshold = Math.max(0, threshold - 100);

  const mute = useCallback((seconds = 10) => {
    setMuted(true);
    setMuteRemaining(seconds);

    if (muteTimerRef.current) clearTimeout(muteTimerRef.current);
    if (muteIntervalRef.current) clearInterval(muteIntervalRef.current);

    muteIntervalRef.current = setInterval(() => {
      setMuteRemaining((r) => {
        if (r <= 1) {
          clearInterval(muteIntervalRef.current);
          muteIntervalRef.current = null;
          return 0;
        }
        return r - 1;
      });
    }, 1000);

    muteTimerRef.current = setTimeout(() => {
      setMuted(false);
      setMuteRemaining(0);
      if (muteIntervalRef.current) {
        clearInterval(muteIntervalRef.current);
        muteIntervalRef.current = null;
      }
    }, seconds * 1000);
  }, []);

  const unmute = useCallback(() => {
    setMuted(false);
    setMuteRemaining(0);
    if (muteTimerRef.current) {
      clearTimeout(muteTimerRef.current);
      muteTimerRef.current = null;
    }
    if (muteIntervalRef.current) {
      clearInterval(muteIntervalRef.current);
      muteIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (muteTimerRef.current) clearTimeout(muteTimerRef.current);
      if (muteIntervalRef.current) clearInterval(muteIntervalRef.current);
    };
  }, []);

  const evaluate = useCallback((params) => {
    const { rpm, isRunning, valid } = params || {};

    if (!isRunning) {
      setActive(false);
      setHallInvalid(false);
      return;
    }

    // Hall Invalid check: running but sensor sample is missing, null or explicitly invalid
    const isRpmValid = valid !== false && rpm !== null && rpm !== undefined && Number.isFinite(Number(rpm));
    if (!isRpmValid) {
      setHallInvalid(true);
      setActive(false);
      return;
    }

    setHallInvalid(false);
    const speed = Number(rpm);

    setActive((prevActive) => {
      if (speed >= threshold) {
        return true;
      }
      if (speed < clearThreshold) {
        return false;
      }
      return prevActive; // Hysteresis zone (between 2900 and 3000)
    });
  }, [threshold, clearThreshold]);

  const setThreshold = (val) => {
    const num = Math.max(100, Math.min(20000, Number(val) || 3000));
    setThresholdState(num);
  };

  const value = {
    threshold,
    clearThreshold,
    active,
    hallInvalid,
    muted,
    muteRemaining,
    mute,
    unmute,
    setThreshold,
    evaluate,
  };

  return <AlarmContext.Provider value={value}>{children}</AlarmContext.Provider>;
}

/** Shared 3000 RPM Advisory Alarm and Speed Unavailable Banner */
export function RpmAlarmBanner({ rpm, className = '' }) {
  const { active, hallInvalid, threshold, clearThreshold, muted, muteRemaining, mute, unmute, setThreshold } = useAlarmContext();

  if (!active && !hallInvalid) return null;

  if (hallInvalid) {
    return (
      <div
        className={`tq-callout warn ${className}`.trim()}
        role="alert"
        data-testid="hall-invalid-warning"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          margin: '8px 0',
          background: 'rgba(245, 158, 11, 0.12)',
          border: '1px solid rgba(245, 158, 11, 0.4)',
          borderRadius: '6px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <AlertTriangle size={18} style={{ color: '#f59e0b' }} aria-hidden="true" />
          <div>
            <strong style={{ color: '#f59e0b' }}>SPEED UNAVAILABLE: </strong>
            <span>The drive is active but the Hall speed reading is invalid or missing. Speed is unknown, never zero.</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`tq-callout crit ${className}`.trim()}
      role="alert"
      data-testid="rpm-alarm-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px',
        margin: '8px 0',
        background: 'rgba(239, 68, 68, 0.12)',
        border: '1px solid rgba(239, 68, 68, 0.4)',
        borderRadius: '6px',
        flexWrap: 'wrap',
        gap: '8px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <ShieldAlert size={18} style={{ color: '#ef4444' }} aria-hidden="true" />
        <div>
          <strong style={{ color: '#ef4444' }}>SPEED ADVISORY ALARM: </strong>
          <span>
            Measured speed {rpm != null ? `${Math.round(rpm)} rpm` : ''} exceeded advisory threshold ({threshold} rpm). Clears &lt; {clearThreshold} rpm (hysteresis).
          </span>
          <span className="tq-small tq-muted" style={{ display: 'block' }}>
            Advisory warning only — does not cut motor power.
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button
          type="button"
          className="tq-btn tq-ghost"
          onClick={() => (muted ? unmute() : mute(10))}
          data-testid="alarm-mute-btn"
          aria-pressed={muted}
          title={muted ? 'Alarm muted (expires automatically)' : 'Mute alarm for 10 seconds'}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '0.82rem', padding: '4px 10px' }}
        >
          {muted ? <BellOff size={14} style={{ color: '#f59e0b' }} /> : <Bell size={14} />}
          <span>{muted ? `Muted (${muteRemaining}s)` : 'Mute (10s)'}</span>
        </button>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '0.8rem', color: 'var(--tq-text-muted, #94a3b8)' }}>
          Limit:
          <input
            type="number"
            min="1000"
            max="20000"
            step="100"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            data-testid="alarm-threshold-input"
            style={{ width: '70px', padding: '2px 6px', fontSize: '0.8rem', borderRadius: '4px', border: '1px solid var(--tq-border, #475569)' }}
          />
          <span style={{ fontSize: '0.75rem' }}>rpm</span>
        </label>
      </div>
    </div>
  );
}
