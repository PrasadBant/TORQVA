// The analyst journey across the C-layer pages (simulation mode): diagnosis → tests → prediction → decision → recovery, in one compact bar.
// Every state comes from pipelineStages (the backend's log, decisions and outcomes); this bar adds no state of its own.
import React from 'react';
import { pipelineStages, STAGE_WORD } from './pipeline.js';

// The order an analyst works in, with a plain-language step name next to the layer code.
const STEPS = [['c1', 'Detect & diagnose'], ['c4', 'Test the hypothesis'], ['c2', 'Predict outcomes'], ['c3', 'Decide & authorize'], ['c5', 'Verify recovery']];

export function JourneyBar({ d, view, go }) {
  const { incident, stages } = pipelineStages(d);
  const byKey = Object.fromEntries(stages.map((s) => [s.key, s]));
  const here = STEPS.map(([k, name]) => [byKey[k], name]).find(([s]) => s.page === view);
  return (
    <div className="tq-journey" role="navigation" aria-label="Investigation progress" data-testid="journey">
      <span className="tq-journey-label">{incident ? `Investigation ${incident.id}${incident.open ? '' : ' (closed)'}` : 'Investigation'}</span>
      <ol>
        {STEPS.map(([k, name], i) => {
          const s = byKey[k];
          const isHere = s.page === view;
          return (
            <li key={k} className={`is-${s.state}${isHere ? ' is-here' : ''}`} data-testid={`journey-${k}`} data-state={s.state}>
              <button type="button" onClick={() => go(s.page)} aria-current={isHere ? 'step' : undefined} title={s.summary}
                aria-label={`Step ${i + 1}, ${s.code} ${name}: ${STAGE_WORD[s.state]}. ${s.summary}`}>
                <span className="tq-journey-dot" aria-hidden="true" />
                <span className="tq-journey-name"><small>{s.code}</small>{name}</span>
                <span className="tq-journey-state">{STAGE_WORD[s.state]}</span>
              </button>
            </li>);
        })}
      </ol>
      {here && <p className="tq-journey-note" data-testid="journey-note"><strong>{here[0].code} {here[1]}:</strong> {here[0].summary}</p>}
    </div>
  );
}
