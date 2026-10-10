import React, { useState, useEffect, useCallback, useRef } from 'react';
import Header from './components/Header';
import ConnectionStatus from './components/ConnectionStatus';
import MotorStatusCard from './components/MotorStatusCard';
import HardwareConditionCard from './components/HardwareConditionCard';
import HealthScore from './components/HealthScore';
import SensorGrid from './components/SensorGrid';
import ChartPanel from './charts/ChartPanel';
import HealthAnalysis from './components/HealthAnalysis';
import AlertPanel from './components/AlertPanel';
import BaselinePanel from './components/BaselinePanel';
import DeviceInfo from './components/DeviceInfo';
import { ErrorBoundary, LoadingState, EmptyState } from './components/EmptyState';
import api from './services/api';
import wsService from './services/websocket';
import {
  normalizeTelemetry,
  normalizeHealth,
  normalizeBaseline,
  normalizeDeviceStatus,
} from './utils/normalizers';
import { AlertCircle, RefreshCw } from 'lucide-react';

const MAX_CHART_SAMPLES = 80;

export default function App() {
  const [telemetry, setTelemetry] = useState(null);
  const [deviceStatus, setDeviceStatus] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [health, setHealth] = useState(null);
  const [chartData, setChartData] = useState([]);
  const [activeRange, setActiveRange] = useState(null); // null = live stream
  const [wsConnected, setWsConnected] = useState(false);
  const [backendOnline, setBackendOnline] = useState(true);
  const [initialLoading, setInitialLoading] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);

  const activeRangeRef = useRef(activeRange);
  activeRangeRef.current = activeRange;

  // 1. Initial State Fetching from Backend REST Endpoints
  const loadInitialData = useCallback(async () => {
    try {
      setInitialLoading(true);
      setBackendOnline(true);

      const [statusRes, latestRes, baselineRes, healthRes] = await Promise.allSettled([
        api.getStatus(),
        api.getLatestSensors('live'),
        api.getBaseline(),
        api.getHealth(),
      ]);

      if (statusRes.status === 'fulfilled') {
        setDeviceStatus(normalizeDeviceStatus(statusRes.value.device));
      } else {
        setBackendOnline(false);
      }

      if (latestRes.status === 'fulfilled' && latestRes.value) {
        const norm = normalizeTelemetry(latestRes.value);
        setTelemetry(norm);
        setChartData([norm]);
      }

      if (baselineRes.status === 'fulfilled') {
        setBaseline(normalizeBaseline(baselineRes.value));
      }

      if (healthRes.status === 'fulfilled') {
        setHealth(normalizeHealth(healthRes.value));
      }
    } catch (err) {
      console.warn('Initial data load error:', err);
      setBackendOnline(false);
    } finally {
      setInitialLoading(false);
    }
  }, []);

  // 2. WebSocket Real-Time Event Subscriptions
  useEffect(() => {
    loadInitialData();
    wsService.connect();

    // WS Connection State
    const unsubWsStatus = wsService.subscribe('ws_status', (data) => {
      setWsConnected(Boolean(data.connected));
    });

    // Real-Time Telemetry Stream
    const unsubTelemetry = wsService.subscribe('telemetry', (raw) => {
      const norm = normalizeTelemetry(raw);
      // Ensure physical ESP32 live telemetry updates device status & condition state
      if (norm.source === 'live' && norm.device_id === 'ESP32-MOTOR-01') {
        setTelemetry(norm);
        setDeviceStatus((prev) =>
          normalizeDeviceStatus({
            ...(prev || {}),
            device_id: norm.device_id,
            firmware: norm.firmware || prev?.firmware || '2.0.0',
            connection_state: 'CONNECTED',
            last_seen: Date.now() / 1000,
          })
        );
      } else if (!telemetry) {
        setTelemetry(norm);
      }

      // Append to live rolling chart buffer if in live mode
      if (activeRangeRef.current === null) {
        setChartData((prev) => {
          const next = [...prev, norm];
          if (next.length > MAX_CHART_SAMPLES) {
            return next.slice(next.length - MAX_CHART_SAMPLES);
          }
          return next;
        });
      }
    });

    // Connection State Transitions
    const unsubConnection = wsService.subscribe('connection', (data) => {
      setDeviceStatus((prev) =>
        normalizeDeviceStatus({
          ...(prev || {}),
          device_id: data.device_id,
          connection_state: data.status,
          last_seen: data.last_seen,
        })
      );
    });

    // Health Score & Alert Updates
    const unsubHealth = wsService.subscribe('health', (raw) => {
      setHealth(normalizeHealth(raw));
    });

    // Baseline Calibration State Transitions
    const unsubBaseline = wsService.subscribe('baseline', (raw) => {
      setBaseline(normalizeBaseline(raw));
    });

    return () => {
      unsubWsStatus();
      unsubTelemetry();
      unsubConnection();
      unsubHealth();
      unsubBaseline();
      wsService.disconnect();
    };
  }, [loadInitialData]);

  // 3. Historical Data Query Handler
  const handleSelectRange = async (minutes) => {
    setActiveRange(minutes);
    setHistoryError(false);

    if (minutes === null) {
      // Revert to live stream
      return;
    }

    try {
      setHistoryLoading(true);
      const records = await api.getHistory(minutes);
      const normalizedHistory = (records || []).map((r) => normalizeTelemetry(r));
      setChartData(normalizedHistory);
    } catch (err) {
      console.error('Failed to fetch history range:', err);
      setHistoryError(true);
    } finally {
      setHistoryLoading(false);
    }
  };

  // 4. Baseline Action Handlers
  const handleStartBaseline = async () => {
    await api.startBaseline();
  };

  const handleCancelBaseline = async () => {
    await api.cancelBaseline();
  };

  const handleResetBaseline = async () => {
    await api.resetBaseline();
  };

  const isDeviceConnected = deviceStatus?.connection_state === 'CONNECTED';

  if (!backendOnline) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <Header deviceStatus={deviceStatus} wsConnected={false} telemetry={null} />
        <div style={{ margin: 'auto', padding: '24px', maxWidth: '480px', textAlign: 'center' }}>
          <AlertCircle size={48} color="#ef4444" style={{ marginBottom: '16px' }} />
          <h2 style={{ fontSize: '20px', fontWeight: '700', color: 'var(--text-primary)', marginBottom: '8px' }}>
            BACKEND OFFLINE
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: '1.6', marginBottom: '24px' }}>
            Unable to connect to the FastAPI monitoring server at <code>http://localhost:8000</code>. Verify that the backend is running.
          </p>
          <button
            onClick={loadInitialData}
            style={{
              padding: '10px 20px',
              backgroundColor: 'var(--accent-cyan)',
              color: '#000',
              border: 'none',
              borderRadius: '8px',
              fontWeight: '700',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <RefreshCw size={16} /> Reconnect to Backend
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <Header
        deviceStatus={deviceStatus}
        wsConnected={wsConnected}
        telemetry={telemetry}
      />

      <main className="dashboard-container">
        {initialLoading ? (
          <LoadingState message="Connecting to industrial telemetry pipeline..." />
        ) : (
          <>
            {/* Top Row: Link Info + Operational State + Hardware Condition + Health Score */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
              gap: '16px',
            }}>
              <ErrorBoundary>
                <ConnectionStatus deviceStatus={deviceStatus} telemetry={telemetry} />
              </ErrorBoundary>

              <ErrorBoundary>
                <MotorStatusCard
                  telemetry={telemetry}
                  deviceStatus={deviceStatus}
                  health={health}
                />
              </ErrorBoundary>

              <ErrorBoundary>
                <HardwareConditionCard
                  telemetry={telemetry}
                  deviceStatus={deviceStatus}
                />
              </ErrorBoundary>

              <ErrorBoundary>
                <HealthScore health={health} deviceStatus={deviceStatus} />
              </ErrorBoundary>
            </div>

            {/* Sensor Measurements Grid (6 Core Parameters) */}
            <ErrorBoundary>
              <SensorGrid
                telemetry={telemetry}
                baseline={baseline}
                health={health}
                deviceStatus={deviceStatus}
              />
            </ErrorBoundary>

            {/* Live & Historical Trend Charts (7 Independent Charts) */}
            <ErrorBoundary>
              <ChartPanel
                chartData={chartData}
                activeRange={activeRange}
                onSelectRange={handleSelectRange}
                baseline={baseline}
                isLoadingHistory={historyLoading}
                historyError={historyError}
              />
            </ErrorBoundary>

            {/* Health Analysis & Alerts Section */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
              gap: '16px',
            }}>
              <ErrorBoundary>
                <HealthAnalysis health={health} deviceStatus={deviceStatus} />
              </ErrorBoundary>

              <ErrorBoundary>
                <AlertPanel alerts={health?.alerts} isConnected={isDeviceConnected} />
              </ErrorBoundary>
            </div>

            {/* Baseline Calibration Control & Stored References */}
            <ErrorBoundary>
              <BaselinePanel
                baseline={baseline}
                onStartBaseline={handleStartBaseline}
                onCancelBaseline={handleCancelBaseline}
                onResetBaseline={handleResetBaseline}
                isDeviceConnected={isDeviceConnected}
              />
            </ErrorBoundary>

            {/* Hardware Node Metadata & Attached Sensor Health */}
            <ErrorBoundary>
              <DeviceInfo deviceStatus={deviceStatus} telemetry={telemetry} />
            </ErrorBoundary>
          </>
        )}
      </main>
    </div>
  );
}
