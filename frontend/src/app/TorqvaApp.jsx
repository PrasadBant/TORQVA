import Login from '../access/Login.jsx';
import React, { Suspense, lazy, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Activity, Box, Gauge, ListChecks, Microscope, Workflow, ShieldCheck, LogOut, FlaskConical, Beaker, LineChart, TestTube2, Settings, WifiOff, Usb, SlidersHorizontal, Sun, Moon, Menu, PanelLeftClose, PanelLeftOpen, Cpu, Brain, ChevronDown, Server, HardDrive } from 'lucide-react';
import { api, ApiError } from '../shared/api.js';
import { setToken, getToken } from '../access/token.js';
import { SimulationBanner, Pill, Logo, NavContext, PageHead, Empty, AlertPanel, Tabs, TabPanel } from '../components/components.jsx';
import { SimOverview, simHealth } from '../pages/simulation/overview.jsx';
import { isPhysOf } from '../pages/simulation/simdata.js';
import { JourneyBar } from '../pages/simulation/journey.jsx';
import { useDeviceStream } from '../telemetry/useDeviceStream.js';
import { DevicePage, DeviceCard } from '../device/device.jsx';
import { DeviceLive } from '../telemetry/DeviceLive.jsx';
import { isOverrideActive } from '../telemetry/devicePresentation.js';
import { ModeSwitch, PhysicalBanner, PhysicalOverview, PhysicalLive, PhysicalAiPage, physHealth } from '../pages/physical/physical.jsx';
import { AlertsMenu, deviceAlerts, simAlerts } from '../safety/alerts.jsx';
import { RecordingIndicator } from '../shared/recording.jsx';
import { AlarmProvider } from '../safety/alarmContext.jsx';
import './torqva.css';
import './styles/system.css';
import './styles/monitoring.css';
import './styles/analysis.css';
import './styles/assurance.css';
import './styles/twin-sim.css';

// The analyst's path through the product, top to bottom: watch the motor, diagnose and decide, verify and learn, then the engineering tools.
// Labels are the product names only; internal layer identifiers never appear in the interface.
const NAV_GROUPS = [
  {
    heading: 'Monitor', items: [
      ['overview', 'Overview', Gauge],
      ['live', 'Live Monitor', Activity],
      ['twin', 'Digital Twin', Box],
    ]
  },
  {
    heading: 'Diagnose', items: [
      ['workflow', 'Diagnostic Workflow', Workflow],
      ['diagnostics', 'Anomaly Detection', Microscope],
      ['predictions', 'Failure Prediction', LineChart],
      ['interventions', 'Action Recommendations', ListChecks],
      ['tests', 'Diagnostic Investigation', TestTube2],
    ]
  },
  {
    heading: 'Intelligence', items: [
      ['recovery', 'Recovery Verification', ShieldCheck],
      ['learning', 'Continuous Intelligence', Brain],
      ['evaluation', 'Performance Evaluation', FlaskConical],
    ]
  },
  {
    heading: 'Engineering', items: [
      ['scenario', 'Scenario Studio', SlidersHorizontal],
      ['lab', 'Lab', Beaker],
    ]
  },
  {
    heading: 'Hardware & Device', items: [
      ['device', 'Hardware Manager', Cpu, 'Hardware Manager'],
      ['firmware', 'Firmware Manager', HardDrive],
    ]
  },
];
// Former page ids that are now sections of Hardware Manager: links and stored selections keep working and open the right section.
const ALIASES = { control: ['device', 'connection'], devices: ['device', 'system'], connection: ['device', 'connection'] };
const GROUPS_KEY = 'torqva.navgroups';
const readFolded = () => { try { return JSON.parse(window.localStorage.getItem(GROUPS_KEY) || '[]'); } catch { return []; } };

