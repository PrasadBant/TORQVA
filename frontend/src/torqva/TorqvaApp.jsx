import React, { Suspense, lazy, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Activity, Box, Gauge, ListChecks, Microscope, Workflow, ShieldCheck, LogOut, FlaskConical, Beaker, LineChart, TestTube2, Settings, WifiOff, GraduationCap, Usb, SlidersHorizontal, Sun, Moon, ClipboardCheck, Menu, KeyRound, PanelLeftClose, PanelLeftOpen, Cpu, Brain, ChevronDown, ShieldAlert, Server } from 'lucide-react';
import { api, setToken, getToken, ApiError } from './api.js';
import { SimulationBanner, Pill, Logo, NavContext, PageHead, Empty, AlertPanel, Tabs, TabPanel } from './shared/components.jsx';
import { prefetchCharts } from './shared/lazyCharts.jsx';
import { Evaluation } from './simulation/evaluation.jsx';
import { SimOverview, simHealth } from './simulation/overview.jsx';
import { LivePage, DevicesPage, isPhysOf } from './simulation/pages.jsx';
import { RecoveryPage, LearningPage } from './simulation/assurance.jsx';
import { JourneyBar } from './simulation/journey.jsx';
import { useDeviceStream, DevicePage, DeviceCard, DeviceLive } from './physical/device.jsx';
import Lab from './simulation/lab.jsx';
import Attestation from './simulation/attestation.jsx';
import { ModeSwitch, PhysicalBanner, PhysicalOverview, PhysicalLive, PhysicalAiPage, PhysicalSafetyPage, physHealth } from './physical/physical.jsx';
import { ScenarioPage } from './simulation/scenario.jsx';
import { AlertsMenu, deviceAlerts, simAlerts } from './shared/alerts.jsx';
import './torqva.css';
import './styles/system.css';
import './styles/monitoring.css';
import './styles/analysis.css';
import './styles/assurance.css';
import './styles/twin-sim.css';

// The analyst's path through the product, top to bottom: watch the motor, diagnose and decide, verify and learn, then the engineering tools.
// Labels are the product names only; internal layer identifiers never appear in the interface.
const NAV_GROUPS = [
  { heading: 'Monitor', items: [
    ['overview', 'Overview', Gauge],
    ['live', 'Live Monitor', Activity],
    ['twin', 'Digital Twin', Box],
  ] },
  { heading: 'Diagnose', items: [
    ['workflow', 'Diagnostic Workflow', Workflow],
    ['diagnostics', 'Anomaly Detection', Microscope],
    ['predictions', 'Failure Prediction', LineChart],
    ['interventions', 'Action Recommendations', ListChecks],
    ['tests', 'Diagnostic Investigation', TestTube2],
  ] },
  { heading: 'Intelligence', items: [
    ['recovery', 'Recovery Verification', ShieldCheck],
    ['learning', 'Continuous Intelligence', Brain],
    ['evaluation', 'Performance Evaluation', FlaskConical],
  ] },
  { heading: 'Engineering', items: [
    ['scenario', 'Scenario Studio', SlidersHorizontal],
    ['lab', 'Lab', Beaker],
  ] },
  { heading: 'Device & Safety', items: [
    ['device', 'Device & Safety', Cpu],
  ] },
];
// Former page ids that are now sections of Device & Safety: links and stored selections keep working and open the right section.
const ALIASES = { control: ['device', 'safety'], devices: ['device', 'system'], connection: ['device', 'connection'] };
const GROUPS_KEY = 'torqva.navgroups';
const readFolded = () => { try { return JSON.parse(window.localStorage.getItem(GROUPS_KEY) || '[]'); } catch { return []; } };

