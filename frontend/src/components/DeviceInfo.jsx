import React from 'react';
import { Cpu, CheckCircle, AlertCircle, Radio, Clock, Shield, CircuitBoard, Layers } from 'lucide-react';
import StatusBadge from './StatusBadge';

export default function DeviceInfo({ deviceStatus, telemetry }) {
  const isConnected = deviceStatus?.connection_state === 'CONNECTED';
  const sensors = telemetry?.sensor_health || deviceStatus?.sensor_health || {
    adxl345: true,
    ds18b20: true,
    ina219: true,
    a3144: true,
  };

  const sensorList = [
    { key: 'adxl345', name: 'ADXL345', role: '3-Axis Vibration Acceleration & Dynamic RMS', healthy: sensors.adxl345 },
    { key: 'ds18b20', name: 'DS18B20', role: 'Motor Surface Digital Temperature (°C)', healthy: sensors.ds18b20 },
    { key: 'ina219', name: 'INA219', role: 'High-Side Bus Voltage, Current & Power', healthy: sensors.ina219 },
    { key: 'a3144', name: 'A3144', role: 'Hall-Effect Shaft RPM Interrupt Counter', healthy: sensors.a3144 },
  ];

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

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
            <CircuitBoard size={18} />
          </div>
          <div>
            <h3 style={{ fontSize: '12px', fontWeight: '800', color: 'var(--text-secondary)', margin: 0, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              DEVICE METADATA & SENSOR BUS INTEGRITY
            </h3>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              Hardware Configuration Map
            </span>
          </div>
        </div>
        <StatusBadge status={deviceStatus?.connection_state || 'OFFLINE'} size="sm" />
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: '14px',
      }}>
        {/* Node Specifications */}
        <div style={{
          backgroundColor: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '8px',
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          fontSize: '12px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-muted)' }}>Microcontroller:</span>
            <strong style={{ color: 'var(--text-primary)' }}>ESP32-S3 (Dual-Core LX7)</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-muted)' }}>Hardware ID:</span>
            <strong style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {deviceStatus?.device_id || 'ESP32-MOTOR-01'}
            </strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-muted)' }}>Firmware Version:</span>
            <strong style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              v{deviceStatus?.firmware || '1.0.0'}
            </strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-muted)' }}>Network Protocol:</span>
            <strong style={{ color: 'var(--text-primary)' }}>Wi-Fi Station &bull; HTTP REST / JSON</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ color: 'var(--text-muted)' }}>Host LAN IP:</span>
            <strong style={{ color: 'var(--accent-cyan)', fontFamily: 'var(--font-mono)' }}>
              {deviceStatus?.ip_address || '—'}
            </strong>
          </div>
        </div>

        {/* Sensor Health Map */}
        <div style={{
          backgroundColor: 'rgba(255, 255, 255, 0.02)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '8px',
          padding: '14px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}>
          <span style={{ fontSize: '10px', fontWeight: '800', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            ATTACHED SENSOR HEALTH
          </span>
          {sensorList.map((s) => (
            <div
              key={s.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: '12px',
                padding: '4px 0',
                borderBottom: '1px solid rgba(255, 255, 255, 0.03)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {s.healthy && isConnected ? (
                  <CheckCircle size={15} color="#10b981" />
                ) : (
                  <AlertCircle size={15} color="#ef4444" />
                )}
                <span style={{ fontWeight: '800', color: 'var(--text-primary)' }}>{s.name}</span>
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>({s.role})</span>
              </div>
              <span style={{
                fontSize: '10px',
                fontWeight: '800',
                color: s.healthy && isConnected ? '#10b981' : '#ef4444',
                fontFamily: 'var(--font-mono)',
                padding: '1px 6px',
                borderRadius: '4px',
                backgroundColor: s.healthy && isConnected ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                border: `1px solid ${s.healthy && isConnected ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)'}`,
              }}>
                {s.healthy && isConnected ? 'HEALTHY' : 'UNAVAILABLE'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
