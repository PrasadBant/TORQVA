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