// The Digital Twin (drawing, workspace and mappings) is fetched when first opened, so it does not delay sign-in or the dashboards.
const SimTwinPage = lazy(() => import('./simulation/twin.jsx').then((m) => ({ default: m.SimTwinPage })));
const PhysTwinPage = lazy(() => import('./physical/twin.jsx').then((m) => ({ default: m.PhysTwinPage })));
const twinFallback = <Empty loading>Loading the Digital Twin…</Empty>;
// The analyst workspaces (C1, C4, C2, C3 in simulation mode) are fetched when first opened, like the twin.
const SimDiagnosticsPage = lazy(() => import('./simulation/diagnose.jsx').then((m) => ({ default: m.SimDiagnosticsPage })));
const SimTestsPage = lazy(() => import('./simulation/tests.jsx').then((m) => ({ default: m.SimTestsPage })));
const SimPredictionsPage = lazy(() => import('./simulation/predict.jsx').then((m) => ({ default: m.SimPredictionsPage })));
const SimInterventionsPage = lazy(() => import('./simulation/intervene.jsx').then((m) => ({ default: m.SimInterventionsPage })));
// The unified workflow: one component for both modes (the backend's mode-specific adapter decides what can run).
const WorkflowPage = lazy(() => import('./workflow/workflow.jsx').then((m) => ({ default: m.WorkflowPage })));
const pageFallback = <Empty loading>Loading…</Empty>;

const NAV = NAV_GROUPS.flatMap((g) => g.items);
// Simulation pages that show the investigation progress bar (Monitor → Investigate → Understand → Act → Verify).
const JOURNEY_VIEWS = new Set(['live', 'diagnostics', 'tests', 'predictions', 'interventions', 'recovery']);

// True while the viewport uses the off-canvas navigation drawer (matches the CSS breakpoint).
function useCompact(query = '(max-width: 860px)') {
  const get = () => { try { return !!window.matchMedia?.(query).matches; } catch { return false; } };
  const [on, setOn] = useState(get);
  useEffect(() => {
    let mq; try { mq = window.matchMedia?.(query); } catch { mq = null; }
    if (!mq) return undefined;
    const f = () => setOn(mq.matches);
    mq.addEventListener ? mq.addEventListener('change', f) : mq.addListener(f);
    return () => (mq.removeEventListener ? mq.removeEventListener('change', f) : mq.removeListener(f));
  }, [query]);
  return on;
}
// Desktop sidebar collapsed to an icon rail (a per-browser convenience).
const NAV_KEY = 'torqva.nav';
const readCollapsed = () => { try { return window.localStorage.getItem(NAV_KEY) === 'collapsed'; } catch { return false; } };
const scrollTop = () => { try { if (!/jsdom/i.test(navigator.userAgent)) window.scrollTo({ top: 0 }); } catch { /* not supported */ } };

// Development convenience only: `npm run dev` starts the backend with a matching local token. Never present in a production build.
const DEV_TOKEN = (import.meta.env && import.meta.env.DEV && import.meta.env.VITE_TORQVA_DEV_TOKEN) || '';
const canStart = (role) => role === 'operator' || role === 'admin';

