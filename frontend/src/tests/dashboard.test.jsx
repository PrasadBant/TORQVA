import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Header from '../components/Header';
import StatusBadge from '../components/StatusBadge';
import ConnectionStatus from '../components/ConnectionStatus';
import MotorStatusCard from '../components/MotorStatusCard';
import HardwareConditionCard from '../components/HardwareConditionCard';
import HealthScore from '../components/HealthScore';
import SensorCard from '../components/SensorCard';
import SensorGrid from '../components/SensorGrid';
import BaselinePanel from '../components/BaselinePanel';
import AlertPanel from '../components/AlertPanel';
import DeviceInfo from '../components/DeviceInfo';
import {
  normalizeTelemetry,
  normalizeHealth,
  normalizeBaseline,
  normalizeDeviceStatus,
} from '../utils/normalizers';

describe('Normalizer Utilities', () => {
  it('normalizes telemetry payload properly', () => {
    const raw = {
      device_id: 'ESP32-MOTOR-01',
      temperature: 42.6,
      vibration_rms: 0.18,
      rpm: 1450.0,
      voltage: 23.8,
      current: 1.42,
      motor_running: true,
    };
    const norm = normalizeTelemetry(raw);
    expect(norm.device_id).toBe('ESP32-MOTOR-01');
    expect(norm.temperature).toBe(42.6);
    expect(norm.motor_running).toBe(true);
    expect(norm.power).toBe(33.8); // 23.8 * 1.42 rounded
  });

  it('handles empty / missing telemetry without crashing or inventing fake values', () => {
    const norm = normalizeTelemetry(null);
    expect(norm).toBeNull();
  });

  it('normalizes health results', () => {
    const raw = { score: 92.4, status: 'HEALTHY', factors: { temperature: 95.0 } };
    const norm = normalizeHealth(raw);
    expect(norm.score).toBe(92);
    expect(norm.status).toBe('HEALTHY');
    expect(norm.factors.temperature).toBe(95.0);
  });
});

