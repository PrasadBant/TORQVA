// Simulation Overview, laid out like the physical dashboard (page head → status strip → control panel + telemetry → detail), with the
// C1–C6 pipeline as its centrepiece. Every value is the simulator's own record; ground truth, AI output, prediction and observation are kept apart.
import React from 'react';
import { FlaskConical, Layers, Gauge, Thermometer, Waves, Zap, Plug, Box, Siren } from 'lucide-react';
import { Card, Empty, Pill, ProvBadge, fmt, stateTone, PageHead, CardLink, SummaryCell } from '../shared/components.jsx';
import { TrendLines } from '../shared/lazyCharts.jsx';
import { Kpi } from './pages.jsx';
import { ScenarioStudio } from './scenario.jsx';
import { lifecycle, scenarioText, pipelineStages, hasSimOf, title, STAGE_TONE, STAGE_WORD } from './pipeline.js';
import { EventTimeline } from './events.jsx';

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** The physical dashboard's status strip, with simulation fields. Nothing here describes a board, a hardware E-stop or firmware. */
export function SimStatusStrip({ d, running, stale }) {
  const s = d.status || {}; const hasSim = hasSimOf(s); const sc = s.scenario || {};
  const life = lifecycle(d, running, stale);
  const w = s.last_window;
  const tel = stale ? ['crit', 'stale: backend unreachable'] : !hasSim || !w ? ['off', 'no telemetry'] : w.valid === false ? ['warn', 'latest window invalid'] : ['ok', 'live (simulated)'];
  const injected = sc.fault && finite(s.t) && finite(sc.inject_after_s) ? s.t >= sc.inject_after_s : null;
  const inc = s.incident;
  return (
    <div className="tq-status-strip tq-status-v2" data-testid="sim-status-strip">
      <div className="tq-summary" aria-label="Simulation status">
        <SummaryCell icon={FlaskConical} tone={life.tone} label="Simulation" testid="sim-cell-life" meta={hasSim ? `simulation t = ${fmt(s.t, 0)} s` : null}>
          <Pill tone={life.tone}>{life.label}</Pill>
        </SummaryCell>
        <SummaryCell icon={Layers} tone={hasSim ? (sc.fault ? 'sim' : 'ok') : 'off'} label="Scenario" testid="sim-cell-scenario"
          meta={hasSim && sc.fault ? (injected ? `injected from t = ${sc.inject_after_s} s` : `scheduled at t = ${sc.inject_after_s} s`) : hasSim ? `seed ${sc.seed ?? '—'}` : null}>
          <Pill tone={hasSim ? 'info' : 'off'}>{hasSim ? scenarioText(sc) : 'none'}</Pill>
          {hasSim && sc.human_approval_required && <Pill tone="wait">approval required</Pill>}
        </SummaryCell>
        <SummaryCell icon={Gauge} tone={!hasSim ? 'off' : s.device?.estop ? 'stop' : 'ok'} label="Simulated motor" testid="sim-cell-motor"
          meta={hasSim ? `setpoint ${fmt(s.device?.setpoint_rpm, 0)} rpm` : null}>
          <Pill tone={tel[0]}>{tel[1]}</Pill>
          {hasSim && <Pill tone={s.device?.estop ? 'stop' : 'ok'}>{s.device?.estop ? `simulated E-stop: ${title(s.device.estop_reason) || 'latched'}` : 'simulated E-stop clear'}</Pill>}
        </SummaryCell>
        <SummaryCell icon={Siren} tone={s.pending_approval ? 'wait' : inc ? stateTone(inc.state) : hasSim ? 'ok' : 'off'} label="Incident" testid="sim-cell-incident"
          meta={hasSim ? `${s.closed_incidents ?? 0} closed in this run` : null}>
          <Pill tone={inc ? stateTone(inc.state) : hasSim ? 'ok' : 'off'}>{inc ? `${inc.id}: ${title(inc.state)}` : hasSim ? 'no open incident' : 'none'}</Pill>
          {s.pending_approval && <Pill tone="wait">{`awaiting approval: ${title(s.pending_approval.action)}`}</Pill>}
        </SummaryCell>
      </div>
    </div>
  );
}

