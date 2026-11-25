import React, { useState } from 'react';
import { FlaskConical, KeyRound, ShieldCheck, Usb } from 'lucide-react';
import { Logo, SimulationBanner } from '../components/components.jsx';

const LOGIN_POINTS = [
  [Usb, 'Physical-device first', 'Live readings come from the connected board. A missing or invalid reading is shown as unavailable, never as zero.'],
  [ShieldCheck, 'Direct motor commands', 'Motor commands go through the backend command path and the firmware on the board.'],
  [FlaskConical, 'Simulation kept separate', 'The research simulator is an explicit mode and is labelled on every screen.'],
];

export default function Login({ onLogin, error, theme }) {
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
