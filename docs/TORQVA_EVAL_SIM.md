# TORQVA — Simulation Evaluation (run 1)

**Everything below is SIMULATION. There is no measured data yet.** The simulator (`backend/torqva/sim.py`) is not calibrated to the RS-775 rig, and its fault models are structurally consistent with the predictors, so these numbers are optimistic and are *not* hardware results. Source: `docs/eval/eval_sim_run1.json`, reproduce with `cd backend && python -m torqva.evaluation --out run.json` (≈5 s, deterministic).

Protocol: models fitted on training sessions (seeds 0, 101, 102, 11, 12 at speeds 900…2100); all metrics on disjoint seeds and **speeds never seen in training** (1350/1650/1950 rpm). Labels are hidden from the pipeline until scoring. This is a session-split, but not yet a *blind* test by a second person (that needs the physical rig).

## C1 anomaly detection (healthy: 4,200 test windows)
| Method | Window false-alarm rate | Confirmed false incidents (5 consecutive) |
|---|---|---|
| **C1 per-speed-bin baselines** | 0.26 % | 0 |
| Operating-point-unaware single baseline | 0.02 % | 0 |
| Original fixed thresholds (`backend/config.py` warning limits) | 0 % | 0 |

Detection (fraction of 9 runs detected; "–" = none):
| Fault \ severity | 0.02 | 0.05 | 0.1 | 0.2 | 0.4 | 0.8 |
|---|---|---|---|---|---|---|
| imbalance — C1 | – | 100 % | 100 % | 100 % | 100 % | 100 % |
| imbalance — single baseline | – | – | 56 % | 100 % | 100 % | 100 % |
| imbalance — fixed thresholds | – | – | – | – | – | 44 % |
| overload — C1 | – | 100 % | 100 % | 100 % | 100 % | 100 % |
| overload — single baseline | – | – | – | 100 % | 100 % | 100 % |
| overload — fixed thresholds | – | – | – | – | – | 100 % |
| looseness — C1 | 67 % | 100 % | 100 % | 100 % | 100 % | 100 % |
| supply voltage — C1 | – | – | – | 44 % | 100 % | 100 % |
| sensor fault — C1 | 100 % across all severities | | | | | |

Reading: the operating-point-aware baseline catches imbalance and overload at ≈5 % severity, where the original fixed thresholds need ≥80 % and a speed-blind baseline needs 10–20 %. Caveats: the fixed thresholds were never tuned for this simulator, so "fixed thresholds miss it" mainly shows they are blunt, and the supply-voltage fault is hard for C1 until it is large. Healthy false alarms are slightly higher than the speed-blind baseline (0.26 % vs 0.02 %) — a real trade-off, not a win on every axis.

## Hypotheses (144 decisions, 6 classes, random = 16.7 %)
- Top-1 accuracy **95.1 %**. Confident decisions (≥0.70, margin ≥0.30): 143, of which **7 were wrong: false-confident rate 4.9 %** — this is too high for an autonomous ACT and is the main thing to improve. Errors: looseness → sensor-fault ×3, sensor-fault → looseness ×3, imbalance → sensor-fault ×1; overload, cooling failure and supply voltage were perfect.
- Diagnostic test value on genuinely ambiguous pairs (prior split 50/50, n = 10 each): imbalance vs looseness with T1: 50 % → 100 %; overload vs cooling failure with T4: 50 % → 100 %. The sim's separation is cleaner than reality will be; real tests must re-fit these signatures (the looseness speed-exponent is a modelling assumption).

## C2 intervention outcome prediction (48 held-out scenarios × 3 actions) — *Intervention Outcome Prediction (unvalidated)*
- Beats the persistence baseline on every signal for REDUCE_SPEED and STOP (e.g. rpm MAE 4 vs 525; vibration 0.008 g vs 0.055 g), and on housing temperature even when continuing (0.10 °C vs 1.46 °C). For CONTINUE on rpm/vibration/current it equals persistence (nothing changes).
- 90 % conformal intervals: mean coverage **88.1 %** (target 90 %), **worst cell 58 %** — slightly under-covering under shift in severity/speed. The trust check currently demands mean ≥ 80 % and no cell < 50 %.
- Ranking vs measured best action (9 limit-approaching scenarios): **matched in 6 of 9, but in 3 of those all actions were equal on limit-exceedance**, so the informative agreement is weaker than "6/9" suggests. Not a validation: that needs Intervention Outcome Experiments on the rig.

