// Simulation Overview, laid out like the physical dashboard (page head → status strip → control panel + telemetry → detail), with the
// C1–C6 pipeline as its centrepiece. Every value is the simulator's own record; ground truth, AI output, prediction and observation are kept apart.
import React from 'react';
import { FlaskConical, Layers, Gauge, Thermometer, Waves, Zap, Siren, Activity, History, HeartPulse, LineChart, ArrowRight } from 'lucide-react';
import { Card, Empty, Pill, ProvBadge, fmt, stateTone, PageHead, StatTile, StatGrid, AlertPanel, LinkButton, MetricList, SourceTag, ConditionBanner } from '../shared/components.jsx';
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
  const T = (tone) => (tone === 'wait' ? 'warn' : tone === 'sim' ? 'info' : tone);     // StatTile tones
  return (
    <section className="tq-mon-status" data-testid="sim-status-strip" aria-label="Simulation status">
      <StatGrid label="Simulation status">
        <StatTile icon={FlaskConical} tone={T(life.tone)} label="Simulation" value={life.label} testid="sim-cell-life" sub={hasSim ? `simulation t = ${fmt(s.t, 0)} s` : life.detail} />
        <StatTile icon={Layers} tone={hasSim ? 'info' : 'off'} label="Scenario" value={hasSim ? scenarioText(sc) : 'none'} testid="sim-cell-scenario"
          sub={hasSim && sc.fault ? (injected ? `injected from t = ${sc.inject_after_s} s` : `scheduled at t = ${sc.inject_after_s} s`) : hasSim ? `seed ${sc.seed ?? '—'}` : 'start one in Scenario Studio'}>
          {hasSim && sc.human_approval_required && <span className="tq-mon-statpill"><Pill tone="wait">approval required</Pill></span>}
        </StatTile>
        <StatTile icon={Gauge} tone={!hasSim ? 'off' : s.device?.estop ? 'stop' : T(tel[0])} label="Simulated motor" value={tel[1]} testid="sim-cell-motor"
          sub={hasSim ? `setpoint ${fmt(s.device?.setpoint_rpm, 0)} rpm` : null}>
          {hasSim && <span className="tq-mon-statpill"><Pill tone={s.device?.estop ? 'stop' : 'ok'}>{s.device?.estop ? `simulated E-stop: ${title(s.device.estop_reason) || 'latched'}` : 'simulated E-stop clear'}</Pill></span>}
        </StatTile>
        <StatTile icon={Siren} tone={s.pending_approval ? 'warn' : inc ? T(stateTone(inc.state)) : hasSim ? 'ok' : 'off'} label="Incident" testid="sim-cell-incident"
          value={inc ? `${inc.id}: ${title(inc.state)}` : hasSim ? 'No open incident' : 'none'} sub={hasSim ? `${s.closed_incidents ?? 0} closed in this run` : null}>
          {s.pending_approval && <span className="tq-mon-statpill"><Pill tone="wait">{`awaiting approval: ${title(s.pending_approval.action)}`}</Pill></span>}
        </StatTile>
      </StatGrid>
    </section>
  );
}

/** The C1–C6 pipeline for the current incident, as a connected sequence of stages. Each stage opens its detailed page. */
export function PipelineView({ d, go }) {
  const { incident, stages } = pipelineStages(d);
  return (
    <Card title="Analysis progress" id="c-pipe" className="tq-pipe-card"
      right={<>{incident ? <Pill tone={incident.open ? stateTone(incident.state) : 'off'}>{incident.open ? `${incident.id} open` : `${incident.id} (last, closed)`}</Pill> : <Pill tone="off">no incident</Pill>}<ProvBadge kind="DERIVED" /></>}>
      <ol className="tq-pipe" aria-label="Pipeline stages" data-testid="pipeline">
        {stages.map((x, i) => (
          <li key={x.key} className={`tq-pipe-stage is-${x.state}`} data-testid={`stage-${x.key}`} data-state={x.state}>
            <button type="button" className="tq-pipe-btn" onClick={() => go(x.page)} aria-label={`Stage ${i + 1}, ${x.name}, ${STAGE_WORD[x.state]}: open details`} aria-describedby={`pipe-${x.key}`}>
              <span className="tq-pipe-top"><span className="tq-pipe-code">{i + 1}</span><span className="tq-pipe-dot" aria-hidden="true" /></span>
              <strong className="tq-pipe-name" id={`pipe-${x.key}`}>{x.name}</strong>
              <Pill tone={STAGE_TONE[x.state]}>{STAGE_WORD[x.state]}</Pill>
              <span className="tq-pipe-sum">{x.summary}</span>
              {x.t != null && <span className="tq-pipe-t tq-num">t = {fmt(x.t, 0)} s</span>}
            </button>
          </li>))}
      </ol>
      
    </Card>
  );
}

