# TORQVA — UI Content Audit (3 Nov 2026)

Scope: a page-by-page audit of the website against the "Complete Website Simplification & Analyst-First UI/UX Optimization" brief, done on top of `09ee47e` (item 17 of `PROJECT_OVERVIEW.md` section 9, which had already delivered the 14-page navigation, product names, the five motor-condition words, the Device & Safety tabs and the removal of breadcrumbs).

Method: every page and tab was opened in both modes in a real browser against `npm run dev:sim` and its structure recorded (headings, cards, tables, charts, disclosures, paragraphs over 60 characters, word, card and button counts). Each item was then judged by the brief's seven questions; only items with no analyst purpose, or that repeat another page, were changed. Frontend only: no backend, firmware, safety, command or API change.

## 1. Page-by-page results

| Page | Content removed | Content consolidated | Content retained | Reason |
|---|---|---|---|---|
| Overview (both modes) | — (done in item 17: trend sparklines, embedded Scenario Studio) | — | Condition banner with one next step, key readings, predicted risk, analysis progress, active incident, recent activity; physical START / speed / STOP and blockers | Already matched the brief; no further change |
| Live Monitor | "Mode" and "Last updated" rows of Current readings (the page badge and the card subtitle already say both) | The last-10-windows table moved from a card into the **Recent windows** disclosure | Four trend charts with range and signal filters, event marks, current readings with provenance and data source, event timeline, stale / missing / invalid warnings | The raw table repeats the charts and the readings card; it stays available as advanced detail |
| Digital Twin | Long instructions and limitation sentences shortened (subtitle, part-selection hint, findings subtitle, the "page only reads" note) | — | 3D model and 2D fallback, view presets, camera tools, component panel, findings, "Illustrative model, not CAD-accurate", sensor inventory and assumptions disclosures; read-only | Shorter text, same claims; the not-CAD-accurate and read-only statements stay visible. Physical mode: analysis statuses now use product names (section 4, item 2) |
| Diagnostic Workflow | Two step-explanation sentences that restated the headings | — | Pattern choice, execution policy, Run, ten stages, evidence, diagnosis, recommendation, authorization, verification; physical blockers | The workflow itself was already the brief's sequence |
| Anomaly Detection | The **Top hypotheses** card on the Overview tab (the same ranking is the Hypotheses tab and the summary tile); the "latest gate verdict" line (a decision, shown on Action Recommendations); the four-step algorithm walkthrough; the decision-gate input card on this page | The Explainability tab is now **Details**: the deviation table and the incident timeline | Status, anomaly severity (× threshold, never a probability), top hypothesis tile, evidence summary and quality, recommended next test, Hypotheses and Evidence tabs, Investigation History link | Removes a duplicate card and content that belongs to other pages |
| Failure Prediction | Shorter model warning; the "shipped predictor is in use" sentence (shown only when an experimental variant is in use) | — | Action comparison, recommended action, uncertainty bands, What-if Analysis and pipeline comparison disclosures | The warning keeps "never measurements and never evidence of recovery" and "not validated on hardware" |
| Action Recommendations | — | — | Proposed action, selection, decision check, lifecycle, Approve / Reject, history, Investigation History, Decision Summaries | Already key-decision first; safety wording unchanged |
| Diagnostic Investigation | A 59-word explanation of the guided investigation's stopping rules shortened to one sentence | **Guided investigation** (its prerequisite table, budget and Run button) moved into its own disclosure, as the brief's Advanced Details | Summary tiles (evidence now, recommended test, latest result, run conditions), Available Tests, Sequence, Test Results, Test History, pipeline tests (advanced) | The large prerequisite table led the page before the tests themselves |
| Recovery Verification | The sentence repeating "recovery only after acknowledgement" (the status panel and the criteria card already state it); simulation keeps "Simulator observations, not hardware evidence" | — | Status with next step, verification criteria, before/after, outcomes, incident story | The distinct states (requested, acknowledged, executed, improvement, verified) are unchanged |
| Continuous Intelligence | "Model training and rollback are not operator actions…" (describes a feature that does not exist) | — | Attestation notice, candidates, versions, warm-up hold, attestation log, learning dataset | — |
| Performance Evaluation | Internal ids in the tables (`c1`, `global`, `legacy` as detector names; "Phase 10/11/12" in titles and column names); git commit, configuration hash, runtime and model versions from the default view; one decimal from false-alarm rates (3 → 2) and errors (3 → 2) | Run metadata and run history in one **Run details and history** disclosure | Headline tiles, detector vs baselines, prediction vs persistence, recovery verdicts, confusion matrix, limitations, validation and generalization tabs with per-regime disclosures, the shown run file | Lowercase `c1` slipped past the C1–C6 guard (see section 4); hashes are provenance, not analysis |
| Scenario Studio | The **Simulated telemetry (preview)** chart with its four signal tabs (a second copy of Live Monitor's trends); the "Watch it in Live Monitor" link duplicated by the new card's link; a 29-word simulation note shortened | New **Run results** card: latest simulated readings, then Detected anomaly → Likely cause → Predicted outcome → Recommended action → After the action, each the pipeline's own stage record | Presets, fault, severity, approval, parameters, review, Start, run / pause / step / STOP, scenario description, what happens next | The brief asks this page to explain what happened; the chart did not, and duplicated Live Monitor |
| Lab | The second introduction (subtitle shortened to "Recording sessions and matched experiments.") | — | New session, notes, sessions, reveal / reproduce, matched experiments; the SIMULATED note | — |
| Device & Safety — Device | **Application information** card (operating mode, API base URL, predictor variant key, "limits cannot be changed here"); raw JSON in the audit Detail column | — | Device inventory, current session (user, role, what the role may do, token storage), audit history (admin only, now plain `key: value` text) | No editable settings exist; mode and predictor are shown where they matter |
| Device & Safety — Connection & Readiness / Safety & Commissioning | — | — | Every readiness blocker, interlock, limit, checklist, enable state and their forms | Safety content kept as it is (brief section 10) |

## 1a. Charts and tables (3 Nov, second pass: "Refine industrial charts and data tables")

Every chart in the app is drawn by `shared/charts.jsx` (the only module that imports Recharts), so the shared rules were fixed there once and apply on every page in both themes:

- **Precision:** axis ticks and tooltips use the chart's own number of decimals. The value axis used to force at least two decimals below 100, so speed read `50.00` and temperature `24.50`; large axis values carry none.
- **Units:** the unit sits at the top of the value axis (rpm, °C, g, A, × threshold) on every trend, history, severity and prediction chart.
- **Tooltips:** values at the chart's precision with their unit, an interval as `low–high`, and a missing or non-finite value as `—`. Before, Recharts printed raw floats and the interval as an unformatted pair.
- **Gaps:** every line has `connectNulls={false}`, so a missing reading stays a gap and is never bridged into a value that looks measured.
- **Predictions:** the response chart's x axis reads `now, +30 s, +60 s, +120 s`, the tooltip names `now (current simulated value)` and `+N s (predicted)`, and the legend says `Predicted (model estimate)` and `90 % interval`. The line was already dashed with a shaded band.
- **Terminology:** the severity chart's legend and the test-sequence chart now say "Anomaly severity" (was "score ratio").

| Page | Chart / table | Question it answers | Change |
|---|---|---|---|
| Overview (physical) | KPI tile sparklines | — (repeated Live Monitor's trends) | **Removed**, with the 3-second `/device/history` poll that fed only them; the simulation Overview dropped its sparklines in item 17 |
| Live Monitor (both) | four trend charts | What is each signal doing now and recently? | Units on axes, chart precision, formatted tooltips (the primary home for live trends) |
| Live Monitor (physical) | device history charts | Same, from the board | Precision and units passed through (`HistoryChart` gained `digits` / `unit`) |
| Anomaly Detection | severity chart (log scale) | How far from the healthy baseline, and when? | Axis unit `× threshold`, tooltip, legend wording |
| Failure Prediction | per-candidate and selected response charts | What is predicted to happen, with what uncertainty? | Signal precision and unit, `now` / `+N s` horizon, prediction-labelled legend and tooltip |
| Diagnostic Investigation | sequence result chart, guided-investigation chart | What did the test on the copy show? | Shared rules; legend wording |
| Diagnostic Workflow | four test-series charts (advanced) | Raw test windows | Shared rules |
| Digital Twin | selected-part trend | — | Removed in Workstream B (duplicate of Live Monitor) |
| Recovery, Continuous Intelligence, Performance Evaluation, Lab | tables only | — | Reviewed: precision and plain detector names were fixed in the first pass; no chart repeats telemetry |
| Action Recommendations | commands, Supervisor decisions, gate inputs | What was sent, decided and acknowledged? | Reviewed, unchanged: `#` and incident ids are traceability, statuses are visible, the commands table already sorts by id; gate inputs keep full precision because they are the audit record |
| Device & Safety | inventory, audit, frame counters | — | Changed in the first pass (audit detail as text); unchanged here |

The tables already share one `DataTable` (sorting where a column declares it, phone-width stacking, wide tables scroll inside their card). No search, filter or pagination was added: no table holds more than about 30 rows by default (commands 20, Supervisor 12, audit 30).

## 1b. Digital Twin (3 Nov, second pass: "Improve digital twin inspection experience")

- **Component panel:** shows only the component's name and function, its readings (value, unit, provenance, freshness, status), notes, the linked evidence and links. Removed:
  - the selected-reading trend chart (a second copy of a Live Monitor trend, now a "Trends in Live Monitor" link);
  - the identity block (internal component id, and the "placement" sentence). The page caption already says the model is illustrative and not CAD-accurate.
- **Physical mode:** with the trend gone, `physical/twin.jsx` no longer imports the API module at all. The twin renders the device stream it is given and makes no request (it used to poll `/device/history` every 2 s while a part was selected). Analysis statuses use product names (first pass).
- **Simulation mode:** unchanged: SIMULATED provenance, scenario ground truth labelled as such, hypotheses as rankings.
- **Controls:** every toolbar control was checked and is functional and covered by the engine and twin tests (reset, fit, focus, four view presets, orthographic, markers, labels, readouts, edges, isolate, explode, section, evidence). "Reset" and the "Iso" preset frame the same view; both stay because the brief asks for a reset and the four standard views.
- **Rendering:** render-on-demand, one shared renderer and context-loss recovery are unchanged. The twin E2E now also checks that no Three.js or viewport module is requested on other pages, and that the same detector does see them when the twin opens.

## 2. Navigation

Unchanged from item 17: Monitor (Overview, Live Monitor, Digital Twin) · Diagnose (Diagnostic Workflow, Anomaly Detection, Failure Prediction, Action Recommendations, Diagnostic Investigation) · Intelligence (Recovery Verification, Continuous Intelligence, Performance Evaluation) · Engineering (Scenario Studio, Lab) · Device & Safety. Groups fold and the active group never does; old ids `control`, `devices`, `connection` open the matching Device & Safety tab.

## 3. Components removed or consolidated

- `SimControls` (an unused alias of `ScenarioStudio`) and `TelemetryPreview` / its `SIGNALS` table in `scenario.jsx` were deleted; Scenario Studio no longer imports the chart code.
- `DevicesPage` lost its never-used standalone tab layout (`SETTINGS_TABS`, the `embedded` switch): it is only ever shown inside Device & Safety.
- Anomaly Detection no longer renders `C1GateCard` (still used by the pipeline record pages in `analysis.jsx`).

## 4. Defects found during the audit

1. **The unit C1–C6 guard could not fail.** In `src/tests/torqva_app.test.jsx` the regex was `/␈C[1-6]␈/` with literal backspace bytes (0x08) where `\b` was meant, so it matched nothing; the same corruption made `torqva_physical.test.jsx`'s "not 0 rpm" check ineffective. Both are fixed, and the guard (unit and the `torqva-app` E2E) now also catches lowercase `c1`–`c6`.
2. **Physical Digital Twin showed layer ids.** Its findings list grouped analysis statuses as "C1, C2, C4, C5: Waiting …" (built in `physical/twin.jsx` from the device's layer keys, so the backend-wording layer never saw it, and the guards only walked simulation pages or physical pages without a layer list). The label now goes through `plainText` ("Anomaly Detection, Failure Prediction, …"), with a unit test for both connected and disconnected snapshots.
2a. **Correction (3 Nov, second pass).** Item 1 said the `torqva-app` E2E guard also caught lowercase ids; that edit had not applied, and the E2E still matched uppercase only. It now does both, on the rendered text (`innerText`): `textContent` glued the candidate label "Action C" to a target of "1,263 rpm" into "C1,263", a false positive whenever a target starts with 1–6. Catching lowercase then found a real leak: the Device tab's audit history showed the event kind `c2_ranking` as "c2 ranking" (the first pass had turned the raw kind into words). Audit event kinds and detail keys now go through `plainLabel` ("Failure Prediction ranking"); the stored kind is unchanged.
3. **Fixed later (3 Nov, `bd60dbc`), originally out of scope:** `backend/torqva/serial_bridge.py` lines 421–427 have the same backspace bytes in the Windows serial-error patterns (`winerror 5`, `2`, `31`, `121`), so those regexes never match; the plain-text checks beside them still classify most errors. It affects only the wording of a connection error, not any interlock, but it needs its own fix and test.

## 5. Preserved

All safety, commissioning, interlock, authorization, audit and acknowledgement behaviour; STOP placement; two-step confirmations; the physical/simulation module isolation (`physical/` and `simulation/` never import each other); every backend feature (guided investigation, What-if Analysis, Decision Summaries, Investigation History, the Lab, attestation, evaluation studies) is still reachable from its page.

## 6. Physical and simulation differences

Physical mode shows real device data only (UNAVAILABLE when missing), the physical Overview keeps START / speed / STOP with named blockers, AI pages show the waiting state, and Device & Safety has the Safety & Commissioning tab. Simulation mode labels every value SIMULATED, is configured and run only in Scenario Studio, and has no Safety & Commissioning tab or physical controls. The audit changed none of this.

## 7. Known limitations

- Tables and charts were reviewed for duplicates and precision, not redesigned.
- Pages that depend on an incident (Failure Prediction, Action Recommendations, Recovery) were audited mostly in their empty state plus the recorded fixtures; their filled states were covered by the E2E suites, not by a fresh content review of every value.
- Physical-mode pages could not be audited with a connected board (hardware is not ready); they were checked in the disconnected state.
- The serial-bridge defect in section 4 is open.
- Backend (pytest) and firmware tests were not re-run: nothing outside the frontend changed.

## 8. Tests executed (3 Nov 2026, all actually run)

| Check | Result |
|---|---|
| Frontend unit tests (`npx vitest run`) | 233 / 233 in 20 files (3 new: Scenario Studio run results ×2, Evaluation detector names and run details; twin layer-name test extended) |
| Production build (`npm run build`) | passes |
| `torqva-app.e2e.mjs` (every page, both modes, 1440/1024/768/390 px, no C1–C6 in either case) | 86 / 86 |
| `torqva-twin.e2e.mjs` | 44 / 44 |
| `torqva-workbench.e2e.mjs` | 47 / 47 (after opening the Hypotheses tab and the Guided investigation disclosure, which this audit introduced) |
| `torqva-workflow.e2e.mjs` | 30 / 30 |
| `torqva.e2e.mjs` (fresh token backend) | 30 / 30 |
| `torqva-lab.e2e.mjs` | 12 / 12 |
| `torqva-c2c4.e2e.mjs` | 23 / 23 (after updating the one label check that named "Phase 11") |
| `torqva-attestation.e2e.mjs` | 32 / 32 |
| `scripts/check-layer-ids.mjs` (live backend prose) | passes |
| Responsive / theme sweep: every page and tab, physical and simulation, light and dark, 390 / 768 / 1440 px (270 views) | no horizontal overflow, no C1–C6 (after the twin fix in section 4) |

Browser E2E total: 304 checks in eight suites. Physical/simulation separation is covered by the app E2E (physical mode never calls the simulator; no device command is sent from simulation pages) and the unit structure test (`physical/` and `simulation/` never import each other).