## C5 recovery verification (40 cases, half truly cleared)
Recovery declared in 20/20 true recoveries; **0 false recovery declarations; 0 missed recoveries**. Easy because the simulated "cleared" condition is binary; real marginal recoveries will be harder.

## Not covered by this run (and where it is covered instead)
Safety/robustness paths (stale telemetry, invalid commands, sensor failure, comms loss, e-stop, blocked actions never counting as recovery, mandatory stop not delayed) are tested as pass/fail unit and end-to-end tests: `backend/tests/test_torqva_safety.py`, `test_torqva_incident.py`, `test_torqva_e2e.py`, and the firmware tests (`pio test -e native`).

## Known weaknesses found while building this (kept visible on purpose)
1. 5 % false-confident hypothesis decisions (looseness vs sensor-fault).
2. The simulator is too easy: faults are detected at 2–5 % severity and tests separate hypotheses perfectly. Real rig data will be harder.
3. C1 scale floors and bin-interpolation were added after the end-to-end run showed healthy operation off the training speed scoring as anomalous — a reminder that single-speed commissioning is not enough; commissioning must sweep inside each bin.
4. C6 has only been exercised on simulated cases; no real few-shot result exists.

---

# Run 2 — harder, held-out simulation regimes (`docs/eval/eval_sim_run2.json`)

**Still simulation only. No measured data.** Reproduce: `cd backend && python -m torqva.evaluation --out run.json` (~17 s, deterministic).

## Protocol
- Models (C1 baseline, hypothesis signatures, C4 test signatures, C2 predictor) are fitted on the **baseline regime only**.
- Temperature calibration uses a separate **validation set** (144 cases, seeds 8001–8002, regimes baseline/noisy/session_shift). Test seeds 8101–8103 and speeds 1350/1650/1950 are disjoint from training and validation (asserted by a test).
- Six regimes (`backend/torqva/sim.py`, `REGIMES`): `baseline`; `noisy` (2× measurement noise); `session_shift` (per-session healthy shifts in vibration gain ±10 %, ambient ±2 °C, supply ±0.25 V, current offset); `confusable_sensor` (sensor fault = speed-**independent** noise on the 2×/3×/HF channels, which looks like looseness at one speed); `intermittent` (looseness and sensor fault come and go); `hard` (all combined).
- Each regime: healthy + 6 faults × 3 severities × 3 seeds × 3 speeds (≈190 sessions). A session is "flagged" if ≥ 8 windows exceed the C1 threshold; the hypothesis decision uses only those windows.
- Three decision policies compared: **uncalibrated** (previous behaviour), **calibrated + OOD** (temperature scaling + an "unfamiliar evidence" guard), **calibrated + OOD + pair rule** (new gate rule: a looseness or sensor-fault diagnosis is never *confident* until a speed-step test has run).

## Results per regime (confident = P ≥ 0.70 and margin ≥ 0.30)
| Regime | Faulty detected | Healthy runs falsely flagged | Policy | Top-1 (flagged faulty) | Abstained | False-confident decisions | Macro-F1 |
|---|---|---|---|---|---|---|---|
| baseline | 100 % | 0 % | uncalibrated | 99 % | 0 % | 1 / 162 | 0.99 |
| | | | + OOD | 99 % | 0 % | 1 | 0.99 |
| | | | + pair rule | 99 % | 33 % | **0** | 0.99 |
| noisy | 100 % | **100 %** | uncalibrated | 99 % | 0 % | 10 / 171 | 0.99 |
| | | | + OOD | 99 % | 13 % | 1 | 0.99 |
| | | | + pair rule | 99 % | 44 % | **0** | 0.99 |
| session_shift | 100 % | **56 %** | uncalibrated | 99 % | 0 % | 6 / 167 | 0.99 |
| | | | + OOD | 99 % | 10 % | 2 | 0.99 |
| | | | + pair rule | 99 % | 43 % | **1** | 0.99 |
| confusable_sensor | 100 % | 0 % | uncalibrated | 83 % | 0 % | **27 / 162** | 0.78 |
| | | | + OOD | 83 % | 0 % | 27 | 0.78 |
| | | | + pair rule | 83 % | 33 % | **0** | 0.78 |
| intermittent | 100 % | 0 % | uncalibrated | 90 % | 0 % | 16 / 162 | 0.89 |
| | | | + OOD | 90 % | 17 % | 0 | 0.89 |
| | | | + pair rule | 90 % | 33 % | 0 | 0.89 |
| hard | 100 % | **100 %** | uncalibrated | 67 % | 0 % | **63 / 171** | 0.67 |
| | | | + OOD | 67 % | 61 % | 26 | 0.67 |
| | | | + pair rule | 67 % | **77 %** | **0** | 0.67 |