/** Overall condition of the simulated motor and the one next step, read only from the run's own records (status, incident, latest
 *  scored window). It never invents a state: anything it cannot judge reads Unavailable or Monitoring. */
export function simHealth(d, running, stale) {
  const s = d.status || {}; const w = s.last_window; const inc = s.incident; const pend = s.pending_approval;
  const samples = d.telemetry?.samples || []; const last = samples[samples.length - 1];
  if (stale) return { status: 'Unavailable', why: 'The backend is unreachable.', next: null };
  if (!hasSimOf(s)) return { status: 'Unavailable', why: 'No simulation is running.', next: ['scenario', 'Start a scenario in Scenario Studio'] };
  if (s.device?.estop) return { status: 'Critical', why: `The simulated E-stop is latched${s.device.estop_reason ? ` (${title(s.device.estop_reason)})` : ''}.`, next: ['interventions', 'Review Action Recommendations'] };
  if (w && w.valid === false) return { status: 'Unavailable', why: 'The latest simulated window is flagged invalid; its values are not shown as numbers.', next: ['live', 'Check the readings in Live Monitor'] };
  if (pend) return { status: 'Action Verification', why: `TORQVA recommends ${title(pend.action)}; it waits for your decision.`, next: ['interventions', 'Review the recommendation'] };
  if (inc?.state === 'VERIFYING_RECOVERY') return { status: 'Action Verification', why: `The action for ${inc.id} was acknowledged; recovery is being verified.`, next: ['recovery', 'Follow Recovery Verification'] };
  if (inc) return { status: 'Investigation Required', why: `Incident ${inc.id} is open: an anomaly persisted.`, next: ['workflow', 'Investigate with the Diagnostic Workflow'] };
  if (last && last.score != null && last.score > 1) return { status: 'Investigation Required', why: `Anomaly severity ${fmt(last.score, 2)} × threshold, not yet persistent.`, next: ['diagnostics', 'Review Anomaly Detection'] };
  if (!last || last.score == null) return { status: 'Unavailable', why: last ? `The latest reading is not scored yet (${title(last.score_status) || 'no score'}).` : 'Waiting for the first simulated reading.', next: running ? ['live', 'Watch Live Monitor'] : ['scenario', 'Run the simulation in Scenario Studio'] };
  return { status: 'Normal', why: `No anomaly (severity ${fmt(last.score, 2)} × threshold) and no open incident.`, next: running ? null : ['scenario', 'Run the simulation in Scenario Studio'] };
}