/** The C1–C6 pipeline for the current incident, as a connected sequence of stages. Each stage opens its detailed page. */
export function PipelineView({ d, go }) {
  const { incident, stages } = pipelineStages(d);
  return (
    <Card title="AI diagnostic pipeline" id="c-pipe" className="tq-pipe-card"
      right={<>{incident ? <Pill tone={incident.open ? stateTone(incident.state) : 'off'}>{incident.open ? `${incident.id} open` : `${incident.id} (last, closed)`}</Pill> : <Pill tone="off">no incident</Pill>}<ProvBadge kind="DERIVED" /></>}>
      <ol className="tq-pipe" aria-label="Pipeline stages" data-testid="pipeline">
        {stages.map((x) => (
          <li key={x.key} className={`tq-pipe-stage is-${x.state}`} data-testid={`stage-${x.key}`} data-state={x.state}>
            <button type="button" className="tq-pipe-btn" onClick={() => go(x.page)} aria-label={`Stage ${x.code}, ${STAGE_WORD[x.state]}: open details`} aria-describedby={`pipe-${x.key}`}>
              <span className="tq-pipe-top"><span className="tq-pipe-code">{x.code}</span><span className="tq-pipe-dot" aria-hidden="true" /></span>
              <strong className="tq-pipe-name" id={`pipe-${x.key}`}>{x.name}</strong>
              <Pill tone={STAGE_TONE[x.state]}>{STAGE_WORD[x.state]}</Pill>
              <span className="tq-pipe-sum">{x.summary}</span>
              {x.t != null && <span className="tq-pipe-t tq-num">t = {fmt(x.t, 0)} s</span>}
            </button>
          </li>))}
      </ol>
      <p className="tq-chart-note">States come from the backend's log, decisions and outcomes for {incident ? `incident ${incident.id}` : 'this run'}; a stage that has not run says so. H (hypothesis ranking) sits between C1 and C2 and is not a C layer.</p>
    </Card>
  );
}

const TREND = [
  ['rpm', 'Speed', 'rpm', 0, [{ key: 'rpm', name: 'speed (sim)', color: 'var(--tq-chart-ink)' }, { key: 'setpoint', name: 'setpoint', color: 'var(--tq-chart-1)', dash: '4 3' }]],
  ['housing', 'Housing temperature', '°C', 1, [{ key: 'housing', name: 'housing °C', color: 'var(--tq-chart-2)' }]],
  ['vib', 'Vibration RMS', 'g', 3, [{ key: 'vib_rms', name: 'vibration g', color: 'var(--tq-chart-3)' }]],
  ['cur', 'Motor current', 'A', 2, [{ key: 'current', name: 'current A', color: 'var(--tq-chart-4)' }]],
];