(For healthy sessions that were flagged, any confident diagnosis counts as a false-confident decision. Per-class precision/recall/F1 and full confusion matrices are in the JSON.)

## What this shows — and what it does not
1. **Looseness vs sensor fault is the real weakness.** In `confusable_sensor`, every sensor fault (27/27) is called looseness, with full confidence, by the uncalibrated model; per-class F1 for sensor fault is **0.0** in the `confusable_sensor` and `hard` regimes. A single window at one speed genuinely cannot tell them apart, so more modelling of single-window evidence will not fix this — only a test (or multi-speed evidence) can.
2. **The pair rule removes the confident errors** (0 false-confident decisions in every regime except `session_shift`, where 1 remains) **by abstaining more** (33–77 % abstention). That is the cost, not a free win.
3. **After the speed-step test (T1)** on the 54 held-back sessions per regime: baseline/noisy/session_shift all resolved correctly (54/54 confident-correct). In `confusable_sensor` only 27 resolve correctly, **4 are still confidently wrong**, and 23 are flagged as *unfamiliar test outcome* (escalated to a human); in `hard`, 13 correct, 4 confidently wrong, 37 escalated. T1's signature model was fitted on the *stuck-sensor* style; it does not generalise to the noisy-harmonics style, which is why T1 alone scores 50 % there. **Signature libraries must cover sensor-fault *styles*; real fault recordings are needed.**
4. **Temperature calibration changed nothing** (chosen T = 1.0): on the validation regimes the classifier was already well-calibrated, because the validation set contained no look-alike fault. Calibration cannot correct a failure mode it has not seen. The OOD guard did the useful work in `noisy`/`intermittent`/`hard`.
5. **C1 is not robust to noise or session shifts.** With baselines learned on the baseline regime, **100 % of healthy `noisy` and `hard` sessions and 56 % of `session_shift` sessions are flagged as anomalous.** A real rig will have run-to-run shifts; baselines need per-session/continual adaptation (with the drift guard) or noisier commissioning data before any autonomy is considered.
6. **C2 interval coverage** (90 % target; predictor calibrated on baseline): baseline 92 % mean / 58 % worst cell; session_shift 92 / 58; confusable 90 / 58; intermittent 88 / 58; **noisy 76 / 17 and hard 74 / 17.** The C2 trust check passes for baseline, session_shift, confusable and intermittent and **fails for noisy and hard** (so the system would not act on those predictions). The 58 % worst cell exists even in the baseline regime.
7. **Not demonstrated:** anything on real hardware; blind testing by a second person; hypotheses beyond the six; multi-fault cases; the learning loop (C6) improving these numbers.

## Decision
These results do **not** justify autonomous physical intervention, and none is enabled: the simulation auto-approval is a simulation-only setting, and hardware mode always requires explicit human approval through the deterministic Safety Supervisor (unchanged and tested).


---

# Phase 8 — C1 under distribution shift (`docs/eval/c1_phase8_*`)