// The Digital Twin (drawing, workspace and mappings) is fetched when first opened, so it does not delay sign-in or the dashboards.
const SimTwinPage = lazy(() => import('../pages/simulation/twin.jsx').then((m) => ({ default: m.SimTwinPage })));
const PhysTwinPage = lazy(() => import('../pages/physical/twin.jsx').then((m) => ({ default: m.PhysTwinPage })));
const twinFallback = <Empty loading>Loading the Digital Twin…</Empty>;
// The analyst workspaces (C1, C4, C2, C3 in simulation mode) are fetched when first opened, like the twin.
const SimDiagnosticsPage = lazy(() => import('../pages/simulation/diagnose.jsx').then((m) => ({ default: m.SimDiagnosticsPage })));
const SimTestsPage = lazy(() => import('../pages/simulation/tests.jsx').then((m) => ({ default: m.SimTestsPage })));
const SimPredictionsPage = lazy(() => import('../pages/simulation/predict.jsx').then((m) => ({ default: m.SimPredictionsPage })));
const SimInterventionsPage = lazy(() => import('../pages/simulation/intervene.jsx').then((m) => ({ default: m.SimInterventionsPage })));
// The unified workflow: one component for both modes (the backend's mode-specific adapter decides what can run).
const WorkflowPage = lazy(() => import('../pages/workflow/workflow.jsx').then((m) => ({ default: m.WorkflowPage })));
// Physical diagnostic workspaces powered by real live hardware telemetry
const PhysicalDiagnosticsPage = lazy(() => import('../pages/physical/diagnostics.jsx').then((m) => ({ default: m.PhysicalDiagnosticsPage })));
const PhysicalPredictionsPage = lazy(() => import('../pages/physical/diagnostics.jsx').then((m) => ({ default: m.PhysicalPredictionsPage })));
const PhysicalTestsPage = lazy(() => import('../pages/physical/diagnostics.jsx').then((m) => ({ default: m.PhysicalTestsPage })));
const PhysicalInterventionsPage = lazy(() => import('../pages/physical/diagnostics.jsx').then((m) => ({ default: m.PhysicalInterventionsPage })));
const pageFallback = <Empty loading>Loading…</Empty>;
// Firmware Manager (physical device only): fetched when first opened.
const FirmwarePage = lazy(() => import('../device/firmware.jsx').then((m) => ({ default: m.FirmwarePage })));
// The remaining simulation pages (and the ones physical mode shares: Recovery, Learning, Evaluation, the device inventory) are also
// split out of the entry bundle, so sign-in and the physical Overview load without them.
const LOADERS = {
  pages: () => import('../pages/simulation/pages.jsx'),
  assurance: () => import('../pages/simulation/assurance.jsx'),
  evaluation: () => import('../pages/simulation/evaluation.jsx'),
  physEvaluation: () => import('../pages/physical/evaluation.jsx'),
  physRecovery: () => import('../pages/physical/recovery.jsx'),
  physLearning: () => import('../pages/physical/learning.jsx'),
  lab: () => import('../pages/simulation/lab.jsx'),
  attestation: () => import('../pages/simulation/attestation.jsx'),
  scenario: () => import('../pages/simulation/scenario.jsx'),
};
const page = (mod, name) => lazy(() => LOADERS[mod]().then((m) => ({ default: m[name] })));
const LivePage = page('pages', 'LivePage');
const DevicesPage = page('pages', 'DevicesPage');
const RecoveryPage = page('assurance', 'RecoveryPage');
const LearningPage = page('assurance', 'LearningPage');
const PhysicalRecoveryPage = page('physRecovery', 'PhysicalRecoveryPage');
const PhysicalLearningPage = page('physLearning', 'PhysicalLearningPage');
const Evaluation = page('evaluation', 'Evaluation');
const PhysicalEvaluation = page('physEvaluation', 'PhysicalEvaluation');
const Lab = page('lab', 'default');
const Attestation = page('attestation', 'default');
const ScenarioPage = page('scenario', 'ScenarioPage');
const S = (el) => <Suspense fallback={pageFallback}>{el}</Suspense>;

const NAV = NAV_GROUPS.flatMap((g) => g.items);

