// Pure read-outs of the simulator's own records (/status, /telemetry, /log, /outcomes, /cases, /decisions), shared by the Simulation pages.
// Nothing here is estimated: every stage state comes from a record the backend wrote. A stage the pipeline has not reached says so; it is never
// shown as successful because the scenario started. Log entries carry {t, kind, incident} (backend pipeline._log).

export const title = (s) => String(s ?? '').replaceAll('_', ' ');
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d));
const lastWhere = (xs, f) => { for (let i = (xs || []).length - 1; i >= 0; i--) if (f(xs[i])) return xs[i]; return null; };
export const hasSimOf = (s) => !!s && s.t !== undefined && s.t !== null;

/** Lifecycle of the software simulation, from what the backend reports plus whether this browser is advancing simulation time. */
export function lifecycle(d, running, stale) {
  const s = d?.status || {};
  if (stale) return { key: 'unknown', tone: 'crit', label: 'State unknown', detail: 'The backend is not answering; the values shown are the last ones received.' };
  if (!d?.status) return { key: 'loading', tone: 'off', label: 'Loading', detail: 'Waiting for the simulator state.' };
  if (!hasSimOf(s)) return { key: 'idle', tone: 'off', label: 'No simulation', detail: 'Configure a scenario and start it.' };
  if (s.device?.estop) return { key: 'estop', tone: 'stop', label: 'Simulated E-stop latched', detail: s.device.estop_reason ? `Reason: ${title(s.device.estop_reason)}.` : 'The simulated device latched a stop.' };
  if (s.pending_approval) return { key: 'approval', tone: 'wait', label: 'Awaiting human approval', detail: `Proposed: ${title(s.pending_approval.action)}.` };
  if (running) return { key: 'running', tone: 'ok', label: 'Running', detail: 'Simulation time advances while this page is open.' };
  if (s.t === 0) return { key: 'ready', tone: 'info', label: 'Ready', detail: 'Started at t = 0 s; press Run or Step to advance time.' };
  return { key: 'paused', tone: 'wait', label: 'Paused', detail: 'Simulation time is not advancing.' };
}

export function scenarioText(sc) {
  if (!sc || !Object.keys(sc).length) return 'none';
  if (!sc.fault) return 'Healthy run (no fault scheduled)';
  return `${title(sc.fault)} · severity ${fmt(sc.severity, 2)}`;
}

/** The incident the pipeline views refer to: the open one, else the most recent one of this run. */
export function currentIncident(d) {
  const open = d?.status?.incident;
  if (open) return { id: open.id, state: open.state, open: true, tests_run: open.tests_run };
  // Stored incident records carry no id, so the most recent one is found through the log, which tags every entry with its incident.
  const opened = lastWhere(d?.log, (l) => l.kind === 'incident_opened' && l.incident);
  if (!opened) return null;
  const closed = lastWhere(d?.log, (l) => l.kind === 'incident_closed' && l.incident === opened.incident);
  return { id: opened.incident, state: closed?.final ?? null, open: false };
}

/** Incident ids seen in this run's log, oldest first. */
export const incidentIds = (log) => [...new Set((log || []).filter((l) => l.kind === 'incident_opened' && l.incident).map((l) => l.incident))];

export const outcomeTone = (o) => (o === 'RECOVERED' ? 'ok' : o === 'UNRESOLVED' ? 'crit' : o === 'HUMAN_INSPECTION_REQUIRED' ? 'stop' : 'warn');
const GATE = { ACT: 'ok', RUN_DIAGNOSTIC_TEST: 'ok', REQUEST_MORE_DATA: 'wait', ESCALATE_HUMAN: 'wait', SAFE_STOP: 'stop', SENSOR_UNRELIABLE: 'fail' };

export const STAGE_TONE = { ok: 'ok', active: 'info', wait: 'wait', stop: 'crit', fail: 'crit', idle: 'off', na: 'off' };
export const STAGE_WORD = { ok: 'complete', active: 'in progress', wait: 'waiting', stop: 'refused', fail: 'failed', idle: 'not reached', na: 'unavailable' };

/**
 * The C1 → hypotheses → C2 → C3 → C4 → C5 → C6 stages for the current incident. Each: {key, code, name, state, summary, t, page}.
 * state ∈ ok | active | wait | stop | fail | idle | na (see STAGE_WORD).
 */
