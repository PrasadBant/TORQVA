// Evidence-to-action trace (simulation): Observation → Hypothesis → Diagnostic test → Prediction → Safety decision → Outcome for one
// incident, built by the backend from the run's own log and stored records (GET /simulation/workbench/trace). Every event names the record it
// came from; a stage with no record is shown as not reached, never filled in. Refreshed when the run's log grows, not on a timer.
import React, { useEffect, useRef, useState } from 'react';
import { Eye, GitBranch, FlaskConical, LineChart, ShieldCheck, Flag } from 'lucide-react';
import { api } from '../api.js';
import { Card, Empty, Pill, ProvBadge, fmt } from '../shared/components.jsx';
import { title } from './workbench.js';

const META = {
  observation: ['Observation', Eye], hypothesis: ['Hypothesis', GitBranch], test: ['Diagnostic test', FlaskConical],
  prediction: ['Prediction', LineChart], decision: ['Safety decision', ShieldCheck], outcome: ['Outcome', Flag],
};
const src = (s) => (s.record === 'log' ? `log entry #${s.index}` : `${s.record} record ${s.key ?? ''}`.trim());

function Value({ v }) {
  if (v === null || v === undefined) return <span className="tq-muted">—</span>;
  if (typeof v === 'number') return <span className="tq-num">{Number.isInteger(v) ? v : fmt(v, 3)}</span>;
  if (typeof v === 'boolean') return <span>{v ? 'yes' : 'no'}</span>;
  if (typeof v === 'string') return <span>{v}</span>;
  if (Array.isArray(v) && v.every((x) => Array.isArray(x) && x.length === 2)) return <span>{v.map(([a, b]) => `${title(a)} ${typeof b === 'number' ? fmt(b, 2) : b}`).join(' · ')}</span>;
  return <code className="tq-trace-json">{JSON.stringify(v)}</code>;
}

export function InvestigationTrace({ d, focus = [] }) {
  const [tr, setTr] = useState(null);
  const [err, setErr] = useState(null);
  const [stage, setStage] = useState(focus[0] || 'observation');
  const [open, setOpen] = useState(null);
  const [inc, setInc] = useState(null);
  const n = (d.log || []).length;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const hasSim = d.status?.t !== undefined && d.status?.t !== null;
  useEffect(() => {
    if (!hasSim) return undefined;
    const id = setTimeout(() => { api.wbTrace(inc).then((r) => { if (alive.current) { setTr(r); setErr(null); } }).catch((e) => { if (alive.current) setErr(e.message || String(e)); }); }, 300);
    return () => clearTimeout(id);
  }, [n, inc, hasSim]);
  const st = tr?.stages?.find((s) => s.stage === stage);
  return (
    <Card title="Investigation trace" id="c-trace" right={<>{tr?.incident && <Pill tone={tr.open ? 'wait' : 'off'}>{tr.open ? `${tr.incident} open` : tr.incident}</Pill>}<ProvBadge kind="SIMULATED" /></>}>
      {!hasSim ? <Empty>No simulation is running.</Empty> : err ? <p className="tq-muted">The trace could not be loaded: {err}</p> : !tr ? <Empty loading>Loading the trace…</Empty> : !tr.incident ? <Empty>{tr.note}</Empty> : (
        <>
          {tr.incidents.length > 1 && <label className="tq-inline">Incident <select value={tr.incident} onChange={(e) => { setInc(e.target.value); setOpen(null); }}>{tr.incidents.map((x) => <option key={x}>{x}</option>)}</select></label>}
          <ol className="tq-tracebar" aria-label="Investigation stages" data-testid="trace">
            {tr.stages.map((s) => {
              const [name, I] = META[s.stage];
              return (
                <li key={s.stage}>
                  <button type="button" className={`tq-trace-stage ${s.reached ? 'is-reached' : ''} ${focus.includes(s.stage) ? 'is-focus' : ''}`} aria-pressed={stage === s.stage}
                    onClick={() => { setStage(s.stage); setOpen(null); }} data-testid={`trace-${s.stage}`} data-reached={s.reached ? 'yes' : 'no'}>
                    <I size={15} aria-hidden="true" /><span>{name}</span><span className="tq-trace-n tq-num">{s.events.length}</span>
                  </button>
                </li>);
            })}
          </ol>
          {!st?.events.length ? <Empty>{`No ${META[stage][0].toLowerCase()} record in this incident yet.`}</Empty> : (
            <ul className="tq-trace-events" data-testid="trace-events">
              {st.events.map((e, i) => (
                <li key={`${e.kind}-${i}`}>
                  <button type="button" className="tq-trace-ev" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                    <span className="tq-ev-t tq-num">{e.t === null || e.t === undefined ? '—' : `${fmt(e.t, 0)} s`}</span><span className="tq-ev-text">{e.label}</span><span className="tq-ev-inc">{src(e.source)}</span>
                  </button>
                  {open === i && (
                    <dl className="tq-kv tq-ev-kv" data-testid="trace-detail">
                      <dt>Source</dt><dd>{src(e.source)}</dd>
                      {Object.entries(e.data || {}).filter(([k]) => !['t', 'incident'].includes(k)).map(([k, v]) => (
                        k === 'window' && v ? <React.Fragment key={k}><dt>Window at that time</dt><dd>{`${fmt(v.rpm, 0)} rpm · ${fmt(v.current, 2)} A · ${fmt(v.housing, 1)} °C · ${fmt(v.vib_rms, 3)} g · C1 ${v.c1_score_over_threshold === null ? title(v.c1_status) : `${fmt(v.c1_score_over_threshold, 2)} × threshold`} · ${v.valid ? 'valid' : 'invalid'} (SIM)`}</dd></React.Fragment>
                          : <React.Fragment key={k}><dt>{title(k)}</dt><dd><Value v={v} /></dd></React.Fragment>))}
                    </dl>)}
                </li>))}
            </ul>)}
          <p className="tq-chart-note">{tr.note}</p>
        </>)}
    </Card>
  );
}