**Simulation only. No measured data, no physical motor operated, nothing flashed.** The simulator is uncalibrated and easier than reality (faults are detected in the first window; median detection delay is 0 s, p90 ≤ 4.8 s). Reproduce (fixed seeds, deterministic):
```
cd backend
python -m torqva.c1_study validate     # tunes on validation sessions/regimes ONLY, writes docs/eval/c1_phase8_selection.json (~30 s)
python -m torqva.c1_study final        # one run on held-out test sessions/regimes with the frozen selection (~100 s)
```
Outputs: `c1_phase8_selection.json` (hyper-parameter sweep + frozen choice), `c1_phase8_final.json` (per-regime metrics with 95 % Wilson intervals), `c1_phase8_sessions.jsonl.gz` (all 5,280 test sessions: id, seed, speed, simulator/regime configuration, ground truth, model version, per-variant verdict / flags / delay).

## 1. Reproduction of the weakness, and root cause
Unchanged C1, re-run: baseline 0 %, noisy 100 %, session_shift 55.6 %, hard 100 % of healthy sessions flagged — identical to run 2 (the full `torqva.evaluation` JSON is byte-identical before and after this phase). One-factor diagnosis on healthy runs (`python docs/eval/diag_c1_factors.py` from the repo root, window false-alarm rate of the shipped detector):

| Healthy factor | Window false alarms | | Healthy factor | Window false alarms |
|---|---|---|---|---|
| none | 0.4 % | | current offset ±0.03 A | 4–7 % |
| noise ×1.5 / ×2 / ×3 | 12 % / 44 % / 86 % | | supply offset ±0.25 V | 0.7 % |
| vibration gain 0.9 / 1.1 / 1.25 | 11 % / 15 % / 96 % | | ambient 18 / 26 / 30 °C | 0.4 % |

**Root cause.** The baseline is fitted on **one** healthy session, and its per-feature scales equal that session's own measurement noise (≈5 % on every vibration channel, scale floor 3 %). A 10 % vibration-gain shift is therefore ≈2σ on five correlated channels at once, and doubled noise doubles every z (Mahalanobis ×4) against a threshold fixed from a single noise level. Speed bins, temperature and supply offsets are **not** the cause. Secondary finding (not fixed): the "steady" gate admits the last seconds of the speed-up ramp, which inflates the trained scales of duty / voltage / power (voltage scale 0.71 V vs ≈0.03 V real noise), so supply-voltage faults at ≤ 0.1 severity are nearly invisible (recall 0.67 pooled, identical for every variant).

## 2. Protocol
* **Training (baseline regime only).** Shipped control = 1 session (seed 0). Candidates and a second control (`control_4session`, same code) use 4 pooled sessions (seeds 0, 9001–9003). No candidate sees a shifted training session.
* **Validation (all tuning).** Seeds 9101–9106 (healthy) / 9101–9104 (faults); regimes baseline, noise ×1.5, noise ×1.75, gain ±10 %, gain ±15 %.
* **Final test (untouched until `final`).** Seeds 9201–9212 (healthy: 12 seeds × 3 speeds 1350/1650/1950 = **36 sessions per regime**, none a training setpoint) and 9201–9206 (faults: 6 fault types × severities 0.1/0.3/0.6 × 6 seeds × 3 speeds = **324 per regime**). Disjoint from train, validation and every earlier evaluation seed (asserted by a test). 15 of the 16 test regimes (all but the fresh-seed baseline) never appear in validation; `final` refuses to run without the frozen selection file.
* **Session** = 60 s trusted healthy warm-up + 40 s observation, fault injected at the start of the observation. **FAULT** = ≥ 8 anomalous steady windows (the existing rule). Candidate C adds **UNFAMILIAR** (escalate for more evidence). Cooling failure is excluded (needs ≥ 300 s of thermal history); combined (multi-)faults are not supported by the simulator; both are untested.
* Seeds 9301–9309 were used only for the one-factor diagnosis and the post-hoc residual analysis; no candidate was tuned on them.