export function SimOverview({ d, go, running, stale }) {
  const s = d.status || {}; const w = s.last_window;
  const hasSim = hasSimOf(s);
  const life = lifecycle(d, running, stale);
  const invalid = w && w.valid === false;
  const val = (v) => (hasSim && w && !invalid && !stale ? v : null);           // an invalid or stale window is shown unavailable, never as a number
  const gate = [...(d.decisions || [])].reverse().find((x) => x.inputs);
  const inc = s.incident;
  const h = simHealth(d, running, stale);
  const all = d.predictions || [];
  const latestAt = all.length ? all[all.length - 1].predicted_at : null;
  const preds = all.filter((p) => p.predicted_at === latestAt).slice().sort((a, b) => (a.risk ?? 1) - (b.risk ?? 1));
  return (
    <>
      <PageHead title="Overview"
        right={<><ProvBadge kind="SIMULATED" /><Pill tone={life.tone}>{life.label}</Pill></>} />
      <ConditionBanner c={h} go={go} />
      <SimStatusStrip d={d} running={running} stale={stale} />

      <div className="tq-mon-ovgrid tq-mon-ovgrid--even">
        <Card title="Key readings" id="c-simtel" icon={Activity} right={<SourceTag kind={stale ? 'STALE' : 'SIMULATED'} />} sub={hasSim && w ? `Latest one-second window · t = ${fmt(w.t, 0)} s` : 'No simulated window yet'}
          foot={<LinkButton onClick={() => go('live')}>Trends and all readings in Live Monitor</LinkButton>}>
          <MetricList label="Key simulated readings" testid="sim-kpis" items={[
            { key: 'rpm', label: 'Speed', icon: Gauge, value: val(w?.rpm) == null ? null : fmt(w.rpm, 0), unit: 'rpm', prov: 'SIMULATED' },
            { key: 'cur', label: 'Current', icon: Zap, value: val(w?.current) == null ? null : fmt(w.current, 2), unit: 'A', prov: 'SIMULATED' },
            { key: 'hous', label: 'Housing temperature', icon: Thermometer, value: val(w?.housing) == null ? null : fmt(w.housing, 1), unit: '°C', prov: 'SIMULATED' },
            { key: 'vib', label: 'Vibration RMS', icon: Waves, value: val(w?.vib_rms) == null ? null : fmt(w.vib_rms, 3), unit: 'g', prov: 'SIMULATED' },
          ].map((m) => ({ ...m, missingText: 'UNAVAILABLE' }))} />
        </Card>
        <Card title="Predicted risk" id="c-ov-risk" icon={LineChart} right={<ProvBadge kind="PREDICTED" />} sub={preds.length ? `Latest comparison · predicted at t = ${fmt(latestAt, 0)} s` : 'No prediction in this run yet'}
          foot={<LinkButton onClick={() => go('predictions')}>Compare actions in Failure Prediction</LinkButton>}>
          {!preds.length ? <Empty>Predictions are made when an incident reaches action evaluation. A prediction is a model estimate, never a measurement.</Empty> : (
            <MetricList label="Predicted risk of crossing a limit, by action" testid="ov-risk" items={preds.map((p) => ({ key: p.action, label: title(p.action), value: p.risk == null ? null : fmt(p.risk * 100, 0), unit: '%', prov: 'PREDICTED' }))} />)}
        </Card>
      </div>

      <PipelineView d={d} go={go} />

      <div className="tq-mon-ovgrid tq-mon-ovgrid--even">
        <Card title={inc ? `Active incident ${inc.id}` : 'Active incident'} id="c-inc" icon={Siren} right={inc ? <Pill tone={stateTone(inc.state)}>{title(inc.state)}</Pill> : null}
          foot={<LinkButton onClick={() => go('recovery')}>Open the incident story</LinkButton>}>
          {!hasSim ? <Empty>No simulation is running.</Empty> : !inc ? <Empty>No open incident. {s.closed_incidents ? `${s.closed_incidents} closed in this run; see Recovery Verification for their story.` : 'Anomaly Detection opens one when an anomaly persists.'}</Empty> : (
            <MetricList label="Incident" items={[
              { key: 'tests', label: 'Diagnostic tests run', value: inc.tests_run },
              { key: 'req', label: 'Extra data requests', value: inc.data_requests },
            ]} />)}
          {gate && inc && <p className="tq-small">Latest recommendation check: <Pill tone={gate.verdict === 'ACT' ? 'ok' : gate.verdict === 'SAFE_STOP' ? 'stop' : 'warn'}>{title(gate.verdict)}</Pill> <span className="tq-muted">{gate.reason}</span></p>}
        </Card>
        <Card title="Recent activity" id="c-events" icon={History} right={<ProvBadge kind="SIMULATED" />} foot={<LinkButton onClick={() => go('live')}>Full event timeline in Live Monitor</LinkButton>}>
          <EventTimeline log={d.log} limit={6} />
        </Card>
      </div>
    </>
  );
}
