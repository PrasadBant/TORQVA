import React, { useState, useEffect } from 'react';
import { Sliders, Play, XCircle, RotateCcw, Check, AlertTriangle, RefreshCw, Cpu } from 'lucide-react';
import StatusBadge from './StatusBadge';

export default function BaselinePanel({
  baseline,
  onStartBaseline,
  onCancelBaseline,
  onResetBaseline,
  isDeviceConnected,
}) {
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const status = baseline?.status || 'NOT_CONFIGURED';
  const isCollecting = status === 'COLLECTING';
  const isSaved = status === 'SAVED';

  // Progress timer simulation during active collection
  useEffect(() => {
    let interval = null;
    if (isCollecting) {
      setElapsedSeconds(0);
      interval = setInterval(() => {
        setElapsedSeconds((prev) => Math.min(30, prev + 1));
      }, 1000);
    } else {
      setElapsedSeconds(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isCollecting]);

  const handleStart = async () => {
    try {
      setActionLoading(true);
      await onStartBaseline();
    } catch (err) {
      console.error('Failed to start baseline:', err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async () => {
    try {
      setActionLoading(true);
      await onCancelBaseline();
    } catch (err) {
      console.error('Failed to cancel baseline:', err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleConfirmReset = async () => {
    try {
      setActionLoading(true);
      await onResetBaseline();
      setIsResetModalOpen(false);
    } catch (err) {
      console.error('Failed to reset baseline:', err);
    } finally {
      setActionLoading(false);
    }
  };

  const progressPercent = Math.min(100, Math.round((elapsedSeconds / 30) * 100));

  return (
    <div className="tech-card" style={{
      padding: '22px 24px',
      display: 'flex',
      flexDirection: 'column',
      gap: '16px',
    }}>
      {/* Corner Technical Markings */}
      <div className="tech-corner-tl" />
      <div className="tech-corner-tr" />
      <div className="tech-corner-bl" />
      <div className="tech-corner-br" />

      {/* Header & Controls */}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '32px',
            height: '32px',
            borderRadius: '8px',
            backgroundColor: 'rgba(6, 182, 212, 0.1)',
            border: '1px solid rgba(6, 182, 212, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--accent-cyan)',
          }}>
            <Sliders size={18} />
          </div>
          <div>
            <h3 style={{ fontSize: '12px', fontWeight: '800', color: 'var(--text-secondary)', margin: 0, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              BASELINE CALIBRATION & SIGNATURE PROFILING
            </h3>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              30-Second Steady State Reference
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <StatusBadge status={status} size="sm" />

          {/* Action Buttons */}
          {!isCollecting && (
            <button
              onClick={handleStart}
              disabled={actionLoading || !isDeviceConnected}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '7px 16px',
                borderRadius: '8px',
                backgroundColor: isDeviceConnected ? 'var(--accent-cyan)' : 'rgba(255, 255, 255, 0.05)',
                color: isDeviceConnected ? '#000' : 'var(--text-muted)',
                border: 'none',
                fontWeight: '800',
                fontSize: '11px',
                letterSpacing: '0.04em',
                cursor: isDeviceConnected ? 'pointer' : 'not-allowed',
                boxShadow: isDeviceConnected ? '0 0 16px -2px rgba(6, 182, 212, 0.35)' : 'none',
                transition: 'all 0.2s ease',
              }}
            >
              {actionLoading ? <RefreshCw size={13} className="spin-animation" /> : <Play size={13} />}
              START 30s BASELINE
            </button>
          )}

          {isCollecting && (
            <button
              onClick={handleCancel}
              disabled={actionLoading}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '7px 16px',
                borderRadius: '8px',
                backgroundColor: 'rgba(239, 68, 68, 0.2)',
                color: '#f87171',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                fontWeight: '800',
                fontSize: '11px',
                cursor: 'pointer',
              }}
            >
              <XCircle size={14} />
              CANCEL
            </button>
          )}

          {isSaved && !isCollecting && (
            <button
              onClick={() => setIsResetModalOpen(true)}
              disabled={actionLoading}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '7px 14px',
                borderRadius: '8px',
                backgroundColor: 'rgba(255, 255, 255, 0.04)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--border-tech)',
                fontWeight: '700',
                fontSize: '11px',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
              }}
            >
              <RotateCcw size={13} />
              RESET
            </button>
          )}
        </div>
      </div>

      {/* Active Collection Progress Bar */}
      {isCollecting && (
        <div style={{
          backgroundColor: 'rgba(6, 182, 212, 0.08)',
          border: '1px solid rgba(6, 182, 212, 0.3)',
          borderRadius: '10px',
          padding: '16px 18px',
          boxShadow: '0 0 20px rgba(6, 182, 212, 0.1)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <span style={{ fontSize: '13px', fontWeight: '800', color: 'var(--accent-cyan)', letterSpacing: '0.02em' }}>
              Collecting Motor Fingerprint on ESP32-S3...
            </span>
            <span style={{ fontSize: '12px', fontWeight: '800', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {elapsedSeconds} / 30 seconds ({progressPercent}%)
            </span>
          </div>
          <div style={{
            width: '100%',
            height: '8px',
            backgroundColor: 'rgba(0, 0, 0, 0.4)',
            borderRadius: '4px',
            overflow: 'hidden',
            border: '1px solid rgba(255, 255, 255, 0.06)',
          }}>
            <div style={{
              width: `${progressPercent}%`,
              height: '100%',
              background: 'linear-gradient(90deg, #06b6d4 0%, #10b981 100%)',
              boxShadow: '0 0 10px rgba(6, 182, 212, 0.5)',
              transition: 'width 0.5s ease',
            }} />
          </div>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '10px 0 0 0', lineHeight: '1.4' }}>
            Hardware node is accumulating valid physical sensor vectors. Do not alter motor speed or load during calibration.
          </p>
        </div>
      )}

      {/* Stored Baseline Values Grid */}
      {isSaved ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: '10px' }}>
          <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-subtle)', padding: '12px', borderRadius: '8px' }}>
            <span style={{ fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', letterSpacing: '0.04em' }}>TEMP REF</span>
            <span style={{ fontSize: '15px', fontWeight: '800', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {baseline.temperature?.toFixed(1) ?? '—'} °C
            </span>
          </div>

          <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-subtle)', padding: '12px', borderRadius: '8px' }}>
            <span style={{ fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', letterSpacing: '0.04em' }}>VIB RMS REF</span>
            <span style={{ fontSize: '15px', fontWeight: '800', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {baseline.vibration_rms?.toFixed(3) ?? '—'} g
            </span>
          </div>

          <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-subtle)', padding: '12px', borderRadius: '8px' }}>
            <span style={{ fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', letterSpacing: '0.04em' }}>SPEED REF</span>
            <span style={{ fontSize: '15px', fontWeight: '800', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {baseline.rpm?.toFixed(0) ?? '—'} RPM
            </span>
          </div>

          <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-subtle)', padding: '12px', borderRadius: '8px' }}>
            <span style={{ fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', letterSpacing: '0.04em' }}>VOLTAGE REF</span>
            <span style={{ fontSize: '15px', fontWeight: '800', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {baseline.voltage?.toFixed(2) ?? '—'} V
            </span>
          </div>

          <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-subtle)', padding: '12px', borderRadius: '8px' }}>
            <span style={{ fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', letterSpacing: '0.04em' }}>CURRENT REF</span>
            <span style={{ fontSize: '15px', fontWeight: '800', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {baseline.current?.toFixed(2) ?? '—'} A
            </span>
          </div>

          <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-subtle)', padding: '12px', borderRadius: '8px' }}>
            <span style={{ fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', letterSpacing: '0.04em' }}>POWER REF</span>
            <span style={{ fontSize: '15px', fontWeight: '800', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {baseline.power?.toFixed(1) ?? '—'} W
            </span>
          </div>
        </div>
      ) : !isCollecting && (
        <div style={{
          backgroundColor: 'rgba(255, 255, 255, 0.02)',
          border: '1px dashed var(--border-tech)',
          borderRadius: '8px',
          padding: '18px',
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: '13px',
        }}>
          No baseline fingerprint stored. Click <strong>START 30s BASELINE</strong> while the motor runs normally to calibrate condition boundaries.
        </div>
      )}

      {/* Confirmation Modal for Reset */}
      {isResetModalOpen && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.82)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          backdropFilter: 'blur(8px)',
        }}>
          <div style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            borderRadius: '12px',
            padding: '24px',
            maxWidth: '420px',
            width: '90%',
            boxShadow: '0 20px 40px rgba(0, 0, 0, 0.8), 0 0 24px rgba(239, 68, 68, 0.2)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#f87171', marginBottom: '12px' }}>
              <AlertTriangle size={24} />
              <h4 style={{ fontSize: '16px', fontWeight: '800', margin: 0 }}>Reset Motor Baseline?</h4>
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.5', marginBottom: '20px' }}>
              This will erase the saved baseline calibration from SQLite storage. Health evaluations will require a new calibration session.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => setIsResetModalOpen(false)}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  backgroundColor: 'transparent',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border-tech)',
                  fontWeight: '700',
                  fontSize: '13px',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmReset}
                disabled={actionLoading}
                style={{
                  padding: '8px 16px',
                  borderRadius: '6px',
                  backgroundColor: '#ef4444',
                  color: '#fff',
                  border: 'none',
                  fontWeight: '800',
                  fontSize: '13px',
                  cursor: 'pointer',
                  boxShadow: '0 0 12px rgba(239, 68, 68, 0.4)',
                }}
              >
                {actionLoading ? 'Resetting...' : 'Confirm Reset'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
