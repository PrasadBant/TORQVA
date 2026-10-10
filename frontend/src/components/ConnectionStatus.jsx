import React, { useState, useEffect } from 'react';
import { Server, Wifi, Clock, AlertTriangle, ShieldCheck, Activity } from 'lucide-react';
import StatusBadge from './StatusBadge';

export default function ConnectionStatus({ deviceStatus, telemetry }) {
  const [secondsAgo, setSecondsAgo] = useState(null);

  useEffect(() => {
    const updateElapsed = () => {
      const lastSeen = deviceStatus?.last_seen;
      if (lastSeen) {
        const diff = (Date.now() / 1000) - lastSeen;
        setSecondsAgo(Math.max(0, diff).toFixed(1));
      } else {
        setSecondsAgo(null);
      }
    };

    updateElapsed();
    const timer = setInterval(updateElapsed, 500);
    return () => clearInterval(timer);
  }, [deviceStatus?.last_seen]);

  const isConnected = deviceStatus?.connection_state === 'CONNECTED';
  const isStale = deviceStatus?.connection_state === 'STALE';
  const isOffline = !isConnected && !isStale;

  return (
    <div className="tech-card" style={{
      padding: '22px 24px',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
    }}>
      {/* Corner Technical Markings */}
      <div className="tech-corner-tl" />
      <div className="tech-corner-tr" />
      <div className="tech-corner-bl" />
      <div className="tech-corner-br" />

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
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
            <Server size={18} />
          </div>
          <div>
            <h3 style={{ fontSize: '12px', fontWeight: '800', color: 'var(--text-secondary)', margin: 0, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              HARDWARE TELEMETRY LINK
            </h3>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              ESP32-S3 Node
            </span>
          </div>
        </div>
        <StatusBadge status={deviceStatus?.connection_state || 'OFFLINE'} size="sm" />
      </div>

      {/* 4-Cell Parameter Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: '10px',
        margin: '6px 0',
      }}>
        <div style={{
          backgroundColor: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '8px',
          padding: '10px 12px',
        }}>
          <span style={{ fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            DEVICE ID
          </span>
          <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
            {deviceStatus?.device_id || 'ESP32-MOTOR-01'}
          </span>
        </div>

        <div style={{
          backgroundColor: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '8px',
          padding: '10px 12px',
        }}>
          <span style={{ fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            IP ADDRESS
          </span>
          <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
            {deviceStatus?.ip_address || '—'}
          </span>
        </div>

        <div style={{
          backgroundColor: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '8px',
          padding: '10px 12px',
        }}>
          <span style={{ fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            LAST PACKET
          </span>
          <span style={{
            fontSize: '13px',
            fontWeight: '700',
            color: isConnected ? '#10b981' : isStale ? '#f59e0b' : '#ef4444',
            fontFamily: 'var(--font-mono)',
          }}>
            {secondsAgo !== null ? `${secondsAgo}s ago` : 'Never'}
          </span>
        </div>

        <div style={{
          backgroundColor: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '8px',
          padding: '10px 12px',
        }}>
          <span style={{ fontSize: '10px', fontWeight: '700', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            FIRMWARE
          </span>
          <span style={{ fontSize: '13px', fontWeight: '700', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
            v{deviceStatus?.firmware || '1.0.0'}
          </span>
        </div>
      </div>

      {isOffline && (
        <div style={{
          marginTop: '10px',
          padding: '8px 12px',
          backgroundColor: 'rgba(239, 68, 68, 0.08)',
          border: '1px solid rgba(239, 68, 68, 0.25)',
          borderRadius: '6px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '11px',
          fontWeight: '600',
          color: '#f87171',
        }}>
          <AlertTriangle size={14} />
          <span>ESP32-S3 OFFLINE &bull; Sensor data is not live</span>
        </div>
      )}
    </div>
  );
}
