import React, { useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ReferenceLine, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Play, Pause, StopCircle, Check, X } from 'lucide-react';
import { Card, Empty, ErrorBox, Pill, PosteriorBars, ProvBadge, fmt, stateTone } from './components.jsx';

const FAULTS = ['imbalance', 'looseness', 'overload', 'cooling_failure', 'supply_voltage', 'sensor_fault'];
const lastOf = (log, kind) => [...(log || [])].reverse().find((l) => l.kind === kind);
const canControl = (role) => role === 'operator' || role === 'admin';

/* ------------------------------------------------------------------ Overview */
export function Overview({ d, role, actions, running, setRunning, busy, error }) {
  const [form, setForm] = useState({ fault: 'imbalance', severity: 0.5, transient: true, approval: false, seed: 1 });
  const s = d.status || {};
  const inc = s.incident;
  const w = s.last_window;
  const hasSim = s.t !== undefined && s.t !== null;      // sim time is 0 right after start: do not test truthiness
  const start = () => actions.start({
    fault: form.fault === 'none' ? null : form.fault, severity: Number(form.severity), seed: Number(form.seed),
    clears_below_rpm: form.transient ? 1500 : null, require_human_approval: form.approval,
  });
  return (
    <div className="tq-grid">
      <Card title="Simulation scenario" id="c-scn" right={<ProvBadge kind="SIMULATED" />}>
        {!canControl(role) && <Empty>Your role ({role}) can view but not start simulations.</Empty>}
        <form className="tq-form" onSubmit={(e) => { e.preventDefault(); start(); }}>
          <label>Injected fault
            <select value={form.fault} onChange={(e) => setForm({ ...form, fault: e.target.value })} disabled={!canControl(role)}>
              <option value="none">none (healthy run)</option>
              {FAULTS.map((f) => <option key={f} value={f}>{f.replace('_', ' ')}</option>)}
            </select>
          </label>
          <label>Severity ({form.severity})
            <input type="range" min="0.05" max="1" step="0.05" value={form.severity}
              onChange={(e) => setForm({ ...form, severity: e.target.value })} disabled={!canControl(role)} />
          </label>
          <label className="tq-check"><input type="checkbox" checked={form.transient}
            onChange={(e) => setForm({ ...form, transient: e.target.checked })} disabled={!canControl(role)} />
            Condition clears when speed is reduced (simulated transient)</label>
          <label className="tq-check"><input type="checkbox" checked={form.approval}
            onChange={(e) => setForm({ ...form, approval: e.target.checked })} disabled={!canControl(role)} />
            Require human approval (as in hardware mode)</label>
          <button type="submit" className="tq-btn" disabled={!canControl(role) || busy}>Start new simulation</button>
        </form>
        <div className="tq-row">
          <button className="tq-btn" onClick={() => setRunning(!running)} disabled={!canControl(role) || !hasSim}>
            {running ? <><Pause size={14} aria-hidden="true" /> Pause</> : <><Play size={14} aria-hidden="true" /> Run</>}
          </button>
          <button className="tq-btn tq-danger" onClick={actions.stop} disabled={!hasSim} aria-label="Stop motor (coast)">
            <StopCircle size={14} aria-hidden="true" /> STOP
          </button>
        </div>
        <ErrorBox error={error} />
      </Card>

      <Card title="Device" id="c-dev" right={<ProvBadge kind="SIMULATED" />}>
        {!hasSim ? <Empty>No simulation running. Start one to see data.</Empty> : (
          <dl className="tq-kv">
            <dt>Sim time</dt><dd className="tq-num">{fmt(s.t, 0)} s</dd>
            <dt>Device safety state</dt>
            <dd>{s.device?.estop ? <Pill tone="stop">EMERGENCY STOP ({s.device.estop_reason})</Pill> : <Pill tone="ok">OK</Pill>}</dd>
            <dt>Setpoint</dt><dd className="tq-num">{fmt(s.device?.setpoint_rpm, 0)} rpm</dd>
            <dt>Speed</dt><dd className="tq-num">{fmt(w?.rpm, 0)} rpm</dd>
            <dt>Current</dt><dd className="tq-num">{fmt(w?.current, 2)} A</dd>
            <dt>Housing</dt><dd className="tq-num">{fmt(w?.housing, 1)} °C</dd>
            <dt>Vibration RMS</dt><dd className="tq-num">{fmt(w?.vib_rms, 3)} g</dd>
          </dl>
        )}
      </Card>

      <Card title="Incident" id="c-inc">
        {inc ? (
          <>
            <p><Pill tone={stateTone(inc.state)}>{inc.state.replaceAll('_', ' ')}</Pill> <span className="tq-muted">{inc.id}</span></p>
            <p className="tq-muted">Data requests {inc.data_requests} · tests run {inc.tests_run}</p>
          </>
        ) : <Empty>No active incident. {s.closed_incidents ? `${s.closed_incidents} closed.` : ''}</Empty>}
        {s.pending_approval && (
          <p role="alert"><Pill tone="wait">Awaiting human approval</Pill> {s.pending_approval.action} — see Decisions.</p>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ Live */
export function Live({ d }) {
  const t = d.telemetry?.samples || [];
  if (!t.length) return <Card title="Live telemetry" id="c-live"><Empty>No telemetry yet. Start a simulation.</Empty></Card>;
  const data = t.map((x) => ({ ...x, score: x.score == null || x.score <= 0 ? null : Number(x.score.toFixed(3)) }));
  const anomalous = data.filter((x) => x.score != null && x.score > 1).length;
  return (
    <div className="tq-grid">
      <Card title="Speed" id="c-rpm" right={<ProvBadge kind="SIMULATED" />}>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data}><CartesianGrid stroke="var(--tq-border)" /><XAxis dataKey="t" minTickGap={28} tickFormatter={(x) => `${Math.round(x)}s`} /><YAxis />
            <Tooltip /><Legend /><Line dataKey="rpm" stroke="var(--tq-text)" dot={false} isAnimationActive={false} name="rpm (sim)" />
            <Line dataKey="setpoint" stroke="var(--tq-accent)" strokeDasharray="4 3" dot={false} isAnimationActive={false} name="setpoint" />
          </LineChart>
        </ResponsiveContainer>
      </Card>
      <Card title="Anomaly score ÷ learned threshold (log scale)" id="c-score" right={<ProvBadge kind="DERIVED" />}>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data}><CartesianGrid stroke="var(--tq-border)" /><XAxis dataKey="t" minTickGap={28} tickFormatter={(x) => `${Math.round(x)}s`} />
            <YAxis scale="log" domain={[0.05, 'auto']} allowDataOverflow tickFormatter={(x) => (x >= 1 ? x.toFixed(0) : x.toFixed(2))} />
            <Tooltip /><Legend /><ReferenceLine y={1} stroke="var(--tq-crit)" strokeDasharray="4 3" label={{ value: 'threshold = 1', position: 'insideTopRight', fill: 'var(--tq-crit)', fontSize: 11 }} />
            <Line dataKey="score" stroke="var(--tq-learning)" dot={false} isAnimationActive={false} connectNulls={false} name="score ratio" />
          </LineChart>
        </ResponsiveContainer>
        <p className="tq-muted">Gaps = windows excluded (speed changing) or operating point not learned. {anomalous} of {data.length} windows above threshold.</p>
      </Card>
      <Card title="Housing temperature and vibration" id="c-th" right={<ProvBadge kind="SIMULATED" />}>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data}><CartesianGrid stroke="var(--tq-border)" /><XAxis dataKey="t" minTickGap={28} tickFormatter={(x) => `${Math.round(x)}s`} /><YAxis yAxisId="a" /><YAxis yAxisId="b" orientation="right" />
            <Tooltip /><Legend /><Line yAxisId="a" dataKey="housing" stroke="var(--tq-warn)" dot={false} isAnimationActive={false} name="housing °C" />
            <Line yAxisId="b" dataKey="vib_rms" stroke="var(--tq-accent)" dot={false} isAnimationActive={false} name="vibration g" />
          </LineChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ Investigation */
export function Investigation({ d }) {
  const hyp = lastOf(d.log, 'hypotheses');
  const gate = [...(d.decisions || [])].reverse().find((x) => x.inputs);
  const test = lastOf(d.log, 'test_result');
  const inc = (d.incidents || []).slice(-1)[0];
  return (
    <div className="tq-grid">
      <Card title="Fault hypotheses" id="c-hyp" right={<ProvBadge kind="DERIVED" />}>
        <PosteriorBars ranked={hyp?.ranked} label={hyp?.label} />
        <p className="tq-muted">Learned class signatures over C1 anomaly features. Bearing faults are not diagnosable with this sensor set.</p>
      </Card>
      <Card title="Decision gate (C3)" id="c-gate">
        {!gate ? <Empty>The gate has not evaluated yet.</Empty> : (
          <>
            <p><Pill tone={gate.verdict === 'ACT' ? 'ok' : gate.verdict === 'SAFE_STOP' ? 'stop' : 'warn'}>{gate.verdict.replaceAll('_', ' ')}</Pill></p>
            <p>{gate.reason}</p>
            <table className="tq-table"><caption className="tq-sr">Gate inputs</caption><tbody>
              {Object.entries(gate.inputs).map(([k, v]) => (<tr key={k}><th scope="row">{k.replaceAll('_', ' ')}</th><td className="tq-num">{String(v)}</td></tr>))}
            </tbody></table>
          </>
        )}
      </Card>
      <Card title="Diagnostic test result (C4)" id="c-test">
        {!test ? <Empty>No diagnostic test has been run in this incident.</Empty> : (
          <>
            <p><strong>{test.test}</strong> observation <span className="tq-num">{test.obs.map((x) => x.toFixed(2)).join(', ')}</span></p>
            <PosteriorBars ranked={test.posterior} label="after test" />
          </>
        )}
      </Card>
      <Card title="State history" id="c-hist">
        {!inc ? <Empty>No incident yet.</Empty> : (
          <ol className="tq-timeline">{inc.history.map((h, i) => (<li key={i}><span className="tq-muted">{h[0].replaceAll('_', ' ')}</span> → <strong>{h[2].replaceAll('_', ' ')}</strong> <span className="tq-muted">({h[1]})</span></li>))}</ol>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ Decisions */
export function Decisions({ d, role, actions, error }) {
  const s = d.status || {};
  const pend = s.pending_approval;
  const preds = (d.predictions || []).slice(-3);
  const sup = (d.log || []).filter((l) => l.kind === 'supervisor').slice(-8).reverse();
  const cmds = (d.commands || []).slice(-8).reverse();
  return (
    <div className="tq-grid">
      <Card title="Predicted outcomes of each action (C2)" id="c-pred" right={<ProvBadge kind="PREDICTED" />}>
        <p className="tq-label-unvalidated"><Pill tone="warn">{s.models?.c2_label || 'Intervention Outcome Prediction (unvalidated)'}</Pill>
          <span className="tq-muted"> Not yet validated against repeated physical experiments. A prediction is never evidence of recovery.</span></p>
        {!preds.length ? <Empty>No predictions yet.</Empty> : (
          <table className="tq-table"><thead><tr><th scope="col">Action</th><th scope="col">Risk of crossing a limit</th>
            <th scope="col">Speed @120 s</th><th scope="col">Vibration @120 s (90% interval)</th><th scope="col">Housing @120 s (90% interval)</th></tr></thead>
            <tbody>{preds.map((p) => (<tr key={p.action}>
              <td>{p.action.replaceAll('_', ' ')}</td><td className="tq-num">{fmt(p.risk * 100, 0)}%</td>
              <td className="tq-num">{fmt(p.mean_at_30_60_120.rpm[2], 0)} rpm</td>
              <td className="tq-num">{fmt(p.mean_at_30_60_120.vib_rms[2], 3)} g ({fmt(p.lo_120.vib_rms, 3)}–{fmt(p.hi_120.vib_rms, 3)})</td>
              <td className="tq-num">{fmt(p.mean_at_30_60_120.housing[2], 1)} °C ({fmt(p.lo_120.housing, 1)}–{fmt(p.hi_120.housing, 1)})</td></tr>))}</tbody></table>
        )}
      </Card>

      <Card title="Awaiting your decision" id="c-appr">
        {!pend ? <Empty>No action is waiting for approval.</Empty> : (
          <>
            <p><Pill tone="wait">{pend.action.replaceAll('_', ' ')}</Pill> <span className="tq-num">{JSON.stringify(pend.params)}</span></p>
            <p>{pend.rationale}</p>
            <div className="tq-row">
              <button className="tq-btn" onClick={actions.approve} disabled={!canControl(role)}><Check size={14} aria-hidden="true" /> Approve</button>
              <button className="tq-btn" onClick={actions.reject} disabled={!canControl(role)}><X size={14} aria-hidden="true" /> Reject</button>
            </div>
            {!canControl(role) && <p className="tq-muted">Approving requires role operator or admin.</p>}
          </>
        )}
        <ErrorBox error={error} />
      </Card>

      <Card title="Safety supervisor decisions" id="c-sup">
        {!sup.length ? <Empty>No decisions yet.</Empty> : (
          <ul className="tq-list">{sup.map((x, i) => (<li key={i}>
            <Pill tone={x.verdict === 'ALLOW' ? 'ok' : x.verdict === 'DEFER' ? 'wait' : 'crit'}>{x.verdict}</Pill> {x.action.replaceAll('_', ' ')}
            <span className="tq-muted"> — {x.reasons.join(', ').replaceAll('_', ' ')}</span></li>))}</ul>
        )}
      </Card>

      <Card title="Commands and device acknowledgements" id="c-cmd">
        {!cmds.length ? <Empty>No commands sent.</Empty> : (
          <table className="tq-table"><thead><tr><th scope="col">#</th><th scope="col">Action</th><th scope="col">Device status</th><th scope="col">Took effect</th></tr></thead>
            <tbody>{cmds.filter((c) => c.action !== 'HEARTBEAT').map((c) => (<tr key={c.session + c.id}>
              <td className="tq-num">{c.id}</td><td>{c.action}</td>
              <td><Pill tone={['ACCEPTED', 'COMPLETED'].includes(c.status) ? 'ok' : c.status === 'PENDING' ? 'wait' : 'crit'}>{c.status}</Pill> {c.reason && <span className="tq-muted">{c.reason}</span>}</td>
              <td>{c.counts_as_executed ? 'yes (acknowledged by device)' : 'no'}</td></tr>))}</tbody></table>
        )}
        <p className="tq-muted">An HTTP 200 only means a command was dispatched. Only a device acknowledgement counts.</p>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ Recovery */
export function Recovery({ d }) {
  const outs = (d.outcomes || []).slice().reverse();
  const s = d.status || {};
  const verifying = s.incident?.state === 'VERIFYING_RECOVERY';
  return (
    <div className="tq-grid">
      {verifying && <Card title="Verifying recovery" id="c-ver"><Pill tone="wait">collecting fresh samples</Pill>
        <p className="tq-muted">Recovery is declared only from fresh, valid samples measured after the device acknowledged the action.</p></Card>}
      <Card title="Outcomes" id="c-out">
        {!outs.length ? <Empty>No incident has been verified yet.</Empty> : outs.map((o) => (
          <article key={o.incident} className="tq-outcome">
            <h4>{o.incident}{' '}<Pill tone={o.outcome === 'RECOVERED' ? 'ok' : o.outcome === 'UNRESOLVED' ? 'crit' : 'warn'}>{o.outcome.replaceAll('_', ' ')}</Pill>{' '}<ProvBadge kind="SIMULATED" /></h4>
            <p>Action: <strong>{o.action || '—'}</strong> · device confirmed: {o.command_executed ? 'yes' : 'no'} · fresh samples: <span className="tq-num">{o.n_fresh}</span></p>
            <p className="tq-muted">Reason: {o.reasons.join(', ').replaceAll('_', ' ')}</p>
            {Object.keys(o.criteria || {}).length > 0 && (
              <ul className="tq-list">{Object.entries(o.criteria).map(([k, v]) => (<li key={k}><Pill tone={v ? 'ok' : 'crit'}>{v ? 'pass' : 'fail'}</Pill> {k.replaceAll('_', ' ')}</li>))}</ul>)}
            {o.observed && o.observed.rpm !== undefined && (<p className="tq-muted">Observed (not predicted): {fmt(o.observed.rpm, 0)} rpm, {fmt(o.observed.housing, 1)} °C, {fmt(o.observed.frac_in_band * 100, 0)}% of windows in learned band.</p>)}
          </article>))}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ Evaluation / Learning */
export function Evaluation({ d, evalRun, evalError }) {
  const r = evalRun?.run;
  const cases = d.cases || [];
  return (
    <div className="tq-grid">
      <Card title="Evaluation run" id="c-eval" right={<ProvBadge kind="SIMULATED" />}>
        {evalError && !r && <Empty>No evaluation run available ({String(evalError.message)}).</Empty>}
        {r && (
          <>
            <p role="note" className="tq-warnbox">{r.WARNING}</p>
            <p className="tq-muted">File {evalRun.file} · git {r.git_sha} · config {r.config_hash}. Measured hardware data: <strong>{r.measured.status}</strong>.</p>
            <table className="tq-table"><caption className="tq-sr">Headline simulation results</caption><tbody>
              <tr><th scope="row">C1 healthy window false-alarm rate</th><td className="tq-num">{fmt(r.c1.healthy.c1.window_false_alarm_rate * 100, 2)}%</td></tr>
              <tr><th scope="row">Hypothesis top-1 accuracy (random {fmt(r.hypotheses.random_baseline * 100, 0)}%)</th><td className="tq-num">{fmt(r.hypotheses.top1_accuracy * 100, 1)}%</td></tr>
              <tr><th scope="row">False-confident hypothesis rate</th><td className="tq-num">{fmt(r.hypotheses.false_confident_rate * 100, 1)}%</td></tr>
              <tr><th scope="row">C2 interval coverage (target {fmt(r.c2.coverage_target * 100, 0)}%) mean / worst</th><td className="tq-num">{fmt(r.c2.coverage_mean * 100, 0)}% / {fmt(r.c2.coverage_min * 100, 0)}%</td></tr>
              <tr><th scope="row">C2 validated by intervention experiments</th><td>{r.c2.validated_by_intervention_experiments ? 'yes' : 'no'}</td></tr>
              <tr><th scope="row">False recovery declarations</th><td className="tq-num">{r.c5.FALSE_RECOVERY_DECLARATIONS} of {r.c5.cases} cases</td></tr>
            </tbody></table>
          </>)}
      </Card>
      <Card title="Learning dataset" id="c-learn">
        {!cases.length ? <Empty>No eligible cases recorded in this run. Blocked, rejected or aborted actions never count.</Empty> : (
          <ul className="tq-list">{cases.map((c) => (<li key={c.label + c.outcome + c.session}><strong>{c.label}</strong> · {c.outcome} · label source {c.label_source} · executed {String(c.executed)} <ProvBadge kind="SIMULATED" /></li>))}</ul>)}
        <p className="tq-muted">Model promotion, rollback and the training registry are implemented in the backend (C6) and not yet exposed here.</p>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ Audit */
export function Audit({ rows, error, role }) {
  if (role !== 'admin') return <Card title="Audit history" id="c-aud"><Empty>The audit log is visible to admins only.</Empty></Card>;
  return (
    <Card title="Audit history (append-only)" id="c-aud">
      <ErrorBox error={error} />
      {!rows?.length ? <Empty>No audit events yet.</Empty> : (
        <table className="tq-table"><thead><tr><th scope="col">#</th><th scope="col">Kind</th><th scope="col">Actor</th><th scope="col">Detail</th></tr></thead>
          <tbody>{rows.slice(-60).reverse().map((r) => (<tr key={r.n}><td className="tq-num">{r.n}</td><td>{r.kind}</td><td>{r.actor}</td>
            <td className="tq-muted">{JSON.stringify(r.detail).slice(0, 140)}</td></tr>))}</tbody></table>)}
    </Card>
  );
}
