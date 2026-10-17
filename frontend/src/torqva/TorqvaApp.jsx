import React, { Suspense, lazy, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Activity, Box, Gauge, ListChecks, Microscope, ShieldCheck, LogOut, FlaskConical, Beaker, LineChart, TestTube2, Settings, WifiOff, GraduationCap, Usb, SlidersHorizontal, Sun, Moon, ClipboardCheck, Menu, KeyRound, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { api, setToken, getToken, ApiError } from './api.js';
import { SimulationBanner, Pill, Logo, NavContext, PageHead, Empty } from './shared/components.jsx';
import { prefetchCharts } from './shared/lazyCharts.jsx';
import { Evaluation } from './simulation/evaluation.jsx';
import { SimOverview } from './simulation/overview.jsx';
import { LivePage, DiagnosticsPage, PredictionsPage, TestsPage, InterventionsPage, RecoveryPage, LearningPage, DevicesPage, isPhysOf } from './simulation/pages.jsx';
import { useDeviceStream, DevicePage, MotorControlPage, DeviceCard, DeviceLive } from './physical/device.jsx';
import Lab from './simulation/lab.jsx';
import Attestation from './simulation/attestation.jsx';
import { ModeSwitch, PhysicalBanner, PhysicalOverview, PhysicalLive, PhysicalAiPage, PhysicalSafetyPage } from './physical/physical.jsx';
import './torqva.css';

const NAV_GROUPS = [
  {
    heading: 'Dashboard',
    items: [
      ['overview', 'Overview', Gauge, ''],
      ['live', 'Live Monitor', Activity, ''],
      ['twin', 'Digital Twin', Box, ''],
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

// The Digital Twin (drawing, workspace and mappings) is fetched when first opened, so it does not delay sign-in or the dashboards.
const SimTwinPage = lazy(() => import('./simulation/twin.jsx').then((m) => ({ default: m.SimTwinPage })));
const PhysTwinPage = lazy(() => import('./physical/twin.jsx').then((m) => ({ default: m.PhysTwinPage })));
const twinFallback = <Empty loading>Loading the Digital Twin…</Empty>;

const NAV = NAV_GROUPS.flatMap((g) => g.items);
const groupOf = (k) => (NAV_GROUPS.find((g) => g.items.some((n) => n[0] === k)) || { heading: '' }).heading;

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
  const [view, setView] = useState('overview');
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
  const go = useCallback((k) => { setView(k); setNavOpen(false); scrollTop(); }, []);
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
  const changeMode = (m) => { setAppMode(m); storeMode(m); setRunning(false); };
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
    if (physicalMode) { if (view === 'devices') refresh(); return undefined; }        // physical mode never polls or steps the simulator
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
    if (view === 'devices' && user.role === 'admin') api.audit().then((rows) => setAudit({ rows, error: null })).catch((e) => setAudit({ rows: [], error: e }));
  }, [view, user]);

  const act = (fn) => async (...a) => {
    setBusy(true);
    try { await fn(...a); setError(null); } catch (e) { setError(e); } finally { setBusy(false); refresh(); }
  };
  const actions = {
    start: act(async (body) => { await api.start(body); setRunning(false); }),
    approve: act(() => api.approve()), reject: act(() => api.reject()), stop: act(() => api.stop()),
    step: act(() => api.step(stepSeconds)),           // one manual step while paused (the button is disabled while time advances on its own)
  };

  const stale = useStale(lastOk, offline, Math.max(8000, pollMs * 4));
  if (!user) return <Login onLogin={onLogin} error={loginError} theme={theme === 'light' ? 'light' : 'dark'} />;
  const mode = physicalMode ? 'PHYSICAL' : (d.status?.mode || 'SIMULATION');
  const dev = d.status?.device;
  const ctx = { d, role: user.role, user, actions, running, setRunning, busy, error, stale, go, ctl: canStart(user.role), device, physicalMode, isPhys, deviceCard: <DeviceCard stream={device} go={go} />, deviceLive: <DeviceLive stream={device} /> };
  const simPages = {
    overview: <SimOverview {...ctx} stepSeconds={stepSeconds} />, live: <LivePage {...ctx} stepSeconds={stepSeconds} />, twin: <Suspense fallback={twinFallback}><SimTwinPage d={d} running={running} stale={stale} go={go} /></Suspense>, diagnostics: <DiagnosticsPage {...ctx} />,
    predictions: <PredictionsPage {...ctx} />, tests: <TestsPage {...ctx} c2c4={c2c4.data} />, interventions: <InterventionsPage {...ctx} />,
    recovery: <RecoveryPage {...ctx} />, learning: <LearningPage {...ctx}><Attestation role={user.role} /></LearningPage>,
    evaluation: (<><PageHead title="Evaluation and Research" sub="Simulation evaluation artifacts, baselines versus candidates, provenance and known limitations." />
      <Evaluation loading={!evalState.run && !evalState.error} evalRun={evalState.run} evalError={evalState.error} c2c4={c2c4.data} c2c4Error={c2c4.error} /></>),
    device: <DevicePage stream={device} role={user.role} />, control: <MotorControlPage stream={device} role={user.role} />,
    lab: (<><PageHead title="Lab" sub="Reproducible recording sessions, fault-injection records and matched experiments on the software simulator." /><Lab role={user.role} isPhys={physicalMode} /></>), devices: <DevicesPage {...ctx} rows={audit.rows} auditError={audit.error} />,
  };
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
    live: <PhysicalLive stream={device} />,
    twin: <Suspense fallback={twinFallback}><PhysTwinPage stream={device} go={go} /></Suspense>,
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
  const navItem = (k) => {
    const [, label0, Icon0, tag] = NAV.find((n) => n[0] === k);
    const swapped = physicalMode && k === 'control';            // in physical mode the controls live on the dashboard; this page is the safety record
    return { label: swapped ? 'Safety & Commissioning' : label0, Icon: swapped ? ClipboardCheck : Icon0, tag };
  };
  const current = navItem(view);
  const drawerHidden = compact && !navOpen;
  const connText = physicalMode ? (device.snap?.connection === 'CONNECTED' ? (device.snap.port ? `${device.snap.port} Online` : 'Device Online') : 'Hardware Disconnected') : 'Environment: software simulator (no hardware)';
  return (
    <div className={`tq-shell ${theme === 'light' ? 'tq-theme-light' : 'tq-theme-dark'} ${navOpen ? 'tq-nav-open' : ''} ${collapsed && !compact ? 'tq-nav-collapsed' : ''}`.replace(/\s+/g, ' ').trim()}>
      <div className="tq-body">
        <nav className="tq-sidebar" id="tq-nav" aria-label="TORQVA sections" ref={navRef} inert={drawerHidden ? '' : undefined}>
          <div className="tq-brand"><Logo /><span className="tq-brand-name"><strong>TORQVA</strong><small>Motor intelligence</small></span></div>
          {NAV_GROUPS.map((grp, gi) => (
            <div className="tq-navgroup" key={grp.heading}>
              <p className="tq-navgroup-label" id={`tq-ng-${gi}`}>{grp.heading}</p>
              <ul aria-labelledby={`tq-ng-${gi}`}>{grp.items.map(([k]) => { const { label, Icon, tag } = navItem(k); return (
                <li key={k}><button className={`tq-nav ${view === k ? 'active' : ''}`} aria-current={view === k ? 'page' : undefined} onClick={() => go(k)} title={collapsed && !compact ? label : undefined}>
                  <Icon size={16} aria-hidden="true" /><span className="tq-nav-label">{label}</span>{tag && <span className="tq-tag">{tag}</span>}</button></li>); })}</ul>
            </div>))}
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
              <div className="tq-crumb" aria-hidden="true"><small>{groupOf(view)}</small><span>{current.label}</span></div>
              <span className="tq-env" title={physicalMode ? 'Physical Hardware Mode' : 'Software Simulator Mode'}>
                <span className={`tq-env-dot ${physicalMode ? (device.snap?.telemetry_fresh ? 'live' : 'warn') : 'sim'}`} aria-hidden="true" />
                <span className="tq-env-text">{connText}</span>
                {!physicalMode && <Pill tone={dev?.estop ? 'stop' : 'ok'}>{dev?.estop ? 'SIMULATED E-STOP' : 'Simulated device OK'}</Pill>}
              </span>
              <span className="tq-grow" />
              <ModeSwitch mode={appMode} onChange={changeMode} />
              <button type="button" className="tq-iconbtn" onClick={toggleTheme} aria-label="Toggle theme" title={theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Cockpit Theme'}>
                {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}</button>
              <span className="tq-user" title={`${user.user} · ${user.role}`}><span className="tq-avatar" aria-hidden="true">{String(user.user || '?').slice(0, 1)}</span><span className="tq-user-name tq-user-badge">{user.user} · {user.role}</span></span>
              <button type="button" className="tq-iconbtn" onClick={() => { setToken(''); setUser(null); setRunning(false); }} aria-label="Sign out" title="Sign out"><LogOut size={16} aria-hidden="true" /></button>
            </header>
          </div>
          <main className="tq-main">
            <h1 className="tq-sr">{NAV.find((n) => n[0] === view)[1]}</h1>
            <NavContext.Provider value={{ icon: current.Icon, group: groupOf(view), tag: current.tag }}><div className="tq-view" key={`${appMode}-${view}`}>{pages[view]}</div></NavContext.Provider>
          </main>
        </div>
      </div>
    </div>
  );
}
