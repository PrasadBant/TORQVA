import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Gauge, ListChecks, Microscope, ShieldCheck, LogOut, FlaskConical, Beaker, LineChart, TestTube2, Settings, WifiOff, GraduationCap, Usb, SlidersHorizontal, Sun, Moon } from 'lucide-react';
import { api, setToken, getToken, ApiError } from './api.js';
import { SimulationBanner, Pill } from './components.jsx';
import { Evaluation } from './views.jsx';
import { OverviewPage, LivePage, DiagnosticsPage, PredictionsPage, TestsPage, InterventionsPage, RecoveryPage, LearningPage, DevicesPage, PageHead } from './pages.jsx';
import { useDeviceStream, DevicePage, MotorControlPage, DeviceCard, DeviceLive } from './device.jsx';
import Lab from './lab.jsx';
import Attestation from './attestation.jsx';
import { ModeSwitch, PhysicalBanner, PhysicalOverview, PhysicalLive, PhysicalAiPage, PhysicalSafetyPage } from './physical.jsx';
import './torqva.css';
import './theme.css';

const NAV_GROUPS = [
  {
    heading: 'Dashboard',
    items: [
      ['overview', 'Overview', Gauge, ''],
      ['live', 'Live Monitor', Activity, ''],
    ],
  },
  {
    heading: 'Diagnostics',
    items: [
      ['diagnostics', 'AI Diagnostics', Microscope, 'C1'],
      ['tests', 'Diagnostic Tests', TestTube2, 'C4'],
    ],
  },
  {
    heading: 'Predictions',
    items: [
      ['predictions', 'Predictions', LineChart, 'C2'],
      ['interventions', 'Interventions', ListChecks, 'C3'],
    ],
  },
  {
    heading: 'Recovery and History',
    items: [
      ['recovery', 'Recovery', ShieldCheck, 'C5'],
      ['learning', 'Learning', GraduationCap, 'C6'],
      ['evaluation', 'Evaluation', FlaskConical, ''],
    ],
  },
  {
    heading: 'Device Setup and Commissioning',
    items: [
      ['device', 'Device', Usb, 'USB'],
      ['control', 'Motor Control', SlidersHorizontal, ''],
      ['lab', 'Lab', Beaker, ''],
      ['devices', 'Devices & Settings', Settings, ''],
    ],
  },
];

const NAV = NAV_GROUPS.flatMap((g) => g.items);

// Development convenience only: `npm run dev` starts the backend with a matching local token. Never present in a production build.
const DEV_TOKEN = (import.meta.env && import.meta.env.DEV && import.meta.env.VITE_TORQVA_DEV_TOKEN) || '';
const canStart = (role) => role === 'operator' || role === 'admin';

const THEME_KEY = 'torqva.theme';
const readTheme = () => {
  try {
    return window.localStorage.getItem(THEME_KEY) || 'dark';
  } catch {
    return 'dark';
  }
};
const storeTheme = (t) => {
  try { window.localStorage.setItem(THEME_KEY, t); } catch {}
};

// The application is physical-device-first. Simulation is a separate mode that only an explicit operator choice enters (remembered per browser, never set automatically).
const MODE_KEY = 'torqva.mode';
const readMode = () => {
  try {
    const m = window.localStorage.getItem(MODE_KEY);
    return m || 'PHYSICAL';
  } catch {
    return 'PHYSICAL';
  }
};
const storeMode = (m) => { try { window.localStorage.setItem(MODE_KEY, m); } catch { /* storage may be unavailable: the choice then lasts for this page load only */ } };

function Login({ onLogin, error }) {
  const [t, setT] = useState('');
  return (
    <main className="tq-login">
      <SimulationBanner />
      <form onSubmit={(e) => { e.preventDefault(); onLogin(t.trim()); }} aria-label="Sign in">
        <h1>TORQVA</h1>
        <p className="tq-muted">Enter an access token issued by an administrator. Tokens are kept for this browser tab only.</p>
        <label>Access token<input type="password" autoComplete="off" value={t} onChange={(e) => setT(e.target.value)} /></label>
        {error && <p className="tq-error" role="alert">{error}</p>}
        <button className="tq-btn tq-primary" type="submit" disabled={!t.trim()}>Sign in</button>
      </form>
    </main>
  );
}

