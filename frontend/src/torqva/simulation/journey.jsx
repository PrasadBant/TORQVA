// The analyst journey across the investigation pages (simulation mode): diagnosis → tests → prediction → decision → recovery, in one compact bar
// drawn like the shared StepTracker. Every state comes from pipelineStages (the backend's log, decisions and outcomes); this bar adds no
// state of its own, and a step reads "complete" only when pipelineStages says so.
import React from 'react';
import { CheckCircle2, CircleDot, Clock, XCircle, CircleDashed, Ban } from 'lucide-react';
import { pipelineStages, STAGE_WORD } from './pipeline.js';

// The order an analyst works in (Monitor → Investigate → Understand → Act → Verify), each step named by its task and the page that does it.
const STEPS = [['monitor', 'Monitor'], ['c1', 'Investigate'], ['c4', 'Test'], ['c2', 'Understand'], ['c3', 'Act'], ['c5', 'Verify']];
// pipeline state → StepTracker look (done | active | waiting | blocked | failed | pending | skipped)
const LOOK = { ok: 'done', active: 'active', wait: 'waiting', stop: 'blocked', fail: 'failed', idle: 'pending', na: 'skipped' };
const ICON = { ok: CheckCircle2, active: CircleDot, wait: Clock, stop: Ban, fail: XCircle, idle: CircleDashed, na: CircleDashed };

export function JourneyBar({ d, view, go }) {
  const { incident, stages } = pipelineStages(d);
  const byKey = Object.fromEntries(stages.map((s) => [s.key, s]));
  // Monitor is not a pipeline stage: it is complete once the run has produced telemetry, and it opens Live Monitor.
  const n = (d?.telemetry?.samples || []).length;
  byKey.monitor = { key: 'monitor', name: 'Live Monitor', page: 'live', state: n ? 'ok' : 'na', summary: n ? `${n} simulated window(s) received.` : 'No simulated telemetry yet.' };
  const here = STEPS.map(([k, name]) => [byKey[k], name]).find(([s]) => s.page === view);
  return (
    <div className="tq-an-journey" role="navigation" aria-label="Investigation progress" data-testid="journey">
      <span className="tq-an-journey-label">{incident ? `Investigation ${incident.id}${incident.open ? '' : ' (closed)'}` : 'Investigation'}</span>
      <ol className="tq-steps">
        {STEPS.map(([k, name], i) => {
          const s = byKey[k];
          const isHere = s.page === view;
          const I = ICON[s.state] || CircleDashed;
          return (
            <li key={k} className={`tq-step is-${LOOK[s.state] || 'pending'}${isHere ? ' is-here' : ''}`} data-testid={`journey-${k}`} data-state={s.state}>
              <button type="button" className="tq-step-btn" onClick={() => go(s.page)} aria-current={isHere ? 'step' : undefined} title={s.summary}
                aria-label={`Step ${i + 1}, ${name} (${s.name}): ${STAGE_WORD[s.state]}. ${s.summary}`}>
                <span className="tq-step-mark" aria-hidden="true"><I size={15} /></span>
                <span className="tq-step-text"><span className="tq-step-label"><small>{name}</small> {s.name}</span><span className="tq-step-sub">{STAGE_WORD[s.state]}</span></span>
              </button>
            </li>);
        })}
      </ol>
      {here && <p className="tq-an-journey-note" data-testid="journey-note"><strong>{here[1]} · {here[0].name}:</strong> {here[0].summary}</p>}
    </div>
  );
}
