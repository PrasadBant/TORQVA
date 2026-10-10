import React from 'react';
import { Thermometer, Activity, Gauge, Zap, BatteryCharging, Flame } from 'lucide-react';
import SensorCard from './SensorCard';

export default function SensorGrid({ telemetry, baseline, health, deviceStatus }) {
  const isConnected = deviceStatus?.connection_state === 'CONNECTED';
  const sensorHealth = telemetry?.sensor_health || { adxl345: true, ds18b20: true, ina219: true, a3144: true };

  // Determine parameter status based on health engine factors if available
  const tempStatus = (health?.factors?.temperature ?? 100) < 70 ? 'CRITICAL' : (health?.factors?.temperature ?? 100) < 90 ? 'WARNING' : 'NORMAL';
  const vibStatus = (health?.factors?.vibration ?? 100) < 70 ? 'CRITICAL' : (health?.factors?.vibration ?? 100) < 90 ? 'WARNING' : 'NORMAL';
  const rpmStatus = (health?.factors?.rpm ?? 100) < 70 ? 'CRITICAL' : (health?.factors?.rpm ?? 100) < 90 ? 'WARNING' : 'NORMAL';
  const currStatus = (health?.factors?.current ?? 100) < 70 ? 'CRITICAL' : (health?.factors?.current ?? 100) < 90 ? 'WARNING' : 'NORMAL';
  const pwrStatus = (health?.factors?.power ?? 100) < 70 ? 'CRITICAL' : (health?.factors?.power ?? 100) < 90 ? 'WARNING' : 'NORMAL';

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
      gap: '16px',
    }}>
      {/* 1. Temperature Card */}
      <SensorCard
        title="Temperature"
        icon={Thermometer}
        value={telemetry?.temperature}
        unit="°C"
        baselineValue={baseline?.temperature}
        status={tempStatus}
        isSensorHealthy={sensorHealth.ds18b20}
        isConnected={isConnected}
        precision={1}
      />

      {/* 2. Vibration Card */}
      <SensorCard
        title="Vibration (RMS)"
        icon={Activity}
        value={telemetry?.vibration_rms ?? telemetry?.vibration}
        unit="g"
        baselineValue={baseline?.vibration_rms}
        status={vibStatus}
        isSensorHealthy={sensorHealth.adxl345}
        isConnected={isConnected}
        subMetrics={{
          x: telemetry?.vibration_x,
          y: telemetry?.vibration_y,
          z: telemetry?.vibration_z,
        }}
        precision={3}
      />

      {/* 3. RPM Card */}
      <SensorCard
        title="Rotational Speed"
        icon={Gauge}
        value={telemetry?.rpm}
        unit="RPM"
        baselineValue={baseline?.rpm}
        status={rpmStatus}
        isSensorHealthy={sensorHealth.a3144}
        isConnected={isConnected}
        precision={0}
      />

      {/* 4. Voltage Card */}
      <SensorCard
        title="Bus Voltage"
        icon={Zap}
        value={telemetry?.voltage}
        unit="V"
        baselineValue={baseline?.voltage}
        status="NORMAL"
        isSensorHealthy={sensorHealth.ina219}
        isConnected={isConnected}
        precision={2}
      />

      {/* 5. Current Card */}
      <SensorCard
        title="DC Current"
        icon={BatteryCharging}
        value={telemetry?.current}
        unit="A"
        baselineValue={baseline?.current}
        status={currStatus}
        isSensorHealthy={sensorHealth.ina219}
        isConnected={isConnected}
        precision={2}
      />

      {/* 6. Power Card */}
      <SensorCard
        title="Active Power"
        icon={Flame}
        value={telemetry?.power}
        unit="W"
        baselineValue={baseline?.power}
        status={pwrStatus}
        isSensorHealthy={sensorHealth.ina219}
        isConnected={isConnected}
        precision={1}
      />
    </div>
  );
}