## 3. Candidates (the control stays unchanged in `detection.py`)
| | What | Why it was worth testing |
|---|---|---|
| **A** `RobustBaselineDetector` | median/MAD location + scale, winsorised covariance, relative scale floor swept over {0.03, 0.05, 0.08, 0.12, 0.20} | cheapest fix if the problem were outliers / under-estimated scale |
| **B** session reference (`ReferenceRegistry`) | from a **trusted healthy warm-up**, estimate a common-mode vibration gain and per-feature noise inflation; immutable `SessionReference`; trained bins never modified | the dominant healthy shifts are common-mode across the vibration channels, faults are channel-selective (1× vs 2×/3×/HF) |
| **C** `assess_session` | HEALTHY / FAULT / **UNFAMILIAR**: a flagged session is UNFAMILIAR only if a gain + noise model estimated from the session explains the flags, or the speed is outside the trained bins, or the shift is not explainable (drifting / out of envelope); channel-selective deviation stays FAULT | separates an unfamiliar regime from a confirmed fault without needing a trusted warm-up |

Adaptation safeguards (B): trusted attestation required (no update from untrusted observations, an open incident, or a cooldown); invalid / short / unfamiliar-region warm-up rejected; vibration channels must agree (≤ coh_tol) or the proposal is rejected as "looks like a fault"; gain within [0.70, 1.40], noise ≤ 3.5×, warm-up stationary; the candidate must regard its own warm-up as healthy (≤ 5 % flagged) **and** must still flag a synthetic 1.6× 1x-amplitude fault (≥ 70 %); every proposal / accept / reject / rollback is logged (forwarded to the audit store inside the pipeline); rollback returns to the last known-good reference or to the unadapted trained baseline. A fault present in a wrongly attested warm-up was **not** absorbed (rejected at coherence, and independently by the self-check / envelope gates when coherence is disabled — mutation-checked).

## 4. Validation outcome (selection rule fixed in advance, written into the file)
Feasible = validation false-FAULT ≤ 5 % and recall(severity ≥ 0.3) ≥ control − 0.05. Control: **47 % (1 session) / 31 % (4 sessions)** false-FAULT on the validation shifts. **A: no feasible setting** (best 27 %; larger floors cost recall, 0.92 at floor 0.20). **B: 0 %** at coh_tol 0.10, recall(sev ≥ 0.3) 1.00. **C alone: 3 %**, 28 % escalated. **B+C: 0 %**, recall 1.00 → **selected (coh_tol = 0.10)**. A+B+C not selected (A infeasible).

## 5. Held-out test results (healthy sessions, n = 36 per regime unless noted)
**False-FAULT rate** on healthy sessions (95 % Wilson CI for the end columns); B+C also shows escalated (U) vs accepted-healthy (H) counts.

| Regime | shipped control | control (4 sess.) | A robust | B ref only | C only | **B+C** (U / H) |
|---|---|---|---|---|---|---|
| baseline | 0 % [0–9] | 0 | 0 | 0 | 0 | **0** (0 / 36) |
| noise ×2 | **100 %** [90–100] | 100 | 100 | 31 | 11 | **0 % [0–9]** (11 / 25) |
| noise ×3 (stress) | 100 | 100 | 100 | 100 | 22 | **22 % [11–38]** (28 / 0) |
| gain ×1.25 | 100 | 100 | 100 | 0 | 0 | **0** (0 / 36) |
| gain ×0.80 | 100 | 100 | 100 | 0 | 0 | **0** (0 / 36) |
| session_shift | **69 %** [53–82] | 67 | 67 | 28 | 14 | **14 % [6–28]** (5 / 26) |
| hard_shift (session_shift + noise ×2) | 100 | 100 | 100 | 78 | 36 | **36 % [22–52]** (15 / 8) |
| gradual gain drift | 72 | 75 | 75 | 72 | 0 | **0** (26 / 10) |
| abrupt gain step after warm-up | 100 | 100 | 100 | 100 | 0 | **0** (36 / 0) |
| ambient 30 °C / 14 °C; speed step +150 rpm | 0 | 0 | 0 | 0 | 0 | **0** (0 / 36 each) |
| unseen speed 2400 / 600 rpm (n = 12 each) | 0 (**silently "healthy"**) | | | | | **0** (**12 / 0**, escalated) |
| sensor bias 0.004 g (a sensor anomaly; not claimed healthy) | 100 | | | | | 100 (never accepted healthy) |
| fault in a wrongly attested warm-up (healthy rows) | 0 | | | | | 0 |