export function pipelineStages(d) {
  const s = d?.status || {};
  const hasSim = hasSimOf(s);
  const inc = currentIncident(d);
  const L = inc ? (d?.log || []).filter((l) => l.incident === inc.id) : [];
  const of = (kind) => lastWhere(L, (l) => l.kind === kind);
  const samples = d?.telemetry?.samples || [];
  const last = samples[samples.length - 1];
  const noInc = 'Not reached: no incident has been opened.';
  const st = (key, code, name, page, state, summary, t = null) => ({ key, code, name, page, state, summary, t });

  // C1 — anomaly detection
  let c1;
  if (!hasSim) c1 = st('c1', 'C1', 'Anomaly detection', 'diagnostics', 'na', 'No simulation is running.');
  else if (inc) { const op = of('incident_opened'); c1 = st('c1', 'C1', 'Anomaly detection', 'diagnostics', 'ok', `Anomaly persisted: incident ${inc.id} opened.`, op?.t ?? null); }
  else if (!last) c1 = st('c1', 'C1', 'Anomaly detection', 'diagnostics', 'na', 'No telemetry window yet.');
  else if (last.score == null) c1 = st('c1', 'C1', 'Anomaly detection', 'diagnostics', 'wait', `Latest window not scored: ${title(last.score_status) || 'unknown reason'}.`, last.t);
  else if (last.score > 1) c1 = st('c1', 'C1', 'Anomaly detection', 'diagnostics', 'active', `Score ${fmt(last.score, 2)} × threshold; not yet persistent.`, last.t);
  else c1 = st('c1', 'C1', 'Anomaly detection', 'diagnostics', 'ok', `Monitoring: score ${fmt(last.score, 2)} × threshold (normal).`, last.t);

  // Hypothesis generation and ranking (not one of the C layers)
  const hy = of('hypotheses');
  const top = hy?.ranked?.[0];
  const hyp = !inc ? st('hyp', 'H', 'Hypothesis ranking', 'diagnostics', 'idle', noInc)
    : hy ? st('hyp', 'H', 'Hypothesis ranking', 'diagnostics', hy.label === 'confident' ? 'ok' : 'wait', `${title(top?.[0])} ${fmt((top?.[1] ?? NaN) * 100, 0)}% (${hy.label || 'unlabelled'}).`, hy.t)
    : inc.open ? st('hyp', 'H', 'Hypothesis ranking', 'diagnostics', 'active', 'Collecting evidence; no ranking logged yet.')
    : st('hyp', 'H', 'Hypothesis ranking', 'diagnostics', 'idle', 'The incident closed before a ranking was logged.');

  // C2 — outcome prediction
  const rank = of('c2_ranking'); const uns = of('c2_unsupported');
  const c2 = !inc ? st('c2', 'C2', 'Outcome prediction', 'predictions', 'idle', noInc)
    : uns && (!rank || uns.t >= rank.t) && !rank?.chosen ? st('c2', 'C2', 'Outcome prediction', 'predictions', 'stop', `Unsupported: ${(uns.reasons || []).map(title).join(', ') || 'no reason given'}.`, uns.t)
    : rank ? st('c2', 'C2', 'Outcome prediction', 'predictions', 'ok', `${(rank.ranking || []).length} action(s) compared${rank.chosen ? `; lowest risk: ${title(rank.chosen)}` : '; none chosen'}.`, rank.t)
    : inc.open && s.incident?.state === 'ACTION_EVALUATION' ? st('c2', 'C2', 'Outcome prediction', 'predictions', 'active', 'Comparing candidate actions.')
    : st('c2', 'C2', 'Outcome prediction', 'predictions', 'idle', 'No prediction logged for this incident.');

  // C3 — decision gate (+ human approval and Safety Supervisor)
  const gate = of('gate'); const sup = of('supervisor');
  let c3;
  if (!inc) c3 = st('c3', 'C3', 'Decision gate', 'interventions', 'idle', noInc);
  else if (inc.open && s.pending_approval) c3 = st('c3', 'C3', 'Decision gate', 'interventions', 'wait', `Awaiting human approval: ${title(s.pending_approval.action)}.`, gate?.t ?? null);
  else if (sup && (!gate || sup.t >= gate.t) && sup.verdict !== 'ALLOW') c3 = st('c3', 'C3', 'Decision gate', 'interventions', sup.verdict === 'DEFER' ? 'wait' : 'stop', `Safety Supervisor ${sup.verdict}: ${title(sup.action)}${sup.reasons?.length ? ` (${sup.reasons.map(title).join(', ')})` : ''}.`, sup.t);
  else if (gate) c3 = st('c3', 'C3', 'Decision gate', 'interventions', GATE[gate.verdict] || 'active', `${title(gate.verdict)}${gate.test ? ` → test ${gate.test}` : ''}${gate.reason ? `: ${gate.reason}` : ''}`, gate.t);
  else c3 = st('c3', 'C3', 'Decision gate', 'interventions', 'idle', 'The gate has not evaluated this incident yet.');

  // C4 — diagnostic tests
  const tr = of('test_result'); const ta = of('test_aborted');
  const c4 = !inc ? st('c4', 'C4', 'Diagnostic tests', 'tests', 'idle', noInc)
    : ta && (!tr || ta.t >= tr.t) ? st('c4', 'C4', 'Diagnostic tests', 'tests', 'fail', `Test aborted: ${title(ta.status)}${ta.reason ? ` (${ta.reason})` : ''}.`, ta.t)
    : s.incident?.state === 'DIAGNOSTIC_RUNNING' ? st('c4', 'C4', 'Diagnostic tests', 'tests', 'active', 'A diagnostic test is in progress.')
    : s.incident?.state === 'DIAGNOSTIC_PROPOSED' ? st('c4', 'C4', 'Diagnostic tests', 'tests', 'wait', 'A test is proposed and waits for the Safety Supervisor.')
    : tr ? st('c4', 'C4', 'Diagnostic tests', 'tests', 'ok', `${tr.test} done; top after test: ${title(tr.posterior?.[0]?.[0])} ${fmt((tr.posterior?.[0]?.[1] ?? NaN) * 100, 0)}%.`, tr.t)
    : st('c4', 'C4', 'Diagnostic tests', 'tests', 'idle', 'No test was requested for this incident.');

  // C5 — recovery verification (the backend's verdict only; an acknowledgement alone is never recovery)
  const out = inc ? lastWhere(d?.outcomes, (o) => o.incident === inc.id) : null;
  const c5 = !inc ? st('c5', 'C5', 'Recovery verification', 'recovery', 'idle', noInc)
    : out ? st('c5', 'C5', 'Recovery verification', 'recovery', out.outcome === 'RECOVERED' ? 'ok' : out.outcome === 'UNRESOLVED' ? 'fail' : out.outcome === 'HUMAN_INSPECTION_REQUIRED' ? 'stop' : 'wait', `${title(out.outcome)} from ${out.n_fresh ?? 0} fresh sample(s); device acknowledged: ${out.command_executed ? 'yes' : 'no'}.`, of('recovery_assessment')?.t ?? null)
    : s.incident?.state === 'VERIFYING_RECOVERY' ? st('c5', 'C5', 'Recovery verification', 'recovery', 'active', 'Collecting fresh samples after the acknowledged action.')
    : st('c5', 'C5', 'Recovery verification', 'recovery', 'idle', 'No action has been verified for this incident.');

  // C6 — gated learning (the backend records a case only for RECOVERED / UNRESOLVED outcomes; pipeline._record_outcome)
  const nCases = (d?.cases || []).length;
  const c6 = !inc ? st('c6', 'C6', 'Gated learning', 'learning', 'idle', `${nCases} case(s) recorded in this run.`)
    : !out ? st('c6', 'C6', 'Gated learning', 'learning', 'idle', 'Waits for a recovery verdict.')
    : ['RECOVERED', 'UNRESOLVED'].includes(out.outcome) ? st('c6', 'C6', 'Gated learning', 'learning', 'ok', `Eligible outcome; ${nCases} case(s) recorded in this run.`)
    : st('c6', 'C6', 'Gated learning', 'learning', 'stop', `Not recorded: a ${title(out.outcome)} outcome is not learnable.`);

  return { incident: inc, stages: [c1, hyp, c2, c3, c4, c5, c6] };
}