// URL routing (hash, no dependency): #/<page> or #/device/<tab>. A route only chooses what is SHOWN: every page keeps its own role,
// mode checks: the mode is never taken from the URL (a link cannot switch Physical to Simulation), and nothing is started,
// resumed or sent because a URL was opened. An unknown route opens Overview.
const PAGE_IDS = new Set(NAV.map((n) => n[0]));
const DEVICE_TABS = new Set(['system', 'connection']);
export function parseRoute(hash) {
  const m = /^#\/([a-z]+)(?:\/([a-z]+))?$/.exec(hash || '');
  if (!m) return null;
  const [, p, t] = m;
  if (ALIASES[p] && !t) return { view: ALIASES[p][0], tab: ALIASES[p][1] };
  if (!PAGE_IDS.has(p)) return null;
  if (p === 'device') return t === undefined || DEVICE_TABS.has(t) ? { view: 'device', tab: t || 'system' } : null;
  return t === undefined ? { view: p, tab: null } : null;
}
export const routeHash = (view, tab) => (view === 'device' ? `#/device/${tab || 'system'}` : `#/${view}`);
const readRoute = () => { try { return parseRoute(window.location.hash); } catch { return null; } };
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
  try { window.localStorage.setItem(THEME_KEY, t); } catch { }
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
  const [rawView, setView] = useState(() => readRoute()?.view || 'overview');
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
  const [devTab, setDevTab] = useState(() => readRoute()?.tab || 'system');
  // Browser Back / Forward and a hand-edited URL: show the route's page. An unknown route falls back to Overview.
  useEffect(() => {
    const onRoute = () => {
      const r = readRoute();
      if (!r && window.location.hash !== '#/overview') window.history.replaceState(null, '', '#/overview');
      setView(r?.view || 'overview');
      if (r?.tab) setDevTab(r.tab);
      setNavOpen(false);
    };
    window.addEventListener('popstate', onRoute);
    window.addEventListener('hashchange', onRoute);
    return () => { window.removeEventListener('popstate', onRoute); window.removeEventListener('hashchange', onRoute); };
  }, []);
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
  const physicalMode = appMode === 'PHYSICAL';
  const isPhys = physicalMode || isPhysOf(d);
  const view = ALIASES[rawView]?.[0] || rawView;
  const deviceTab = devTab === 'safety' ? 'system' : devTab;
  // Keep the URL on the page shown. A new page adds a history entry; a tab change or a correction (an unknown route) replaces the current one, so Back always returns to the previous page.
  useEffect(() => {
    try {
      const want = routeHash(view, deviceTab);
      if (window.location.hash === want) return;
      const same = readRoute()?.view === view;
      window.history[same || !window.location.hash ? 'replaceState' : 'pushState'](null, '', want);
    } catch { /* history unavailable: navigation still works in-app */ }
  }, [view, deviceTab, rawView, devTab]);           // the raw values too: a hand-edited URL that is corrected leaves the shown page unchanged
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
      api.start({ fault: null, severity: 0.5, seed: 1, clears_below_rpm: null, require_human_approval: false }).then(() => { setRunning(true); refresh(); }).catch(() => { });
    }
  }, [user, physicalMode, d.status, d.telemetry, refresh]);

  useEffect(() => {
    if (!user) return undefined;
    if (physicalMode) {
      if (['device', 'recovery', 'learning', 'tests', 'workflow', 'interventions'].includes(view)) {
        refresh();
      }
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
    {S(<Evaluation loading={!evalState.run && !evalState.error} evalRun={evalState.run} evalError={evalState.error} c2c4={c2c4.data} c2c4Error={c2c4.error} />)}</>);
  // Device page: connection, device information, session and audit log.
  const hardwareManager = (connection, system) => {
    const tabs = [{ key: 'system', label: 'Device', icon: Server }, { key: 'connection', label: 'Connection & Readiness', icon: Usb },
    ];
    const body = { connection, system }[deviceTab];
    return (<><PageHead title="Hardware Manager" right={<Pill tone="info">{physicalMode ? 'Physical mode' : 'Simulation mode'}</Pill>} />
      <Tabs label="Hardware Manager sections" idBase="tq-dev" value={deviceTab} onChange={setDevTab} tabs={tabs} />
      <TabPanel tab={deviceTab} idBase="tq-dev">{body}</TabPanel></>);
  };
  const simPages = {
    overview: <SimOverview {...ctx} stepSeconds={stepSeconds} />, live: S(<LivePage {...ctx} stepSeconds={stepSeconds} />), twin: <Suspense fallback={twinFallback}><SimTwinPage d={d} running={running} stale={stale} go={go} /></Suspense>, diagnostics: <Suspense fallback={pageFallback}><SimDiagnosticsPage {...ctx} /></Suspense>,
    predictions: <Suspense fallback={pageFallback}><SimPredictionsPage {...ctx} /></Suspense>, tests: <Suspense fallback={pageFallback}><SimTestsPage {...ctx} c2c4={c2c4.data} /></Suspense>,
    interventions: <Suspense fallback={pageFallback}><SimInterventionsPage {...ctx} /></Suspense>,
    workflow: <Suspense fallback={pageFallback}><WorkflowPage mode="SIMULATION" d={d} role={user.role} stale={stale} go={go} /></Suspense>,
    recovery: S(<PhysicalRecoveryPage stream={device} go={go} role={user.role} d={d} physicalMode={false} simView={S(<RecoveryPage {...ctx} />)} />),
    learning: S(<PhysicalLearningPage stream={device} go={go} role={user.role} d={d} physicalMode={false} simView={S(<LearningPage {...ctx}>{S(<Attestation role={user.role} />)}</LearningPage>)} />),
    evaluation: S(<PhysicalEvaluation physicalMode={false} simView={<Evaluation loading={!evalState.run && !evalState.error} evalRun={evalState.run} evalError={evalState.error} c2c4={c2c4.data} c2c4Error={c2c4.error} />} />),
    device: hardwareManager(<DevicePage stream={device} role={user.role} go={go} simMode embedded />, S(<DevicesPage {...ctx} rows={audit.rows} auditError={audit.error} />)),
    lab: (<><PageHead title="Lab" sub="Recording sessions and matched experiments." />{S(<Lab role={user.role} isPhys={physicalMode} />)}</>),
    scenario: S(<ScenarioPage {...ctx} stepSeconds={stepSeconds} />),
    // Firmware belongs to the physical board: simulation mode has nothing to update and never reaches the firmware routes.
    firmware: (<><PageHead title="Firmware Manager" sub="Firmware updates apply to the physical ESP32-S3 device." />
      <AlertPanel tone="info" icon={HardDrive} title="PHYSICAL DEVICE ONLY" testid="fw-sim-note"
        action={<button type="button" className="tq-btn" onClick={() => changeMode('PHYSICAL')}><Usb size={14} aria-hidden="true" />Switch to Physical mode</button>}>
        The software simulator has no firmware. Switch to Physical mode to manage the board's firmware.</AlertPanel></>),
  };
  // Simulation-only tools in physical mode: say so, and offer the explicit mode switch (changing mode never commands a motor).
  const simOnly = (t, testid) => (<><PageHead title={t} sub="This tool runs the software simulator only." />
    <AlertPanel tone="warn" icon={FlaskConical} title="SIMULATION ONLY" testid={testid}
      action={<button type="button" className="tq-btn" onClick={() => changeMode('SIMULATION')}><FlaskConical size={14} aria-hidden="true" />Switch to Simulation mode</button>}>
      {t} uses simulated data and is not available in physical mode. Nothing here can command the physical motor.</AlertPanel></>);
  const physLiveNow = !!(device.data?.handshake && device.data?.origin === 'physical_device');
  const phys = (layer, fallback) => (physLiveNow ? fallback : <PhysicalAiPage stream={device} layer={layer} go={go} />);
  const physDiag = (layer, fallbackComponent) => (
    physLiveNow
      ? <Suspense fallback={pageFallback}>{fallbackComponent}</Suspense>
      : <PhysicalAiPage stream={device} layer={layer} go={go} />
  );
  const physPages = {
    overview: <PhysicalOverview stream={device} go={go} role={user.role} />,
    live: <PhysicalLive stream={device} go={go} />,
    twin: <Suspense fallback={twinFallback}><PhysTwinPage stream={device} go={go} /></Suspense>,
    diagnostics: physDiag('C1', <PhysicalDiagnosticsPage stream={device} go={go} role={user.role} />),
    predictions: physDiag('C2', <PhysicalPredictionsPage stream={device} go={go} role={user.role} />),
    tests: physDiag('C4', <PhysicalTestsPage stream={device} go={go} role={user.role} />),
    interventions: <Suspense fallback={pageFallback}><PhysicalInterventionsPage stream={device} go={go} role={user.role} /></Suspense>,
    workflow: <Suspense fallback={pageFallback}><WorkflowPage mode="PHYSICAL" role={user.role} stale={false} go={go} /></Suspense>,
    recovery: phys('C5', S(<PhysicalRecoveryPage stream={device} go={go} role={user.role} d={d} physicalMode={true} simView={S(<RecoveryPage {...ctx} />)} />)),
    learning: phys('C6', S(<PhysicalLearningPage stream={device} go={go} role={user.role} d={d} physicalMode={true} simView={S(<LearningPage {...ctx}>{S(<Attestation role={user.role} />)}</LearningPage>)} />)),
    evaluation: S(<PhysicalEvaluation physicalMode={true} simView={<Evaluation loading={!evalState.run && !evalState.error} evalRun={evalState.run} evalError={evalState.error} c2c4={c2c4.data} c2c4Error={c2c4.error} />} />),
    device: hardwareManager(<DevicePage stream={device} role={user.role} go={go} embedded />,
      S(<DevicesPage {...ctx} rows={audit.rows} auditError={audit.error} />)),
    lab: simOnly('Lab', 'lab-sim-note'),
    scenario: simOnly('Scenario Studio', 'scenario-sim-note'),
    firmware: <Suspense fallback={pageFallback}><FirmwarePage role={user.role} go={go} /></Suspense>,
  };
  const pages = physicalMode ? physPages : simPages;
  const navItem = (k) => {
    const item = NAV.find((n) => n[0] === k) || [];
    return { label: item[1], Icon: item[2], ariaLabel: item[3] || item[1] };
  };
  const current = navItem(view);
  const drawerHidden = compact && !navOpen;
  // Top-bar context. Physical: what the device path reports (connection, handshake, freshness), never inferred from a green dot.
  const snap = device.snap;
  const override = isOverrideActive();
  const physLive = !!((snap?.handshake || override) && (snap?.origin === 'physical_device' || override) && snap);
  const devConnected = !!(snap && (snap.connection === 'CONNECTED' || snap.connection === 'STALE' || (override && snap.connection !== 'DISCONNECTED')));
  const modeCtx = physicalMode
    ? {
      tone: !devConnected ? 'off' : (physLive && (snap?.telemetry_fresh || override)) ? 'ok' : 'warn', title: 'Physical Mode',
      text: devConnected ? `Connected${snap?.port ? ` to ${snap.port}` : ''}${snap?.transport_label ? ` (${snap.transport_label})` : ''}` : 'Hardware disconnected'
    }
    : { tone: 'sim', title: 'Simulation Mode', text: 'Environment: software simulator (no hardware)' };
  const devCtx = physicalMode
    ? {
      tone: !devConnected ? 'off' : (physLive && (snap?.telemetry_fresh || override)) ? 'ok' : 'warn',
      title: !devConnected ? 'Device disconnected' : (!snap?.handshake && !override) ? 'Device connecting' : (!physLive && !override) ? 'Firmware simulation mode' : (snap?.telemetry_fresh || override) ? 'Device connected' : 'Telemetry stale',
      text: devConnected ? [snap?.device_id, snap?.firmware && `Firmware ${snap.firmware}`].filter(Boolean).join(' · ') || snap?.state_label || '' : 'No physical readings'
    }
    : null;
  const alerts = physicalMode ? deviceAlerts(device) : simAlerts(d, stale);
  return (
    <AlarmProvider>
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
                    : <button type="button" className="tq-navgroup-label tq-navgroup-btn" id={`tq-ng-${gi}`} aria-expanded={!shut} aria-label={grp.heading === 'Hardware & Device' ? 'Show or hide Hardware Manager' : `Show or hide ${grp.heading}`} onClick={() => toggleGroup(grp.heading)}>
                      <span>{grp.heading}</span><ChevronDown size={13} aria-hidden="true" className="tq-navgroup-chev" /></button>}
                  {!shut && <ul aria-labelledby={`tq-ng-${gi}`}>{grp.items.map(([k]) => {
                    const { label, Icon, ariaLabel } = navItem(k); return (
                      <li key={k}><button className={`tq-nav ${view === k ? 'active' : ''}`} aria-current={view === k ? 'page' : undefined} aria-label={ariaLabel} onClick={() => go(k)} title={collapsed && !compact ? label : undefined}>
                        <Icon size={16} aria-hidden="true" /><span className="tq-nav-label">{label}</span></button></li>);
                  })}</ul>}
                </div>);
            })}
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
                <RecordingIndicator physicalMode={physicalMode} role={user.role} />
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
    </AlarmProvider>
  );
}
