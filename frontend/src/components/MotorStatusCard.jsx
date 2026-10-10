import React, { useState } from 'react';
import { Gauge, RotateCw, Power, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import StatusBadge from './StatusBadge';

export default function MotorStatusCard({ telemetry, deviceStatus, health }) {
  const isConnected = deviceStatus?.connection_state === 'CONNECTED';
  const isRunning = isConnected && Boolean(telemetry?.motor_running);
  const rpm = telemetry?.rpm ?? 0;

  const [inFlight, setInFlight] = useState(false);
  const [feedback, setFeedback] = useState(null);

  // Determine overall motor state display
  let motorState = 'OFFLINE';
  if (isConnected) {
    if (health?.status === 'BASELINE_REQUIRED') {
      motorState = 'BASELINE REQUIRED';
    } else if (health?.status === 'CRITICAL') {
      motorState = isRunning ? 'CRITICAL (RUNNING)' : 'CRITICAL (STOPPED)';
    } else if (health?.status === 'WARNING') {
      motorState = isRunning ? 'WARNING (RUNNING)' : 'WARNING (STOPPED)';
    } else {
      motorState = isRunning ? 'RUNNING' : 'STOPPED';
    }
  }

  const sendMotorCommand = async (action) => {
    if (!isConnected || inFlight) return;
    setInFlight(true);
    setFeedback({ type: 'info', message: `Transmitting MOTOR_${action} over TCP socket...` });

    try {
      const response = await fetch('/api/motor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: action }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.detail || data.message || `MOTOR_${action} command failed`);
      }

      setFeedback({
        type: 'success',
        message: `MOTOR_${action} acknowledged by ESP32 (${data.ack || 'ACK OK'})`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err.message || 'Motor command failed — ESP32 not connected',
      });
    } finally {
      setInFlight(false);
      setTimeout(() => setFeedback(null), 5000);
    }
  };

  return (
    <div className="tech-card" style={{
      padding: '22px 24px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Corner Technical Markings */}
      <div className="tech-corner-tl" />
      <div className="tech-corner-tr" />
      <div className="tech-corner-bl" />
      <div className="tech-corner-br" />

      {/* Card Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '32px',
            height: '32px',
            borderRadius: '8px',
            backgroundColor: isRunning ? 'rgba(16, 185, 129, 0.15)' : 'rgba(255, 255, 255, 0.05)',
            border: `1px solid ${isRunning ? 'rgba(16, 185, 129, 0.35)' : 'var(--border-subtle)'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: isRunning ? '#10b981' : 'var(--text-muted)',
            boxShadow: isRunning ? '0 0 10px rgba(16, 185, 129, 0.2)' : 'none',
          }}>
            <Power size={16} />
          </div>
          <div>
            <h3 style={{ fontSize: '12px', fontWeight: '800', color: 'var(--text-secondary)', margin: 0, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              MOTOR OPERATIONAL STATE
            </h3>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              RS-775 &bull; 24V DC &bull; BTS7960 DRIVER
            </span>
          </div>
        </div>
        <StatusBadge status={motorState} size="sm" />
      </div>

      {/* Main Motor Status & Isometric Vector Visualizer */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        margin: '8px 0 12px 0',
        padding: '12px 16px',
        background: 'linear-gradient(135deg, rgba(255,255,255,0.03) 0%, rgba(0,0,0,0.2) 100%)',
        borderRadius: '10px',
        border: '1px solid var(--border-subtle)',
      }}>
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>
            Drive Status
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{
              fontSize: '24px',
              fontWeight: '900',
              color: isRunning ? '#10b981' : isConnected ? 'var(--text-primary)' : 'var(--text-muted)',
              letterSpacing: '-0.02em',
              textShadow: isRunning ? '0 0 16px rgba(16, 185, 129, 0.35)' : 'none',
            }}>
              {isRunning ? 'RUNNING' : isConnected ? 'STOPPED' : 'OFFLINE'}
            </span>
            {isRunning && (
              <RotateCw size={20} color="#10b981" className="spin-animation-slow" />
            )}
          </div>
        </div>

        {/* 3D Isometric Motor Vector Illustration */}
        <div style={{ width: '90px', height: '60px', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="86" height="54" viewBox="0 0 86 54" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="motorBodyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#334155" />
                <stop offset="50%" stopColor="#1e293b" />
                <stop offset="100%" stopColor="#0f172a" />
              </linearGradient>
              <linearGradient id="motorShaftGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#cbd5e1" />
                <stop offset="100%" stopColor="#64748b" />
              </linearGradient>
            </defs>
            <rect x="22" y="10" width="46" height="34" rx="4" fill="url(#motorBodyGrad)" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
            <line x1="30" y1="12" x2="30" y2="42" stroke="rgba(255,255,255,0.1)" strokeWidth="1.5" />
            <line x1="38" y1="12" x2="38" y2="42" stroke="rgba(255,255,255,0.1)" strokeWidth="1.5" />
            <line x1="46" y1="12" x2="46" y2="42" stroke="rgba(255,255,255,0.1)" strokeWidth="1.5" />
            <line x1="54" y1="12" x2="54" y2="42" stroke="rgba(255,255,255,0.1)" strokeWidth="1.5" />
            <rect x="68" y="17" width="6" height="20" rx="1.5" fill="#475569" stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
            <rect x="74" y="23" width="10" height="8" rx="1" fill="url(#motorShaftGrad)" stroke="#94a3b8" strokeWidth="0.8" />
            <rect x="16" y="15" width="6" height="24" rx="2" fill="#1e293b" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
            <rect x="10" y="18" width="6" height="3" rx="0.5" fill="#f59e0b" />
            <rect x="10" y="33" width="6" height="3" rx="0.5" fill="#3b82f6" />
            {isRunning && (
              <circle cx="79" cy="27" r="11" stroke="#10b981" strokeWidth="1.2" strokeDasharray="3 3" opacity="0.8" className="spin-animation" />
            )}
          </svg>
        </div>
      </div>

      {/* Real Hardware Motor Control Buttons (TCP Socket Commands) */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        margin: '4px 0 10px 0',
        padding: '10px 12px',
        backgroundColor: 'rgba(0, 0, 0, 0.25)',
        borderRadius: '8px',
        border: '1px solid var(--border-subtle)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '10px', fontWeight: '800', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>
            HARDWARE ACTUATION (TCP)
          </span>
          {inFlight && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', color: 'var(--accent-cyan)' }}>
              <Loader2 size={12} className="spin-animation" /> Dispatching...
            </span>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          {/* MOTOR ON Button */}
          <button
            onClick={() => sendMotorCommand('ON')}
            disabled={!isConnected || inFlight}
            style={{
              padding: '10px 14px',
              borderRadius: '6px',
              fontWeight: '800',
              fontSize: '12px',
              letterSpacing: '0.05em',
              cursor: isConnected && !inFlight ? 'pointer' : 'not-allowed',
              opacity: isConnected && !inFlight ? 1 : 0.4,
              backgroundColor: isRunning ? 'rgba(16, 185, 129, 0.2)' : 'rgba(16, 185, 129, 0.1)',
              color: '#10b981',
              border: '1px solid rgba(16, 185, 129, 0.4)',
              boxShadow: isRunning ? '0 0 12px rgba(16, 185, 129, 0.25)' : 'none',
              transition: 'all 0.2s ease',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
            }}
          >
            <Power size={14} /> MOTOR ON
          </button>

          {/* MOTOR OFF Button */}
          <button
            onClick={() => sendMotorCommand('OFF')}
            disabled={!isConnected || inFlight}
            style={{
              padding: '10px 14px',
              borderRadius: '6px',
              fontWeight: '800',
              fontSize: '12px',
              letterSpacing: '0.05em',
              cursor: isConnected && !inFlight ? 'pointer' : 'not-allowed',
              opacity: isConnected && !inFlight ? 1 : 0.4,
              backgroundColor: !isRunning && isConnected ? 'rgba(239, 68, 68, 0.2)' : 'rgba(239, 68, 68, 0.1)',
              color: '#ef4444',
              border: '1px solid rgba(239, 68, 68, 0.4)',
              boxShadow: !isRunning && isConnected ? '0 0 12px rgba(239, 68, 68, 0.25)' : 'none',
              transition: 'all 0.2s ease',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
            }}
          >
            <Power size={14} /> MOTOR OFF
          </button>
        </div>

        {/* Command Feedback Notification */}
        {feedback && (
          <div style={{
            marginTop: '4px',
            padding: '6px 10px',
            borderRadius: '4px',
            fontSize: '11px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            backgroundColor: feedback.type === 'success' ? 'rgba(16, 185, 129, 0.15)' : feedback.type === 'error' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(6, 182, 212, 0.15)',
            border: `1px solid ${feedback.type === 'success' ? 'rgba(16, 185, 129, 0.3)' : feedback.type === 'error' ? 'rgba(239, 68, 68, 0.3)' : 'rgba(6, 182, 212, 0.3)'}`,
            color: feedback.type === 'success' ? '#10b981' : feedback.type === 'error' ? '#ef4444' : 'var(--accent-cyan)',
          }}>
            {feedback.type === 'success' ? <CheckCircle2 size={13} /> : feedback.type === 'error' ? <AlertTriangle size={13} /> : <Loader2 size={13} className="spin-animation" />}
            <span style={{ flex: 1 }}>{feedback.message}</span>
          </div>
        )}
      </div>

      {/* Shaft Speed Footer Readout */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingTop: '10px',
        borderTop: '1px solid var(--border-subtle)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Gauge size={16} color="var(--accent-cyan)" />
          <span style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)' }}>Shaft Speed:</span>
        </div>
        <span style={{
          fontSize: '17px',
          fontWeight: '800',
          fontFamily: 'var(--font-mono)',
          color: isConnected ? 'var(--accent-cyan)' : 'var(--text-muted)',
          letterSpacing: '-0.01em',
          textShadow: isConnected ? '0 0 10px rgba(6, 182, 212, 0.3)' : 'none',
        }}>
          {isConnected ? `${rpm.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })} RPM` : '—'}
        </span>
      </div>
    </div>
  );
}