export default function TorqvaApp({ pollMs = 1500, stepSeconds = 5, wsFactory }) {
  const [user, setUser] = useState(null);
  const [loginError, setLoginError] = useState('');
  const [view, setView] = useState('overview');
  const [appMode, setAppMode] = useState(readMode);
  const [theme, setTheme] = useState(readTheme);
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    storeTheme(next);
  };
  const [d, setD] = useState({});
  const device = useDeviceStream(!!user, wsFactory);
  const isPhys = (device.snap?.origin === 'physical_device' && device.snap?.handshake === true) || d.status?.mode === 'PHYSICAL' || d.status?.provenance === 'MEASURED' || d.telemetry?.provenance === 'MEASURED';
  const physicalMode = appMode === 'PHYSICAL';
  const changeMode = (m) => { setAppMode(m); storeMode(m); setRunning(false); };
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastOk, setLastOk] = useState(null);
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [evalState, setEvalState] = useState({ run: null, error: null });
  const [c2c4, setC2c4] = useState({ data: null, error: null });
  const [audit, setAudit] = useState({ rows: [], error: null });
  const alive = useRef(true);
  const autoStarted = useRef(false);
  const devLogin = useRef(false);        // true only when the development token signed us in (never in production builds)

  const onLogin = useCallback(async (token) => {
    setToken(token);
    try { setUser(await api.me()); setLoginError(''); }
    catch (e) {
      setToken('');
      setLoginError(e instanceof ApiError && e.status === 503 ? 'Authentication is not configured on the server; the TORQVA API is disabled.'
        : e instanceof ApiError && e.status === 401 ? 'That token was not accepted.' : `Could not reach the server: ${e.message}`);
    }
  }, []);

  useEffect(() => { alive.current = true; const t = getToken() || DEV_TOKEN; if (t) { if (!getToken()) devLogin.current = true; onLogin(t); } return () => { alive.current = false; }; }, [onLogin]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const reqSeq = useRef(0);               // responses can arrive out of order: only the newest request may update the screen
  const applied = useRef(0);
  const ticking = useRef(false);          // never start a second simulation step while the previous one is still running
  const refresh = useCallback(async () => {
    const mine = ++reqSeq.current;
    try {
      const [status, telemetry, incidents, decisions, predictions, commands, outcomes, cases, log, predictionChecks] = await Promise.all([
        api.status(), api.telemetry(300), api.incidents(), api.decisions(), api.predictions(), api.commands(), api.outcomes(), api.cases(), api.log(),
        api.predictionChecks().catch(() => [])]);       // a secondary panel must never break the polling loop (older backends lack the route)
      if (alive.current && mine > applied.current) { applied.current = mine; setD({ status, telemetry, incidents, decisions, predictions, commands, outcomes, cases, log, predictionChecks }); setError(null); setLastOk(Date.now()); setOffline(false); }
    } catch (e) {
      if (!alive.current || mine < applied.current) return;
      if (e instanceof ApiError && e.status === 401) { setToken(''); setUser(null); } else { setError(e); if (!(e instanceof ApiError)) setOffline(true); }
    }
  }, []);

  // Development first load: start a healthy run so AI models and telemetry are always active and live.
  useEffect(() => {
    if (!user || physicalMode || autoStarted.current || !d.status || !devLogin.current) return;
    autoStarted.current = true;
    const fresh = d.status.t === undefined || d.status.t === null || (d.status.t === 0 && !(d.telemetry?.samples || []).length);
    if (fresh && canStart(user.role)) {
      api.start({ fault: null, severity: 0.5, seed: 1, clears_below_rpm: null, require_human_approval: false }).then(() => { setRunning(true); refresh(); }).catch(() => {});
    }
  }, [user, physicalMode, d.status, d.telemetry, refresh]);

  useEffect(() => {
    if (!user) return undefined;
    const isConn = device.snap?.connection === 'CONNECTED';
    if (physicalMode && !isConn && (view === 'overview' || view === 'live' || view === 'device' || view === 'control' || view === 'lab')) {
      return undefined;
    }
    refresh();
    const id = setInterval(async () => {
      if (ticking.current) return;
      ticking.current = true;
      try {
        if (!physicalMode && running) {
          try { await api.step(stepSeconds); } catch (e) { setError(e); setRunning(false); }
        }
        await refresh();
      } finally { ticking.current = false; }
    }, pollMs);
    return () => clearInterval(id);
  }, [user, running, refresh, pollMs, stepSeconds, physicalMode, view, device.snap?.connection]);

  useEffect(() => {
    if (!user) return;
    if (view === 'evaluation' || view === 'tests') {
      api.evaluation().then((r) => setEvalState({ run: r, error: null })).catch((e) => setEvalState({ run: null, error: e }));
      api.evaluationC2C4().then((r) => setC2c4({ data: r, error: null })).catch((e) => setC2c4({ data: null, error: e }));
    }
    if (view === 'devices' && user.role === 'admin') api.audit().then((rows) => setAudit({ rows, error: null })).catch((e) => setAudit({ rows: [], error: e }));
  }, [view, user]);

  const act = (fn) => async (...a) => {
    setBusy(true);
    try { await fn(...a); setError(null); } catch (e) { setError(e); } finally { setBusy(false); refresh(); }
  };
  const actions = {
    start: act(async (body) => { await api.start(body); setRunning(false); }),
    approve: act(() => api.approve()), reject: act(() => api.reject()), stop: act(() => api.stop()),
  };

  if (!user) return <Login onLogin={onLogin} error={loginError} />;
  const mode = physicalMode ? 'PHYSICAL' : (d.status?.mode || 'SIMULATION');
  const dev = d.status?.device;
  const stale = offline || (lastOk !== null && now - lastOk > Math.max(8000, pollMs * 4));
  const ctx = { d, role: user.role, user, actions, running, setRunning, busy, error, stale, go: setView, ctl: canStart(user.role), device, physicalMode, isPhys, deviceCard: <DeviceCard stream={device} go={setView} />, deviceLive: <DeviceLive stream={device} /> };
  const simPages = {
    overview: <OverviewPage {...ctx} />, live: <LivePage {...ctx} />, diagnostics: <DiagnosticsPage {...ctx} />,
    predictions: <PredictionsPage {...ctx} />, tests: <TestsPage {...ctx} c2c4={c2c4.data} />, interventions: <InterventionsPage {...ctx} />,
    recovery: <RecoveryPage {...ctx} />, learning: <LearningPage {...ctx}><Attestation role={user.role} /></LearningPage>,
    evaluation: (<><PageHead title="Evaluation and Research" sub={physicalMode ? "Live physical hardware evaluation benchmarks and model verification metrics." : "Simulation evaluation artifacts, baselines versus candidates, provenance and known limitations."} />
      <Evaluation loading={!evalState.run && !evalState.error} evalRun={evalState.run} evalError={evalState.error} c2c4={c2c4.data} c2c4Error={c2c4.error} isPhys={physicalMode} /></>),
    device: <DevicePage stream={device} role={user.role} />, control: <MotorControlPage stream={device} role={user.role} />,
    lab: <Lab role={user.role} isPhys={physicalMode} />, devices: <DevicesPage {...ctx} rows={audit.rows} auditError={audit.error} />,
  };
  const phys = (layer, fallback) => {
    const l = device.snap?.analysis?.layers?.[layer];
    const isReady = l && ['ACTIVE', 'AVAILABLE', 'READY', 'VERIFIED'].includes(l.status);
    if (l && !isReady) {
      return <PhysicalAiPage stream={device} layer={layer} go={setView} />;
    }
    return fallback;
  };
  const physPages = {
    overview: <PhysicalOverview stream={device} go={setView} role={user.role} />,
    live: <PhysicalLive stream={device} />,
    diagnostics: phys('C1', <DiagnosticsPage {...ctx} />),
    predictions: phys('C2', <PredictionsPage {...ctx} />),
    tests: phys('C4', <TestsPage {...ctx} c2c4={c2c4.data} />),
    interventions: phys('C3', <InterventionsPage {...ctx} />),
    recovery: phys('C5', <RecoveryPage {...ctx} />),
    learning: phys('C6', <LearningPage {...ctx}><Attestation role={user.role} /></LearningPage>),
    evaluation: (<><div className="tq-callout info" role="note" data-testid="eval-sim-note"><strong>SIMULATION EVIDENCE</strong> These are results from the software simulator. They say nothing about this physical device.</div>{simPages.evaluation}</>),
    device: simPages.device,
    control: <PhysicalSafetyPage stream={device} role={user.role} />,
    lab: (<><PageHead title="Lab" sub="The lab runs the software simulator." /><div className="tq-callout warn" data-testid="lab-sim-note"><strong>SIMULATION ONLY</strong> The lab uses simulated data. Choose Simulation mode (demo) with the mode switch to use it; it is not available in physical mode.</div></>),
    devices: simPages.devices,
  };
  const pages = physicalMode ? physPages : simPages;
  return (
    <div className={`tq-shell ${theme === 'light' ? 'tq-theme-light' : 'tq-theme-dark'}`}>
      {physicalMode ? <PhysicalBanner snap={device.snap} /> : <SimulationBanner mode={mode} physical={device.snap?.origin === 'physical_device' && device.snap?.handshake === true} />}
      {stale && !physicalMode && (
        <div className="tq-conn" role="alert" data-testid="conn-warning"><WifiOff size={16} aria-hidden="true" /><strong>Backend unreachable.</strong>
          <span>Values shown are STALE{lastOk ? ` (last updated ${Math.round((now - lastOk) / 1000)} s ago)` : ''} and are not live. Start the backend and this page recovers automatically.</span></div>)}
      <header className="tq-top">
        <strong className="tq-wordmark">TORQVA</strong>
        <span className="tq-conn-indicator" title={physicalMode ? 'Physical Hardware Mode' : 'Software Simulator Mode'}>
          <span className={`tq-conn-dot ${physicalMode ? (device.snap?.telemetry_fresh ? 'live' : 'warn') : 'sim'}`} />
          {physicalMode ? (device.snap?.connection === 'CONNECTED' ? `${device.snap.port || 'COM7'} Online` : 'Hardware Disconnected') : 'Environment: software simulator (no hardware)'}
        </span>
        {!physicalMode && <Pill tone={dev?.estop ? 'stop' : 'ok'}>{dev?.estop ? 'DEVICE E-STOP' : 'Device OK'}</Pill>}
        <span className="tq-grow" />
        <ModeSwitch mode={appMode} onChange={changeMode} />
        <button
          type="button"
          className="tq-btn tq-ghost tq-theme-btn"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Cockpit Theme'}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
        </button>
        <span className="tq-user-badge">{user.user} · {user.role}</span>
        <button className="tq-btn tq-ghost" onClick={() => { setToken(''); setUser(null); setRunning(false); }} aria-label="Sign out"><LogOut size={15} aria-hidden="true" /></button>
      </header>
      <div className="tq-body">
        <nav aria-label="TORQVA sections">
          <div className="tq-brand">TORQVA<small>Motor Intelligence</small></div>
          <div className="tq-nav-groups">
            {NAV_GROUPS.map((grp) => (
              <div key={grp.heading} className="tq-nav-group">
                <div className="tq-nav-heading">{grp.heading}</div>
                <ul>
                  {grp.items.map(([k, label0, Icon, tag]) => {
                    const label = physicalMode && k === 'control' ? 'Safety & Commissioning' : label0;
                    return (
                      <li key={k}>
                        <button
                          className={`tq-nav ${view === k ? 'active' : ''}`}
                          aria-current={view === k ? 'page' : undefined}
                          onClick={() => setView(k)}
                        >
                          <Icon size={15} aria-hidden="true" />
                          <span className="tq-nav-label">{label}</span>
                          {tag && <span className="tq-tag">{tag}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        <main><h1 className="tq-sr">{NAV.find((n) => n[0] === view)[1]}</h1>{pages[view]}</main>
      </div>
    </div>
  );
}
