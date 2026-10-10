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