/** One-line description of a log record. */
export function describeLog(l) {
  switch (l.kind) {
    case 'hypotheses': return `Hypotheses ranked: ${title(l.ranked?.[0]?.[0])} (${l.label})`;
    case 'gate': return `Decision gate: ${title(l.verdict)}${l.test ? ` → test ${l.test}` : ''}`;
    case 'supervisor': return `Supervisor ${l.verdict}: ${title(l.action)}`;
    case 'test_result': return `Test ${l.test} returned`;
    case 'test_aborted': return `Test aborted: ${l.status}`;
    case 'transition': return `Incident ${title(l.frm)} → ${title(l.to)}`;
    case 'incident_opened': return 'Incident opened';
    case 'incident_closed': return `Incident closed: ${title(l.final)}`;
    case 'recovery_assessment': return `Recovery assessment: ${title(l.outcome)}`;
    case 'c2_unsupported': return `C2 unsupported: ${(l.reasons || []).map(title).join(', ')}`;
    case 'c2_ranking': return `C2 ranked ${(l.ranking || []).length} action(s)${l.chosen ? `: ${title(l.chosen)} lowest risk` : ''}`;
    case 'mandatory_stop': return `Mandatory stop: ${(l.reasons || []).map(title).join(', ')}`;
    case 'command_failed': return `Command failed: ${title(l.status)}`;
    default: return title(l.kind);
  }
}
export const logTone = (l) => (['mandatory_stop', 'command_failed', 'test_aborted', 'c2_unsupported'].includes(l.kind) ? 'crit' : ['gate', 'supervisor'].includes(l.kind) ? 'wait' : 'info');

export const EVENT_GROUPS = [
  ['all', 'All'],
  ['incident', 'Incident', ['incident_opened', 'incident_closed', 'transition']],
  ['ai', 'AI pipeline', ['hypotheses', 'c2_ranking', 'c2_unsupported', 'gate', 'test_result', 'test_aborted', 'recovery_assessment']],
  ['safety', 'Safety and commands', ['supervisor', 'mandatory_stop', 'command_failed']],
];
export const inGroup = (l, g) => { const e = EVENT_GROUPS.find((x) => x[0] === g); return !e || !e[2] ? true : e[2].includes(l.kind); };
/** The fields of a log record worth showing when it is expanded (everything except what the row already says). */
export const eventDetail = (l) => Object.entries(l).filter(([k]) => !['t', 'kind'].includes(k) && l[k] !== null && l[k] !== undefined);