export function SimOverview({ d, role, go, actions, running, setRunning, busy, error, stale, stepSeconds }) {
  const s = d.status || {}; const w = s.last_window; const t = d.telemetry?.samples || [];
  const hasSim = hasSimOf(s);
  const life = lifecycle(d, running, stale);
  const tail = t.slice(-60);
  const V = w?.voltage, I = w?.current;
  const power = finite(V) && finite(I) ? V * I : null;
  const invalid = w && w.valid === false;
  const val = (v) => (hasSim && w && !invalid ? v : null);           // an invalid simulated window is shown unavailable, never as a number
  const fresh = !hasSim || !w ? null : stale ? { state: 'stale', text: `STALE · t = ${fmt(w.t, 0)} s` } : invalid ? { state: 'invalid', text: 'window invalid' } : { state: 'live', text: `t = ${fmt(w.t, 0)} s` };
  const gate = [...(d.decisions || [])].reverse().find((x) => x.inputs);
  const inc = s.incident;
  const pend = s.pending_approval;
  return (
    <>
      <PageHead title="Simulation Overview" sub="Virtual motor, controlled fault scenarios and the C1–C6 pipeline on the backend's software simulator. Not hardware evidence."
        right={<><ProvBadge kind="SIMULATED" /><Pill tone={hasSim ? 'info' : 'off'}>{hasSim ? scenarioText(s.scenario) : 'no scenario'}</Pill><Pill tone={life.tone}>{life.label}</Pill></>} />
      <SimStatusStrip d={d} running={running} stale={stale} />
      {invalid && <p className="tq-callout crit" role="alert">The latest simulated window is flagged invalid, so its values are shown as unavailable.</p>}

      <div className="tq-split tq-sim-main">
        <ScenarioStudio d={d} role={role} actions={actions} running={running} setRunning={setRunning} busy={busy} error={error} stale={stale} stepSeconds={stepSeconds} />
        <Card title="Simulated Telemetry" id="c-simtel" right={<ProvBadge kind="SIMULATED" />}>
          <div className="tq-kpis" aria-label="Latest simulated telemetry" data-testid="sim-kpis">
            <Kpi label="Speed" icon={Gauge} value={val(w?.rpm)} unit="rpm" digits={0} data={tail} dataKey="rpm" prov="SIMULATED" fresh={fresh} />
            <Kpi label="Current" icon={Zap} value={val(I)} unit="A" digits={2} data={tail} dataKey="current" prov="SIMULATED" color="var(--tq-chart-4)" fresh={fresh} />
            <Kpi label="Housing temperature" icon={Thermometer} value={val(w?.housing)} unit="°C" data={tail} dataKey="housing" prov="SIMULATED" color="var(--tq-chart-2)" fresh={fresh} />
            <Kpi label="Supply voltage" icon={Plug} value={val(V)} unit="V" digits={2} data={tail} dataKey="voltage" prov="SIMULATED" color="var(--tq-chart-3)" fresh={fresh} />
            <Kpi label="Power (V × I)" icon={Zap} value={val(power)} unit="W" digits={1} prov="DERIVED" fresh={fresh} />
            <Kpi label="Vibration RMS" icon={Waves} value={val(w?.vib_rms)} unit="g" digits={3} data={tail} dataKey="vib_rms" prov="SIMULATED" color="var(--tq-chart-3)" fresh={fresh} />
          </div>
          <p className="tq-chart-note">The simulator's vibration model reports RMS directly; the physical board reports raw acceleration. Power is voltage × current of the same window, computed for display.</p>
          <CardLink onClick={() => go('twin')}><Box size={14} aria-hidden="true" /> Inspect the motor in 3D</CardLink>
        </Card>
      </div>

      <PipelineView d={d} go={go} />

      <div className="tq-split">
        <Card title="Active incident" id="c-inc" right={inc ? <Pill tone={stateTone(inc.state)}>{title(inc.state)}</Pill> : null}>
          {!hasSim ? <Empty>No simulation is running.</Empty> : !inc ? <Empty>No open incident. {s.closed_incidents ? `${s.closed_incidents} closed in this run; see Recovery for their story.` : 'C1 opens one when an anomaly persists.'}</Empty> : (
            <dl className="tq-kv">
              <dt>Incident</dt><dd>{inc.id}</dd>
              <dt>State</dt><dd><Pill tone={stateTone(inc.state)}>{title(inc.state)}</Pill></dd>
              <dt>Diagnostic tests run</dt><dd className="tq-num">{inc.tests_run ?? 0}</dd>
              <dt>Extra data requests</dt><dd className="tq-num">{inc.data_requests ?? 0}</dd>
              {gate && <><dt>Latest gate verdict</dt><dd><Pill tone={gate.verdict === 'ACT' ? 'ok' : gate.verdict === 'SAFE_STOP' ? 'stop' : 'warn'}>{title(gate.verdict)}</Pill> <span className="tq-muted">{gate.reason}</span></dd></>}
            </dl>)}
          {pend && (
            <div className="tq-callout wait" role="status" data-testid="sim-pending">
              <strong>Awaiting human approval: {title(pend.action)}</strong>
              <p>{pend.rationale}</p>
              <button type="button" className="tq-btn tq-primary" onClick={() => go('interventions')}>Review in Interventions</button>
            </div>)}
          <p className="tq-muted">A recommendation is never an executed action; only a simulated-device acknowledgement counts, and only C5 declares recovery.</p>
          <CardLink onClick={() => go('recovery')}>Open the incident story</CardLink>
        </Card>
        <Card title="Recent events" id="c-events" right={<ProvBadge kind="SIMULATED" />}>
          <EventTimeline log={d.log} limit={8} />
        </Card>
      </div>

      {t.length > 1 && (
        <div className="tq-mt">
          <details className="tq-disclosure" data-testid="sim-trends">
            <summary>Telemetry Trend History</summary>
            <div className="tq-disclosure-body">
              <div className="tq-grid tq-grid-2">
                {TREND.map(([k, name, unit, digits, lines]) => (
                  <Card key={k} title={name} id={`c-tr-${k}`} right={<ProvBadge kind="SIMULATED" />}>
                    <div role="img" aria-label={`${name} over simulation time`} className="tq-chart"><TrendLines data={t} lines={lines} height={180} digits={digits} unit={unit} /></div>
                  </Card>))}
              </div>
              <p className="tq-chart-note">Last {t.length} simulated seconds.</p>
            </div>
          </details>
        </div>)}
    </>
  );
}