describe('Dashboard Component Tests & Bug Fix Validations', () => {
  it('renders Header with LIVE HARDWARE only when ESP32 is connected and source is live', () => {
    const deviceStatus = { connection_state: 'CONNECTED', device_id: 'ESP32-MOTOR-01' };
    const telemetry = { source: 'live' };
    render(<Header deviceStatus={deviceStatus} wsConnected={true} telemetry={telemetry} />);

    expect(screen.getByText('SMART DC MOTOR MONITORING')).toBeInTheDocument();
    expect(screen.getByText('LIVE HARDWARE')).toBeInTheDocument();
    expect(screen.getByText('CONNECTED')).toBeInTheDocument();
    expect(screen.getByText('WS STREAM')).toBeInTheDocument();
  });

  it('1 & 2. ESP32 offline does NOT display LIVE HARDWARE, even if WebSocket is connected', () => {
    const deviceStatus = { connection_state: 'OFFLINE', device_id: 'ESP32-MOTOR-01' };
    const telemetry = { source: 'live' };
    render(<Header deviceStatus={deviceStatus} wsConnected={true} telemetry={telemetry} />);

    // Must display DATA NOT LIVE and OFFLINE
    expect(screen.queryByText('LIVE HARDWARE')).not.toBeInTheDocument();
    expect(screen.getByText('DATA NOT LIVE')).toBeInTheDocument();
    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
    expect(screen.getByText('WS STREAM')).toBeInTheDocument();
  });

  it('4. Demo label does not appear unless demo source is active', () => {
    const deviceStatus = { connection_state: 'OFFLINE', device_id: 'ESP32-MOTOR-01' };
    render(<Header deviceStatus={deviceStatus} wsConnected={true} telemetry={null} />);

    expect(screen.queryByText('DEMO')).not.toBeInTheDocument();
    expect(screen.queryByText('DEMO ENGINE')).not.toBeInTheDocument();
    expect(screen.getByText('DATA NOT LIVE')).toBeInTheDocument();
  });

  it('renders ConnectionStatus panel with relative elapsed time', () => {
    const deviceStatus = {
      device_id: 'ESP32-MOTOR-01',
      ip_address: '192.168.1.150',
      connection_state: 'CONNECTED',
      last_seen: Date.now() / 1000 - 1.2,
      firmware: '1.0.0',
    };
    render(<ConnectionStatus deviceStatus={deviceStatus} telemetry={{}} />);

    expect(screen.getByText('HARDWARE TELEMETRY LINK')).toBeInTheDocument();
    expect(screen.getByText('192.168.1.150')).toBeInTheDocument();
    expect(screen.getByText('v1.0.0')).toBeInTheDocument();
  });

  it('renders SensorCard with value and delta comparison', () => {
    render(
      <SensorCard
        title="Temperature"
        value={42.6}
        unit="°C"
        baselineValue={40.8}
        status="NORMAL"
        isSensorHealthy={true}
        isConnected={true}
        precision={1}
      />
    );

    expect(screen.getByText('Temperature')).toBeInTheDocument();
    expect(screen.getByText('42.6')).toBeInTheDocument();
    expect(screen.getByText('+1.8 °C')).toBeInTheDocument();
    expect(screen.getByText(/Baseline:/)).toBeInTheDocument();
  });

  it('3. SENSOR UNAVAILABLE is rendered when sensor health flag is false (does not show 0.0)', () => {
    render(
      <SensorCard
        title="Temperature"
        value={0.0}
        unit="°C"
        baselineValue={40.8}
        status="NORMAL"
        isSensorHealthy={false}
        isConnected={true}
        precision={1}
      />
    );

    expect(screen.getByText('SENSOR UNAVAILABLE')).toBeInTheDocument();
    expect(screen.queryByText('0.0')).not.toBeInTheDocument();
  });

  it('renders SensorGrid with individual sensor health checks (e.g. INA219 failure affects power/current/voltage)', () => {
    const telemetry = {
      temperature: 42.0,
      vibration_rms: 0.15,
      rpm: 1450,
      voltage: 0.0,
      current: 0.0,
      power: 0.0,
      sensor_health: { adxl345: true, ds18b20: true, ina219: false, a3144: true },
    };
    const deviceStatus = { connection_state: 'CONNECTED' };

    render(<SensorGrid telemetry={telemetry} baseline={{}} health={{}} deviceStatus={deviceStatus} />);

    // INA219 affects Bus Voltage, Current, and Active Power
    const unavailableElements = screen.getAllByText('SENSOR UNAVAILABLE');
    expect(unavailableElements.length).toBe(3); // Voltage, Current, Power
  });

  it('renders MotorStatusCard with RUNNING state and RPM', () => {
    const telemetry = { motor_running: true, rpm: 1452.0 };
    const deviceStatus = { connection_state: 'CONNECTED' };
    const health = { status: 'HEALTHY' };

    render(<MotorStatusCard telemetry={telemetry} deviceStatus={deviceStatus} health={health} />);

    expect(screen.getByText('MOTOR OPERATIONAL STATE')).toBeInTheDocument();
    const runningElements = screen.getAllByText('RUNNING');
    expect(runningElements.length).toBeGreaterThan(0);
    expect(screen.getByText('1,452 RPM')).toBeInTheDocument();
  });

  it('5. Health title displays MOTOR HEALTH SCORE rather than Predictive Health Index', () => {
    const health = {
      score: 92,
      status: 'HEALTHY',
      factors: { temperature: 95, vibration: 88, rpm: 100, current: 95, power: 96 },
    };
    const deviceStatus = { connection_state: 'CONNECTED' };

    render(<HealthScore health={health} deviceStatus={deviceStatus} />);

    expect(screen.getByText('MOTOR HEALTH SCORE')).toBeInTheDocument();
    expect(screen.queryByText('PREDICTIVE HEALTH INDEX')).not.toBeInTheDocument();
    expect(screen.getByText('92')).toBeInTheDocument();
    expect(screen.getByText('/ 100')).toBeInTheDocument();
  });

  it('6. Baseline reset requires user confirmation in modal before executing callback', () => {
    const onStart = vi.fn();
    const onCancel = vi.fn();
    const onReset = vi.fn();
    const baseline = { status: 'SAVED', temperature: 40.8, vibration_rms: 0.21, rpm: 1450 };

    render(
      <BaselinePanel
        baseline={baseline}
        onStartBaseline={onStart}
        onCancelBaseline={onCancel}
        onResetBaseline={onReset}
        isDeviceConnected={true}
      />
    );

    expect(screen.getByText('BASELINE CALIBRATION & SIGNATURE PROFILING')).toBeInTheDocument();
    expect(screen.getByText('40.8 °C')).toBeInTheDocument();

    const resetBtn = screen.getByText('RESET');
    fireEvent.click(resetBtn);

    // Confirmation modal should now be visible
    expect(screen.getByText('Reset Motor Baseline?')).toBeInTheDocument();
    expect(onReset).not.toHaveBeenCalled();

    // Confirm button inside modal
    const confirmBtn = screen.getByText('Confirm Reset');
    fireEvent.click(confirmBtn);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('7. No fake alerts appear when no alerts exist (renders clean empty state)', () => {
    render(<AlertPanel alerts={[]} isConnected={true} />);
    expect(screen.getByText('No Active Anomaly Alerts')).toBeInTheDocument();
  });

  it('renders AlertPanel with active alert details from backend', () => {
    const alerts = [
      {
        id: 1,
        severity: 'WARNING',
        parameter: 'vibration',
        title: 'Elevated Dynamic Vibration',
        current_value: 0.82,
        baseline_value: 0.21,
        message: 'Possible mechanical vibration anomaly.',
        suggested_inspection: 'Check motor mounting and bearings.',
        timestamp: Date.now() / 1000,
      },
    ];
    render(<AlertPanel alerts={alerts} isConnected={true} />);
    expect(screen.getByText('Elevated Dynamic Vibration')).toBeInTheDocument();
    expect(screen.getByText('Check motor mounting and bearings.')).toBeInTheDocument();
  });

  it('renders DeviceInfo with attached sensor health checklist', () => {
    const deviceStatus = {
      device_id: 'ESP32-MOTOR-01',
      firmware: '1.0.0',
      ip_address: '192.168.1.150',
      connection_state: 'CONNECTED',
      sensor_health: { adxl345: true, ds18b20: true, ina219: true, a3144: false },
    };
    render(<DeviceInfo deviceStatus={deviceStatus} telemetry={null} />);
    expect(screen.getByText('DEVICE METADATA & SENSOR BUS INTEGRITY')).toBeInTheDocument();
    expect(screen.getByText('ADXL345')).toBeInTheDocument();
    expect(screen.getByText('DS18B20')).toBeInTheDocument();
    expect(screen.getByText('INA219')).toBeInTheDocument();
    expect(screen.getByText('A3144')).toBeInTheDocument();
  });
});

describe('HardwareConditionCard Component Tests', () => {
  it('renders NORMAL hardware condition with LIVE HARDWARE source badge', () => {
    const telemetry = {
      source: 'live',
      hardware_condition: 'NORMAL',
      hardware_reason: 'All monitored parameters within hardware limits.',
      sensor_health: { adxl345: true, ds18b20: true, ina219: true, a3144: true },
    };
    const deviceStatus = { connection_state: 'CONNECTED', device_id: 'ESP32-MOTOR-01' };

    render(<HardwareConditionCard telemetry={telemetry} deviceStatus={deviceStatus} />);
    expect(screen.getByText('HARDWARE CONDITION — ESP32')).toBeInTheDocument();
    expect(screen.getByText('NORMAL CONDITION')).toBeInTheDocument();
    expect(screen.getByText('All monitored parameters within hardware limits.')).toBeInTheDocument();
    expect(screen.getByText('LIVE HARDWARE')).toBeInTheDocument();
    expect(screen.getByText('ESP32-MOTOR-01')).toBeInTheDocument();
  });

  it('renders WARNING hardware condition with warning styling', () => {
    const telemetry = {
      source: 'live',
      hardware_condition: 'WARNING',
      hardware_reason: 'Temperature rise 18% above baseline.',
      sensor_health: { adxl345: true, ds18b20: true, ina219: true, a3144: true },
    };
    const deviceStatus = { connection_state: 'CONNECTED', device_id: 'ESP32-MOTOR-01' };

    render(<HardwareConditionCard telemetry={telemetry} deviceStatus={deviceStatus} />);
    expect(screen.getByText('WARNING CONDITION')).toBeInTheDocument();
    expect(screen.getByText('Temperature rise 18% above baseline.')).toBeInTheDocument();
  });

  it('renders CRITICAL hardware condition clearly and visibly', () => {
    const telemetry = {
      source: 'live',
      hardware_condition: 'CRITICAL',
      hardware_reason: 'Vibration RMS 0.85g exceeded critical threshold.',
      sensor_health: { adxl345: true, ds18b20: true, ina219: true, a3144: true },
    };
    const deviceStatus = { connection_state: 'CONNECTED', device_id: 'ESP32-MOTOR-01' };

    render(<HardwareConditionCard telemetry={telemetry} deviceStatus={deviceStatus} />);
    expect(screen.getByText('CRITICAL CONDITION')).toBeInTheDocument();
    expect(screen.getByText('Vibration RMS 0.85g exceeded critical threshold.')).toBeInTheDocument();
  });

  it('renders SENSOR FAULT when hardware reports sensor error', () => {
    const telemetry = {
      source: 'live',
      hardware_condition: 'SENSOR FAULT',
      hardware_reason: 'One or more hardware sensors reporting error',
      sensor_health: { adxl345: false, ds18b20: true, ina219: true, a3144: true },
    };
    const deviceStatus = { connection_state: 'CONNECTED', device_id: 'ESP32-MOTOR-01' };

    render(<HardwareConditionCard telemetry={telemetry} deviceStatus={deviceStatus} />);
    expect(screen.getAllByText('SENSOR FAULT').length).toBeGreaterThan(0);
    expect(screen.getByText('One or more hardware sensors reporting error')).toBeInTheDocument();
  });

  it('renders MOTOR OFF when motor is stopped without false critical error', () => {
    const telemetry = {
      source: 'live',
      motor_running: false,
      hardware_condition: 'MOTOR OFF',
      hardware_reason: 'Motor is not running',
      sensor_health: { adxl345: true, ds18b20: true, ina219: true, a3144: true },
    };
    const deviceStatus = { connection_state: 'CONNECTED', device_id: 'ESP32-MOTOR-01' };

    render(<HardwareConditionCard telemetry={telemetry} deviceStatus={deviceStatus} />);
    expect(screen.getAllByText('MOTOR OFF').length).toBeGreaterThan(0);
    expect(screen.getByText('Motor is not running')).toBeInTheDocument();
  });

  it('renders OFFLINE and does not falsely claim LIVE HARDWARE when device is disconnected', () => {
    const telemetry = {
      source: 'live',
      hardware_condition: 'NORMAL',
      hardware_reason: 'All monitored parameters within hardware limits.',
    };
    const deviceStatus = { connection_state: 'OFFLINE', device_id: 'ESP32-MOTOR-01' };

    render(<HardwareConditionCard telemetry={telemetry} deviceStatus={deviceStatus} />);
    expect(screen.queryByText('LIVE HARDWARE')).not.toBeInTheDocument();
    expect(screen.getAllByText('OFFLINE').length).toBeGreaterThan(0);
  });

  it('handles missing/null hardware condition safely with UNKNOWN / DATA UNAVAILABLE state (Requirement 14)', () => {
    const telemetry = {
      source: 'live',
      motor_running: true,
    };
    const deviceStatus = { connection_state: 'CONNECTED', device_id: 'ESP32-MOTOR-01' };

    render(<HardwareConditionCard telemetry={telemetry} deviceStatus={deviceStatus} />);
    expect(screen.getByText('HARDWARE CONDITION — ESP32')).toBeInTheDocument();
    expect(screen.getAllByText('UNKNOWN / DATA UNAVAILABLE').length).toBeGreaterThan(0);
  });

  it('Requirement 21 Regression Test: renders WARNING when hardware_condition is WARNING', () => {
    const telemetry = {
      source: 'live',
      hardware_condition: 'WARNING',
      hardware_reason: 'Temperature rise 18% above baseline.',
      motor_running: true,
      device_id: 'ESP32-MOTOR-01',
    };
    const deviceStatus = { connection_state: 'CONNECTED', device_id: 'ESP32-MOTOR-01' };

    render(<HardwareConditionCard telemetry={telemetry} deviceStatus={deviceStatus} />);
    expect(screen.getByText('HARDWARE CONDITION — ESP32')).toBeInTheDocument();
    expect(screen.getByText('WARNING CONDITION')).toBeInTheDocument();
    expect(screen.getByText('Temperature rise 18% above baseline.')).toBeInTheDocument();
  });
});