(Non-B+C columns list the false-FAULT percentage only. By-speed splits, score/threshold quantiles and all CIs are in the JSON.)

**Fault recall** (FAULT verdict; escalated sessions are not silent misses), control vs B+C, pooled over 6 fault types (n = 108 per severity per regime). The control's 1.00 under shift is **vacuous**: it alarms on healthy runs too.

| Regime | sev 0.1 | sev 0.3 | sev 0.6 |
|---|---|---|---|
| baseline | 0.83 / 0.83 | 1.00 / 1.00 | 1.00 / 1.00 |
| noise ×2 | 1.00 / 0.83 (+5 % escalated) | 1.00 / 1.00 | 1.00 / 1.00 |
| gain ×1.25 | 1.00 / 0.83 | 1.00 / 1.00 | 1.00 / 1.00 |
| session_shift | 0.95 / 0.87 | 1.00 / 1.00 | 1.00 / 1.00 |
| hard_shift | 1.00 / 0.92 | 1.00 / 1.00 | 1.00 / 1.00 |
| gradual drift | 1.00 / 0.67 (+33 % escalated) | 1.00 / 0.83 (+17 %) | 1.00 / 0.83 (+17 %) |
| unseen speeds | 0.00, 100 % silent miss / 0.00, 100 % escalated | same | same |

In the shift-free baseline regime B+C and the control make **identical** decisions on every fault type (imbalance, looseness, overload, both sensor-fault styles: 1.00; supply voltage 0.67 for both). Under shift, recall at severity ≥ 0.3 is unchanged (1.00) except gradual drift (0.83; the remainder escalated, none silent); severity-0.1 recall is no worse than the shift-free 0.83 in the noise / gain regimes. Median detection delay is 0 s for both (p90 ≤ 4.8 s).

## 6. Verdict against the acceptance criteria
* **Met.** The weakness was reproduced; candidates were compared with the unchanged control on session-separated held-out regimes; the test set was untouched during selection; the false-FAULT rate falls from 100 % to 0 % (noise ×2, gain ±20–25 %), 69 % → 14 % (session_shift) and 72 / 100 % → 0 % (drift / step, as escalations or accepted-healthy); unseen speeds are now explicit (the control silently called all 240 sessions at 600/2400 rpm healthy, including 216 real faults); adaptation is trusted-only, validated, versioned, audited, reversible, and did not absorb a hidden fault; recall at severity ≥ 0.3 is unchanged.
* **Not met / limits (kept visible).**
  1. **hard_shift: 36 % false FAULT**, session_shift 14 %. Post-hoc one-factor check on unused dev seeds: the residual comes from a healthy **current offset ≳ 0.06 A** (session_shift draws σ = 0.03 A), which is deliberately *not* adapted because the overload fault lives in that channel; at ±0.03 A and for supply / ambient shifts all 24 healthy runs were clean. Absorbing it would hide mild overload — a trade-off for a human decision, not made here.
  2. **Noise ×3 is outside the envelope** (22 % false FAULT, the rest escalated).
  3. **Mild (severity 0.1) faults pay for it:** recall 0.67–0.92 under shift vs 0.83 shift-free, and some become escalations instead of detections.
  4. **Robust statistics (A) and 4-session training did not help** under held-out shift; they address an outlier problem that is not the problem.
  5. Escalation is not free: 11–36 of 36 healthy noisy / drifting / stepped sessions are escalated instead of accepted — the system asks for evidence rather than guessing.
  6. The design assumption (healthy sensor shifts are common-mode, faults are channel-selective) is untested outside the simulator; a real sensor-gain fault is by construction indistinguishable from a healthy gain shift and is escalated, not diagnosed.
  7. Warm-up attestation is a human act; an unhealthy warm-up that is also coherent across channels and inside the envelope could be absorbed (floor: a 1.6× 1x-amplitude fault must still be flagged).
* **Decision.** B+C is integrated **opt-in** (default off, bit-identical behaviour) and is not claimed for hardware. No physical-hardware validation is claimed.
