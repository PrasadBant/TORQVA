/**
 * Telemetry and Domain Object Normalization Layer.
 * Guarantees consistent schema structures across frontend components.
 * Supports both ESP32 TCP schema (vibration, status, motor, reason, condition)
 * and internal domain schema (vibration_rms, hardware_condition, motor_running).
 */

export function normalizeTelemetry(raw) {
  if (!raw) return null;

  let condition = raw.status || raw.hardware_condition || (typeof raw.condition === 'string' ? raw.condition : null);
  let reason = raw.reason || raw.hardware_reason;

  const motorRunning = typeof raw.motor_running === 'boolean'
    ? raw.motor_running
    : (raw.motor ? (raw.motor.toUpperCase() === 'RUNNING' || raw.motor.toUpperCase() === 'ON') : (raw.rpm > 50 || Math.abs(raw.current) > 0.3));

  if (!condition) {
    if (typeof raw.condition === 'number') {
      condition = motorRunning ? 'NORMAL' : 'MOTOR OFF';
    } else {
      console.warn('[Telemetry] Missing hardware_condition/status field in telemetry packet:', raw);
      condition = 'UNKNOWN / DATA UNAVAILABLE';
      reason = reason || 'Hardware condition not reported by device';
    }
  }

  const temp = typeof raw.temperature === 'number' ? raw.temperature : 0.0;
  const volt = typeof raw.voltage === 'number' ? raw.voltage : 0.0;
  const curr = typeof raw.current === 'number' ? raw.current : 0.0;
  const pwr = typeof raw.power === 'number' ? raw.power : +(volt * curr).toFixed(2);
  const rpm = typeof raw.rpm === 'number' ? raw.rpm : 0.0;
  const vibRms = typeof raw.vibration_rms === 'number' ? raw.vibration_rms : (typeof raw.vibration === 'number' ? raw.vibration : 0.0);
  const condVal = typeof raw.condition === 'number' ? raw.condition : (String(condition).toUpperCase() === 'CRITICAL' ? 50.0 : 100.0);

  return {
    device_id: raw.device_id || 'ESP32-MOTOR-01',
    firmware: raw.firmware || '1.0.0',
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now() / 1000,
    server_received_at: raw.server_received_at || null,
    motor_running: motorRunning,
    temperature: temp,
    vibration_x: typeof raw.vibration_x === 'number' ? raw.vibration_x : 0.0,
    vibration_y: typeof raw.vibration_y === 'number' ? raw.vibration_y : 0.0,
    vibration_z: typeof raw.vibration_z === 'number' ? raw.vibration_z : 0.0,
    vibration_rms: vibRms,
    vibration: vibRms,
    rpm: rpm,
    voltage: volt,
    current: curr,
    power: pwr,
    sensor_health: {
      adxl345: raw.sensor_health?.adxl345 ?? true,
      ds18b20: raw.sensor_health?.ds18b20 ?? true,
      ina219: raw.sensor_health?.ina219 ?? true,
      a3144: raw.sensor_health?.a3144 ?? true,
    },
    source: raw.source || 'live',
    hardware_condition: String(condition).toUpperCase(),
    status: String(condition).toUpperCase(),
    motor: raw.motor || (motorRunning ? 'RUNNING' : 'OFF'),
    condition: condVal,
    hardware_reason: reason || '',
    reason: reason || '',
    hardware_baseline_stored: raw.hardware_baseline_stored ?? true,
  };
}

export function normalizeHealth(raw) {
  if (!raw) {
    return {
      score: 100.0,
      status: 'OFFLINE',
      factors: {
        temperature: 100.0,
        vibration: 100.0,
        rpm: 100.0,
        current: 100.0,
        power: 100.0,
      },
      alerts: [],
      diagnostic_explanation: 'System offline. Awaiting live telemetry.',
    };
  }
  return {
    score: typeof raw.score === 'number' ? Math.max(0, Math.min(100, Math.round(raw.score))) : 100,
    status: raw.status || 'HEALTHY',
    factors: {
      temperature: raw.factors?.temperature ?? 100.0,
      vibration: raw.factors?.vibration ?? 100.0,
      rpm: raw.factors?.rpm ?? 100.0,
      current: raw.factors?.current ?? 100.0,
      power: raw.factors?.power ?? 100.0,
    },
    alerts: Array.isArray(raw.alerts) ? raw.alerts : [],
    diagnostic_explanation: raw.diagnostic_explanation || 'All monitored parameters within expected limits.',
  };
}

export function normalizeBaseline(raw) {
  if (!raw) {
    return {
      status: 'NOT_CONFIGURED',
      temperature: null,
      vibration_rms: null,
      voltage: null,
      current: null,
      power: null,
      rpm: null,
      saved_at: null,
      samples: 0,
      duration_seconds: 0.0,
    };
  }
  return {
    status: raw.status || 'NOT_CONFIGURED',
    temperature: typeof raw.temperature === 'number' ? raw.temperature : null,
    vibration_rms: typeof raw.vibration_rms === 'number' ? raw.vibration_rms : null,
    voltage: typeof raw.voltage === 'number' ? raw.voltage : null,
    current: typeof raw.current === 'number' ? raw.current : null,
    power: typeof raw.power === 'number' ? raw.power : null,
    rpm: typeof raw.rpm === 'number' ? raw.rpm : null,
    saved_at: raw.saved_at || null,
    samples: raw.samples || 0,
    duration_seconds: raw.duration_seconds || 30.0,
  };
}

export function normalizeDeviceStatus(raw) {
  if (!raw) {
    return {
      device_id: 'ESP32-MOTOR-01',
      firmware: '1.0.0',
      ip_address: null,
      first_seen: null,
      last_seen: null,
      connection_state: 'OFFLINE',
      sensor_health: { adxl345: true, ds18b20: true, ina219: true, a3144: true },
      uptime_seconds: 0.0,
    };
  }
  return {
    device_id: raw.device_id || 'ESP32-MOTOR-01',
    firmware: raw.firmware || '1.0.0',
    ip_address: raw.ip_address || null,
    first_seen: raw.first_seen || null,
    last_seen: raw.last_seen || null,
    connection_state: raw.connection_state || 'OFFLINE',
    sensor_health: {
      adxl345: raw.sensor_health?.adxl345 ?? true,
      ds18b20: raw.sensor_health?.ds18b20 ?? true,
      ina219: raw.sensor_health?.ina219 ?? true,
      a3144: raw.sensor_health?.a3144 ?? true,
    },
    uptime_seconds: raw.uptime_seconds || 0.0,
  };
}
