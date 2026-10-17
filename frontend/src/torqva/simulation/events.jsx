// The simulation run's event stream (/log, already polled by the app): newest first, filterable by kind and expandable to the record's own fields.
import React, { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Empty, fmt } from '../shared/components.jsx';
import { title, describeLog, logTone, EVENT_GROUPS, inGroup, eventDetail } from './pipeline.js';

/** The run's event log, newest first, filterable and expandable. Uses the /log records the app already polls. */
export function EventTimeline({ log, limit = 12, incident }) {
  const [group, setGroup] = useState('all');
  const [more, setMore] = useState(false);
  const all = (log || []).filter((l) => inGroup(l, group) && (!incident || l.incident === incident)).slice().reverse();
  const shown = more ? all : all.slice(0, limit);
  return (
    <>
      <div className="tq-seg tq-ev-filter" role="group" aria-label="Event filter">
        {EVENT_GROUPS.map(([k, name]) => <button key={k} type="button" className="tq-btn" aria-pressed={group === k} onClick={() => setGroup(k)}>{name}</button>)}
      </div>
      {!shown.length ? <Empty>No events{group !== 'all' ? ' of this kind' : ''} yet.</Empty> : (
        <ol className="tq-ev" data-testid="event-timeline">
          {shown.map((l, i) => {
            const det = eventDetail(l);
            return (
              <li key={`${l.t}-${l.kind}-${i}`} className={`tq-ev-item tone-${logTone(l)}`}>
                <details>
                  <summary><span className="tq-ev-t tq-num">{fmt(l.t, 0)} s</span><span className="tq-ev-text">{describeLog(l)}</span>{l.incident && <span className="tq-ev-inc">{l.incident}</span>}<ChevronRight size={14} className="tq-ev-chev" aria-hidden="true" /></summary>
                  <dl className="tq-kv tq-ev-kv">{det.length ? det.map(([k, v]) => <React.Fragment key={k}><dt>{title(k)}</dt><dd className="tq-num">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></React.Fragment>) : <><dt>Detail</dt><dd>none recorded</dd></>}</dl>
                </details>
              </li>);
          })}
        </ol>)}
      {all.length > limit && <button type="button" className="tq-link" onClick={() => setMore(!more)}>{more ? 'Show fewer' : `Show all ${all.length}`}</button>}
      <p className="tq-chart-note">Simulation time in seconds. The backend keeps the latest 200 log entries for the current run.</p>
    </>
  );
}

