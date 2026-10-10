import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Gauge, ListChecks, Microscope, History, ShieldCheck, LogOut, FlaskConical, Beaker } from 'lucide-react';
import { api, setToken, getToken, ApiError } from './api.js';
import { SimulationBanner, Pill } from './components.jsx';
import { Overview, Live, Investigation, Decisions, Recovery, Evaluation, Audit } from './views.jsx';
import Lab from './lab.jsx';
import './torqva.css';

const NAV = [
  ['overview', 'Overview', Gauge], ['live', 'Live', Activity], ['investigation', 'Investigation', Microscope],
  ['decisions', 'Decisions', ListChecks], ['lab', 'Lab', Beaker], ['recovery', 'Recovery', ShieldCheck], ['evaluation', 'Learning & Evaluation', FlaskConical],
  ['audit', 'Audit', History],
];

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
        <button className="tq-btn" type="submit" disabled={!t.trim()}>Sign in</button>
      </form>
    </main>
  );
}

export default function TorqvaApp({ pollMs = 1500, stepSeconds = 5 }) {
  const [user, setUser] = useState(null);
  const [loginError, setLoginError] = useState('');
  const [view, setView] = useState('overview');
  const [d, setD] = useState({});
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [evalState, setEvalState] = useState({ run: null, error: null });
  const [audit, setAudit] = useState({ rows: [], error: null });
  const alive = useRef(true);

  const onLogin = useCallback(async (token) => {
    setToken(token);
    try { setUser(await api.me()); setLoginError(''); }
    catch (e) {
      setToken('');
      setLoginError(e instanceof ApiError && e.status === 503 ? 'Authentication is not configured on the server; the TORQVA API is disabled.'
        : e instanceof ApiError && e.status === 401 ? 'That token was not accepted.' : `Could not reach the server: ${e.message}`);
    }
  }, []);

  useEffect(() => { alive.current = true; if (getToken()) onLogin(getToken()); return () => { alive.current = false; }; }, [onLogin]);

  const refresh = useCallback(async () => {
    try {
      const [status, telemetry, incidents, decisions, predictions, commands, outcomes, cases, log] = await Promise.all([
        api.status(), api.telemetry(300), api.incidents(), api.decisions(), api.predictions(), api.commands(), api.outcomes(), api.cases(), api.log()]);
      if (alive.current) { setD({ status, telemetry, incidents, decisions, predictions, commands, outcomes, cases, log }); setError(null); }
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && e.status === 401) { setToken(''); setUser(null); } else setError(e);
    }
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    refresh();
    const id = setInterval(async () => {
      if (running) { try { await api.step(stepSeconds); } catch (e) { setError(e); setRunning(false); } }
      refresh();
    }, pollMs);
    return () => clearInterval(id);
  }, [user, running, refresh, pollMs, stepSeconds]);

  useEffect(() => {
    if (!user) return;
    if (view === 'evaluation') api.evaluation().then((r) => setEvalState({ run: r, error: null })).catch((e) => setEvalState({ run: null, error: e }));
    if (view === 'audit' && user.role === 'admin') api.audit().then((rows) => setAudit({ rows, error: null })).catch((e) => setAudit({ rows: [], error: e }));
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
  const mode = d.status?.mode || 'SIMULATION';
  const dev = d.status?.device;
  const Body = { overview: Overview, live: Live, investigation: Investigation, decisions: Decisions, recovery: Recovery, evaluation: Evaluation, audit: Audit, lab: Lab }[view];
  const props = { d, role: user.role, actions, running, setRunning, busy, error, evalRun: evalState.run, evalError: evalState.error, rows: audit.rows };
  return (
    <div className="tq-shell">
      <SimulationBanner mode={mode} />
      <header className="tq-top">
        <strong className="tq-wordmark">TORQVA</strong>
        <span className="tq-muted">Testbed: simulator</span>
        <Pill tone={dev?.estop ? 'stop' : 'ok'}>{dev?.estop ? 'DEVICE E-STOP' : 'Device OK'}</Pill>
        <span className="tq-grow" />
        <span className="tq-muted">{user.user} · {user.role}</span>
        <button className="tq-btn tq-ghost" onClick={() => { setToken(''); setUser(null); setRunning(false); }} aria-label="Sign out"><LogOut size={14} aria-hidden="true" /></button>
      </header>
      <div className="tq-body">
        <nav aria-label="TORQVA sections">
          <ul>{NAV.map(([k, label, Icon]) => (
            <li key={k}><button className={`tq-nav ${view === k ? 'active' : ''}`} aria-current={view === k ? 'page' : undefined} onClick={() => setView(k)}>
              <Icon size={15} aria-hidden="true" />{label}</button></li>))}</ul>
        </nav>
        <main><h2 className="tq-sr">{NAV.find((n) => n[0] === view)[1]}</h2><Body {...props} /></main>
      </div>
    </div>
  );
}