const THEME_KEY = 'torqva.theme';
const readTheme = () => {
  try {
    return window.localStorage.getItem(THEME_KEY) || 'light';
  } catch {
    return 'light';
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

const LOGIN_POINTS = [
  [Usb, 'Physical-device first', 'Live readings come from the connected board. A missing or invalid reading is shown as unavailable, never as zero.'],
  [ShieldCheck, 'Supervised motor commands', 'Motor commands go through the backend command path and the firmware on the board.'],
  [FlaskConical, 'Simulation kept separate', 'The research simulator is an explicit mode and is labelled on every screen.'],
];

function Login({ onLogin, error, theme }) {
  const [t, setT] = useState('');
  return (
    <main className={`tq-login tq-theme-${theme}`}>
      <SimulationBanner />
      <div className="tq-login-body">
        <section className="tq-login-hero" aria-label="About TORQVA">
          <div className="tq-brand"><Logo size={34} /><span className="tq-brand-name"><strong>TORQVA</strong><small>Motor intelligence</small></span></div>
          <div>
            <h2>Monitoring, diagnostics and motor control in one workspace.</h2>
            <p>Live telemetry from the ESP32-S3 rig, explainable fault analysis and the controls to act on it.</p>
            <ul className="tq-login-points">
              {LOGIN_POINTS.map(([I, h, x]) => <li key={h}><span aria-hidden="true"><I size={16} /></span><span><strong>{h}</strong>{x}</span></li>)}
            </ul>
          </div>
          <p className="tq-login-fine">Access is token based. Ask an administrator for a token with the role you need: viewer, operator or admin.</p>
        </section>
        <div className="tq-login-panel">
          <form onSubmit={(e) => { e.preventDefault(); onLogin(t.trim()); }} aria-label="Sign in">
            <h1>Sign in to TORQVA</h1>
            <p className="tq-muted">Enter an access token issued by an administrator. Tokens are kept for this browser tab only.</p>
            <label>Access token<input type="password" autoComplete="off" value={t} onChange={(e) => setT(e.target.value)} placeholder="Paste your token" /></label>
            {error && <p className="tq-error" role="alert">{error}</p>}
            <button className="tq-btn tq-primary" type="submit" disabled={!t.trim()}><KeyRound size={15} aria-hidden="true" />Sign in</button>
          </form>
        </div>
      </div>
    </main>
  );
}

// Whether the last good poll is older than `limitMs`. Computed during render, plus one timer that re-renders exactly when the data
// goes stale, so the app is not re-rendered every second just to watch the clock.
function useStale(lastOk, offline, limitMs) {
  const [, expire] = useReducer((n) => n + 1, 0);
  useEffect(() => {
    if (lastOk === null) return undefined;
    const id = setTimeout(expire, Math.max(0, lastOk + limitMs - Date.now()) + 1);
    return () => clearTimeout(id);
  }, [lastOk, limitMs]);
  return offline || (lastOk !== null && Date.now() - lastOk > limitMs);
}

// "N s ago": only this text ticks every second, and only while the stale warning is shown.
function SecondsAgo({ since }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  return Math.round((now - since) / 1000);
}

export default function TorqvaApp({ pollMs = 1500, stepSeconds = 5, wsFactory }) {
  const [user, setUser] = useState(null);
  const [loginError, setLoginError] = useState('');
  const [rawView, setView] = useState('overview');
  const [appMode, setAppMode] = useState(readMode);
  const [theme, setTheme] = useState(readTheme);
  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    storeTheme(next);
  };
  useEffect(() => { try { document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark'); } catch { /* no document */ } }, [theme]);
  const compact = useCompact();
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleCollapsed = () => setCollapsed((c) => { const n = !c; try { window.localStorage.setItem(NAV_KEY, n ? 'collapsed' : 'open'); } catch { /* storage unavailable */ } return n; });
  const navRef = useRef(null);
  const [devTab, setDevTab] = useState('system');
  const go = useCallback((k) => { const a = ALIASES[k]; if (a) setDevTab(a[1]); else if (k === 'device') setDevTab('system'); setView(a ? a[0] : k); setNavOpen(false); scrollTop(); }, []);
  const [folded, setFolded] = useState(readFolded);
  const toggleGroup = (h) => setFolded((f) => { const n = f.includes(h) ? f.filter((x) => x !== h) : [...f, h]; try { window.localStorage.setItem(GROUPS_KEY, JSON.stringify(n)); } catch { /* storage unavailable */ } return n; });
  useEffect(() => { if (!compact) setNavOpen(false); }, [compact]);
  useEffect(() => {
    if (!navOpen) return undefined;
    navRef.current?.querySelector('.tq-nav.active, .tq-nav')?.focus();
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);
  const [d, setD] = useState({});
  // A session the server rejects (HTTP 401) ends the sign-in and says why, so it is never mistaken for a connection problem.
  const authLost = useCallback(() => { setToken(''); setUser(null); setLoginError('The server no longer accepts this session (HTTP 401). Sign in again.'); }, []);
  const device = useDeviceStream(!!user, wsFactory, undefined, authLost);
  // Provenance of `d` (the /status, /telemetry ... records) comes only from what that data says about itself. A connected board does not make
  // simulator records measured; the board's own readings arrive separately through `device`.
  const isPhys = isPhysOf(d);
  const physicalMode = appMode === 'PHYSICAL';
  const view = ALIASES[rawView]?.[0] || rawView;
  // Safety & Commissioning is the physical device's interlock record, so that section exists only in physical mode.
  const deviceTab = !physicalMode && devTab === 'safety' ? 'system' : devTab;
  // Analyst workbench state (simulation): the selected action, the last test run and a test to pre-add. Never carried across modes or runs.
  const [wb, setWb] = useState({ selection: null, run: null, prefill: null, lastRequest: null });
  const changeMode = (m) => { setAppMode(m); storeMode(m); setRunning(false); setWb({ selection: null, run: null, prefill: null, lastRequest: null }); };
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastOk, setLastOk] = useState(null);
  const [offline, setOffline] = useState(false);
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
  useEffect(() => { if (user) prefetchCharts(); }, [user]);          // fetch the chart code in the background once signed in

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
      if (e instanceof ApiError && e.status === 401) authLost(); else { setError(e); if (!(e instanceof ApiError)) setOffline(true); }
    }
  }, [authLost]);

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
    if (physicalMode) { if (view === 'device') refresh(); return undefined; }        // physical mode never polls or steps the simulator
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
  }, [user, running, refresh, pollMs, stepSeconds, physicalMode, view]);

  useEffect(() => {
    if (!user) return;
    if (view === 'evaluation' || view === 'tests') {
      api.evaluation().then((r) => setEvalState({ run: r, error: null })).catch((e) => setEvalState({ run: null, error: e }));
      api.evaluationC2C4().then((r) => setC2c4({ data: r, error: null })).catch((e) => setC2c4({ data: null, error: e }));
    }
    if (view === 'device' && user.role === 'admin') api.audit().then((rows) => setAudit({ rows, error: null })).catch((e) => setAudit({ rows: [], error: e }));
  }, [view, user]);

  // Resolves true only when the backend accepted the request (so a caller can confirm a NEW run started), false when it refused.
  const act = (fn) => async (...a) => {
    setBusy(true);
    try { await fn(...a); setError(null); return true; } catch (e) { setError(e); return false; } finally { setBusy(false); refresh(); }
  };
  const actions = {
    start: act(async (body) => { await api.start(body); setRunning(false); setWb({ selection: null, run: null, prefill: null, lastRequest: null }); }),
    approve: act(() => api.approve()), reject: act(() => api.reject()), stop: act(() => api.stop()),
    step: act(() => api.step(stepSeconds)),           // one manual step while paused (the button is disabled while time advances on its own)
  };

  const stale = useStale(lastOk, offline, Math.max(8000, pollMs * 4));
  if (!user) return <Login onLogin={onLogin} error={loginError} theme={theme === 'light' ? 'light' : 'dark'} />;
  const mode = physicalMode ? 'PHYSICAL' : (d.status?.mode || 'SIMULATION');
  const ctx = { d, role: user.role, user, actions, running, setRunning, busy, error, stale, go, wb, setWb, ctl: canStart(user.role), device, physicalMode, isPhys, deviceCard: <DeviceCard stream={device} go={go} />, deviceLive: <DeviceLive stream={device} /> };
  // Evaluation is the same page in both modes (it only ever shows simulator evidence); physical mode adds a note saying so.
  const evaluationPage = (note) => (<><PageHead title="Performance Evaluation" sub="How detection, prediction and recovery verification performed against simple baselines." />{note}
    <Evaluation loading={!evalState.run && !evalState.error} evalRun={evalState.run} evalError={evalState.error} c2c4={c2c4.data} c2c4Error={c2c4.error} /></>);
  // Device & Safety: connection and readiness, the physical interlocks and commissioning record (physical mode only), and the device
  // inventory, session and audit log. One page with sections, so device information is not repeated across pages.
  const deviceSafety = (connection, safety, system) => {
    const tabs = [{ key: 'system', label: 'Device', icon: Server }, { key: 'connection', label: 'Connection & Readiness', icon: Usb },
      ...(safety ? [{ key: 'safety', label: 'Safety & Commissioning', icon: ShieldAlert }] : [])];
    const body = { connection, safety, system }[deviceTab];
    return (<><PageHead title="Device & Safety" right={<Pill tone="info">{physicalMode ? 'Physical mode' : 'Simulation mode'}</Pill>} />
      <Tabs label="Device & Safety sections" idBase="tq-dev" value={deviceTab} onChange={setDevTab} tabs={tabs} />
      <TabPanel tab={deviceTab} idBase="tq-dev">{body}</TabPanel></>);
  };
  const simPages = {
    overview: <SimOverview {...ctx} stepSeconds={stepSeconds} />, live: <LivePage {...ctx} stepSeconds={stepSeconds} />, twin: <Suspense fallback={twinFallback}><SimTwinPage d={d} running={running} stale={stale} go={go} /></Suspense>, diagnostics: <Suspense fallback={pageFallback}><SimDiagnosticsPage {...ctx} /></Suspense>,
    predictions: <Suspense fallback={pageFallback}><SimPredictionsPage {...ctx} /></Suspense>, tests: <Suspense fallback={pageFallback}><SimTestsPage {...ctx} c2c4={c2c4.data} /></Suspense>,
    interventions: <Suspense fallback={pageFallback}><SimInterventionsPage {...ctx} /></Suspense>,
    workflow: <Suspense fallback={pageFallback}><WorkflowPage mode="SIMULATION" d={d} role={user.role} stale={stale} go={go} /></Suspense>,
    recovery: <RecoveryPage {...ctx} />, learning: <LearningPage {...ctx}><Attestation role={user.role} /></LearningPage>,
    evaluation: evaluationPage(null),
    device: deviceSafety(<DevicePage stream={device} role={user.role} go={go} simMode embedded />, null, <DevicesPage {...ctx} rows={audit.rows} auditError={audit.error} />),
    lab: (<><PageHead title="Lab" sub="Recording sessions and matched experiments." /><Lab role={user.role} isPhys={physicalMode} /></>),
    scenario: <ScenarioPage {...ctx} stepSeconds={stepSeconds} />,
  };
  // Simulation-only tools in physical mode: say so, and offer the explicit mode switch (changing mode never commands a motor).
  const simOnly = (t, testid) => (<><PageHead title={t} sub="This tool runs the software simulator only." />
    <AlertPanel tone="warn" icon={FlaskConical} title="SIMULATION ONLY" testid={testid}
      action={<button type="button" className="tq-btn" onClick={() => changeMode('SIMULATION')}><FlaskConical size={14} aria-hidden="true" />Switch to Simulation mode</button>}>
      {t} uses simulated data and is not available in physical mode. Nothing here can command the physical motor.</AlertPanel></>);
  const phys = (layer, fallback) => {
    const l = device.snap?.analysis?.layers?.[layer];
    // Show waiting page when:
    // 1. No snap yet (l is undefined - device not connected / snap not loaded)
    // 2. Layer exists but is in a non-ready state
    const isReady = l && ['ACTIVE', 'AVAILABLE', 'READY', 'VERIFIED'].includes(l.status);
    if (!isReady) {
      return <PhysicalAiPage stream={device} layer={layer} go={go} />;
    }
    return fallback;
  };
  const physPages = {
    overview: <PhysicalOverview stream={device} go={go} role={user.role} />,
    live: <PhysicalLive stream={device} go={go} />,
    twin: <Suspense fallback={twinFallback}><PhysTwinPage stream={device} go={go} /></Suspense>,
    // C1–C4 in physical mode always show the device's own analysis status: the simulation workspaces never render device data,
    // and simulator records never appear under a physical heading, whatever a layer reports.
    diagnostics: <PhysicalAiPage stream={device} layer="C1" go={go} />,
    predictions: <PhysicalAiPage stream={device} layer="C2" go={go} />,
    tests: <PhysicalAiPage stream={device} layer="C4" go={go} />,
    interventions: <PhysicalAiPage stream={device} layer="C3" go={go} />,
    workflow: <Suspense fallback={pageFallback}><WorkflowPage mode="PHYSICAL" role={user.role} stale={false} go={go} /></Suspense>,
    recovery: phys('C5', <RecoveryPage {...ctx} />),
    learning: phys('C6', <LearningPage {...ctx}><Attestation role={user.role} /></LearningPage>),
    evaluation: evaluationPage(<AlertPanel tone="info" icon={FlaskConical} title="SIMULATION EVIDENCE" testid="eval-sim-note">These are results from the software simulator. They say nothing about this physical device and are not hardware validation.</AlertPanel>),
    device: deviceSafety(<DevicePage stream={device} role={user.role} go={go} embedded />, <PhysicalSafetyPage stream={device} role={user.role} go={go} embedded />,
      <DevicesPage {...ctx} rows={audit.rows} auditError={audit.error} />),
    lab: simOnly('Lab', 'lab-sim-note'),
    scenario: simOnly('Scenario Studio', 'scenario-sim-note'),
  };
  const pages = physicalMode ? physPages : simPages;
  const navItem = (k) => {
    const [, label, Icon] = NAV.find((n) => n[0] === k);
    return { label, Icon };
  };
  const current = navItem(view);
  const drawerHidden = compact && !navOpen;
  // Top-bar context. Physical: what the device path reports (connection, handshake, freshness), never inferred from a green dot.
  const snap = device.snap;
  const physLive = !!(snap?.handshake && snap?.origin === 'physical_device');
  const devConnected = snap?.connection === 'CONNECTED' || snap?.connection === 'STALE';
  const modeCtx = physicalMode
    ? { tone: !devConnected ? 'off' : physLive ? (snap.telemetry_fresh ? 'ok' : 'warn') : 'warn', title: 'Physical Mode',
      text: devConnected ? `Connected${snap.port ? ` to ${snap.port}` : ''}${snap.transport_label ? ` (${snap.transport_label})` : ''}` : 'Hardware disconnected' }
    : { tone: 'sim', title: 'Simulation Mode', text: 'Environment: software simulator (no hardware)' };
  const devCtx = physicalMode
    ? { tone: !devConnected ? 'off' : physLive ? (snap.telemetry_fresh ? 'ok' : 'warn') : 'warn',
      title: !devConnected ? 'Device disconnected' : !snap.handshake ? 'Device connecting' : !physLive ? 'Firmware simulation mode' : snap.telemetry_fresh ? 'Device connected' : 'Telemetry stale',
      text: devConnected ? [snap.device_id, snap.firmware && `Firmware ${snap.firmware}`].filter(Boolean).join(' · ') || snap.state_label || '' : 'No physical readings' }
    : null;
  const alerts = physicalMode ? deviceAlerts(device) : simAlerts(d, stale);
  return (
    <div className={`tq-shell ${theme === 'light' ? 'tq-theme-light' : 'tq-theme-dark'} ${navOpen ? 'tq-nav-open' : ''} ${collapsed && !compact ? 'tq-nav-collapsed' : ''}`.replace(/\s+/g, ' ').trim()}>
      <div className="tq-body">
        <nav className="tq-sidebar" id="tq-nav" aria-label="TORQVA sections" ref={navRef} inert={drawerHidden ? '' : undefined}>
          <div className="tq-brand"><Logo /><span className="tq-brand-name"><strong>TORQVA</strong><small>AI Motor Diagnostics</small></span></div>
          {NAV_GROUPS.map((grp, gi) => {
            const single = grp.items.length === 1;
            // A group folds only when it does not hold the open page, so the active page is always visible.
            const shut = !single && folded.includes(grp.heading) && !grp.items.some(([k]) => k === view);
            return (
              <div className="tq-navgroup" key={grp.heading}>
                {single ? <p className="tq-navgroup-label" id={`tq-ng-${gi}`}>{grp.heading}</p>
                  : <button type="button" className="tq-navgroup-label tq-navgroup-btn" id={`tq-ng-${gi}`} aria-expanded={!shut} onClick={() => toggleGroup(grp.heading)}>
                    <span>{grp.heading}</span><ChevronDown size={13} aria-hidden="true" className="tq-navgroup-chev" /></button>}
                {!shut && <ul aria-labelledby={`tq-ng-${gi}`}>{grp.items.map(([k]) => { const { label, Icon } = navItem(k); return (
                  <li key={k}><button className={`tq-nav ${view === k ? 'active' : ''}`} aria-current={view === k ? 'page' : undefined} onClick={() => go(k)} title={collapsed && !compact ? label : undefined}>
                    <Icon size={16} aria-hidden="true" /><span className="tq-nav-label">{label}</span></button></li>); })}</ul>}
              </div>); })}
          <div className="tq-sidebar-foot">
            <button type="button" className="tq-collapse-btn" onClick={toggleCollapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-pressed={collapsed}>
              {collapsed ? <PanelLeftOpen size={16} aria-hidden="true" /> : <PanelLeftClose size={16} aria-hidden="true" />}<span>{collapsed ? 'Expand' : 'Collapse'}</span>
            </button>
          </div>
        </nav>
        <button type="button" className="tq-scrim" tabIndex={-1} aria-hidden="true" onClick={() => setNavOpen(false)} />
        <div className="tq-content">
          <div className="tq-sticky">
            {physicalMode ? <PhysicalBanner snap={device.snap} /> : <SimulationBanner mode={mode} physical={device.snap?.origin === 'physical_device' && device.snap?.handshake === true} />}
            {physicalMode && device.unreachable && (
              <div className="tq-conn" role="alert" data-testid="conn-warning"><WifiOff size={16} aria-hidden="true" /><strong>Backend unreachable.</strong>
                <span>Device readings shown are the last ones received and are not live. Start the backend and this page recovers automatically.</span></div>)}
            {stale && !physicalMode && (
              <div className="tq-conn" role="alert" data-testid="conn-warning"><WifiOff size={16} aria-hidden="true" /><strong>Backend unreachable.</strong>
                <span>Values shown are STALE{lastOk ? <> (last updated <SecondsAgo since={lastOk} /> s ago)</> : ''} and are not live. Start the backend and this page recovers automatically.</span></div>)}
            <header className="tq-top">
              <button type="button" className="tq-iconbtn tq-menu-btn" data-testid="nav-toggle" aria-label="Open navigation" aria-expanded={navOpen} aria-controls="tq-nav" onClick={() => setNavOpen(true)}>
                <Menu size={18} aria-hidden="true" /></button>
              <span className="tq-top-logo"><Logo size={26} /></span>
              <div className="tq-ctx tq-ctx-mode" data-testid="top-mode" title={physicalMode ? 'Physical Hardware Mode' : 'Software Simulator Mode'}>
                <span className={`tq-ctx-icon tq-${physicalMode ? (modeCtx.tone === 'ok' ? 'info' : modeCtx.tone) : 'sim'}`} aria-hidden="true">{physicalMode ? <Usb size={17} /> : <FlaskConical size={17} />}</span>
                <span className="tq-ctx-text"><strong>{modeCtx.title}</strong><span className="tq-env-text">{modeCtx.text}</span></span>
              </div>
              {physicalMode && (
                <div className="tq-ctx tq-ctx-device" data-testid="top-device">
                  <span className={`tq-ctx-dot tq-${devCtx.tone}`} aria-hidden="true" /><span className="tq-ctx-text"><strong>{devCtx.title}</strong>{devCtx.text && <span>{devCtx.text}</span>}</span>
                </div>)}
              <span className="tq-grow" />
              <ModeSwitch mode={appMode} onChange={changeMode} />
              <AlertsMenu alerts={alerts} go={go} />
              <button type="button" className="tq-iconbtn" onClick={toggleTheme} aria-label="Toggle theme" title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Cockpit Theme'}>
                {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}</button>
              <button type="button" className="tq-iconbtn" onClick={() => go('devices')} aria-label="Inventory, session and audit log" title="Inventory, session and audit log"><Settings size={16} aria-hidden="true" /></button>
              <span className="tq-user" title={`${user.user} · ${user.role}`}><span className="tq-avatar" aria-hidden="true">{String(user.user || '?').slice(0, 1)}</span><span className="tq-user-name tq-user-badge">{user.user} · {user.role}</span></span>
              <button type="button" className="tq-iconbtn" onClick={() => { setToken(''); setUser(null); setRunning(false); }} aria-label="Sign out" title="Sign out"><LogOut size={16} aria-hidden="true" /></button>
            </header>
          </div>
          <main className="tq-main">
            <h1 className="tq-sr">{NAV.find((n) => n[0] === view)[1]}</h1>
            <NavContext.Provider value={{ icon: current.Icon, condition: view === 'overview' ? null : physicalMode ? physHealth(device.snap) : simHealth(d, running, stale) }}><div className="tq-view" key={`${appMode}-${view}`}>{!physicalMode && JOURNEY_VIEWS.has(view) && <JourneyBar d={d} view={view} go={go} />}{pages[view]}</div></NavContext.Provider>
          </main>
        </div>
      </div>
    </div>
  );
}
