# Phase 5: Health Engine & Baseline-Relative Anomaly Detection Report

## 1. What Was Implemented
- **Deterministic Baseline-Relative Health Engine (`RuleBasedHealthEngine`)**: Built an explainable rule-based evaluation engine in [backend/health_engine.py](file:///c:/Users/dkdar/.gemini/antigravity-ide/scratch/smart-motor-monitor/backend/health_engine.py) that compares incoming telemetry against a stored 30-second baseline reference profile.
- **Configurable Centralized Thresholds (`BaselineDeviationThresholds`)**: Extended [backend/config.py](file:///c:/Users/dkdar/.gemini/antigravity-ide/scratch/smart-motor-monitor/backend/config.py) to manage baseline deviation percentages for all monitored parameters (temperature, vibration, RPM, current, power, voltage).
- **Structured Anomaly & Alert Models**: Added machine-readable enum classes (`AnomalyType`, `AlertSeverity`), `AnomalyDetail`, and extended `HealthResult` and `AlertRecord` in [backend/models.py](file:///c:/Users/dkdar/.gemini/antigravity-ide/scratch/smart-motor-monitor/backend/models.py).
- **Sensor Health Isolation**: Missing or faulty hardware sensors (`sensor_health.* == false`) are marked as `UNAVAILABLE` and excluded from scoring without false penalties or converting failure into synthetic zero values.
- **Motor Running State Intelligence**: Differentiates between active running and idle/stopped conditions to prevent false RPM or electrical load warnings when `motor_running == false`.
- **Alert Deduplication & Lifecycle (`ACTIVE` / `RESOLVED`)**: Implemented high-frequency alert deduplication in [backend/data_storage.py](file:///c:/Users/dkdar/.gemini/antigravity-ide/scratch/smart-motor-monitor/backend/data_storage.py) to update existing active alerts rather than flooding SQLite with duplicate rows, and automatically mark alerts `RESOLVED` when parameters normalize.
- **REST & WebSocket Integration**: Enhanced `GET /api/health`, added `GET /api/alerts`, and stream structured `health` events over `/ws`.

---

## 2. Health Calculation Formula
For each monitored metric with a valid baseline ($b$) and live measurement ($m$):
$$\text{deviation\_percent} = \frac{m - b}{|b|} \times 100$$
- If baseline is zero or near-zero ($|b| < 10^{-6}$), absolute deviation is used to guarantee division-by-zero safety.
- Directionality is preserved:
  - Positive deviation ($m > b$): `ABOVE_BASELINE` (e.g., *"Vibration RMS is 38% above baseline."*)
  - Negative deviation ($m < b$): `BELOW_BASELINE` (e.g., *"Shaft speed is 18% below baseline."*)

---

## 3. Thresholds
Thresholds are centralized in `BaselineDeviationThresholds` in [backend/config.py](file:///c:/Users/dkdar/.gemini/antigravity-ide/scratch/smart-motor-monitor/backend/config.py):
- **Temperature**: Warning: $+15.0\%$, Critical: $+35.0\%$ (or absolute $>70.0^\circ\text{C}$)
- **Vibration RMS**: Warning: $+25.0\%$, Critical: $+60.0\%$ (or absolute $>1.20\text{g}$)
- **RPM**: Warning: $\pm 10.0\%$, Critical: $\pm 25.0\%$ (or absolute $<500.0\text{ RPM}$ under load)
- **Current**: Warning: $+20.0\%$, Critical: $+50.0\%$ (or absolute $>4.0\text{A}$)
- **Power**: Warning: $+20.0\%$, Critical: $+50.0\%$ (or absolute $>96.0\text{W}$)
- **Voltage**: Warning: $\pm 8.0\%$, Critical: $\pm 15.0\%$

*Note: These are initial engineering thresholds designed to be tuned following empirical physical bench testing.*

---

## 4. Score Calculation
- The score starts at $100.0$ (representing nominal operating condition).
- For each evaluated parameter factor:
  - Nominal condition: $100.0$
  - Warning condition: $60.0$ ($-40.0$ factor penalty)
  - Critical condition: $20.0$ ($-80.0$ factor penalty)
- The global Motor Health Score is computed as the normalized weighted average across all **healthy, available sensors**:
$$\text{Health Score} = \frac{\sum (\text{factor}_i \times w_i)}{\sum w_i}$$
- Clamped strictly: $0.0 \le \text{Score} \le 100.0$.
- Status mapping:
  - `HEALTHY`: No anomalies detected and Score $\ge 85.0$
  - `WARNING`: Warning anomalies detected or Score $< 85.0$
  - `CRITICAL`: Critical anomalies detected or Score $< 50.0$
  - `NO_BASELINE`: Baseline not configured / unavailable
  - `OFFLINE`: Hardware telemetry disconnected

---

## 5. Sensor Weighting
Configured in `HealthWeightsConfig` in [backend/config.py](file:///c:/Users/dkdar/.gemini/antigravity-ide/scratch/smart-motor-monitor/backend/config.py):
- **Vibration**: $0.30$ (High importance for mechanical integrity, bearing wear, alignment)
- **Temperature**: $0.25$ (High importance for winding overheating and ventilation)
- **Current**: $0.20$ (Medium-high importance for mechanical binding/torque overload)
- **Power**: $0.15$ (Medium importance for electrical efficiency)
- **RPM**: $0.10$ (Medium importance for speed stability)

If any sensor is offline, its weight is set to $0.0$ and remaining weights re-normalize, preventing artificial score degradation due to disconnected sensor buses.

---

## 6. Sensor Failure Handling
- If `sensor_health.adxl345 == false`: Vibration RMS is marked as `UNAVAILABLE`, excluded from health factors, and omitted from anomaly generation.
- If `sensor_health.ds18b20 == false`: Temperature is marked as `UNAVAILABLE` and excluded from scoring.
- If `sensor_health.ina219 == false`: Voltage, current, and power are marked as `UNAVAILABLE` and excluded from scoring.
- If `sensor_health.a3144 == false`: RPM is marked as `UNAVAILABLE` and excluded from scoring.
- Sensor failure is clearly reported in `HealthResult.unavailable_sensors` and `HealthResult.explanations`. Hardware communication failure is never converted to an anomaly or synthetic $0$ measurement.

---

## 7. Motor Stopped Behavior
- When `motor_running == false`:
  - RPM deviations are suppressed ($0\text{ RPM}$ is normal for a stopped motor).
  - Current and power draw near zero are marked as normal idle state.
  - Temperature and vibration continue to be checked for thermal dissipation or external bench disturbances.
  - Explanations explicitly note: *"Motor is stopped; RPM and active electrical load monitoring are in idle state."*

---

## 8. Anomaly Types
Defined as machine-readable enums (`AnomalyType`):
- `ABOVE_BASELINE`: Parameter exceeds baseline reference by more than the configured percentage.
- `BELOW_BASELINE`: Parameter drops below baseline reference (e.g. RPM drop under load).
- `ABSOLUTE_LIMIT_EXCEEDED`: Parameter exceeds maximum physical motor rating.
- `SENSOR_UNAVAILABLE`: Sensor hardware bus is offline.
- `NO_BASELINE`: Baseline calibration has not been performed.
- `INVALID_VALUE`: Telemetry contained non-numeric or out-of-bounds data.

---

## 9. Alert Lifecycle
Alerts transition through explicit lifecycle states:
- `ACTIVE`: Created when a parameter first enters an anomaly state. If the condition persists across subsequent frames, the existing active alert is updated with the latest measurement rather than inserting duplicate records.
- `RESOLVED`: When live telemetry returns within nominal limits, `resolve_cleared_alerts()` marks all active alerts for that parameter as `RESOLVED` with a `resolved_at` timestamp.

---

## 10. Deduplication Strategy
- During continuous 1 Hz telemetry streaming, persistent abnormal conditions (e.g., elevated vibration for 60 seconds) execute `save_alert_with_deduplication()`:
  - Checks SQLite for an `ACTIVE` alert with matching `parameter`, `severity`, and `source`.
  - If found, updates `timestamp`, `current_value`, and `message` in place.
  - Inserts a new alert row only when the anomaly severity changes or after the previous condition was resolved.

---

## 11. API Changes
- **`GET /api/health`**: Returns complete `HealthResult` object with `score`, `status`, `factors`, `alerts`, `anomalies`, `explanations`, `evaluated_sensors`, `unavailable_sensors`, `baseline_age_seconds`, and `diagnostic_explanation`.
- **`GET /api/alerts`**: Added endpoint to query historical and active alerts with optional `?active_only=true` and `?source=live` query parameters.
- **`GET /api/config`**: Returns baseline deviation threshold configurations alongside operational thresholds.

---

## 12. WebSocket Changes
- Upon each ingested telemetry frame, the backend evaluates the health engine and broadcasts:
  - Event `telemetry`: Full validated sensor payload.
  - Event `health`: Full structured `HealthResult` payload.
  - Event `connection`: Heartbeat state machine updates.

---

## 13. Tests Added
Created [backend/tests/test_health_engine.py](file:///c:/Users/dkdar/.gemini/antigravity-ide/scratch/smart-motor-monitor/backend/tests/test_health_engine.py) covering all 17 Phase 5 scenarios:
1. `test_1_no_baseline`: Returns `NO_BASELINE` status when baseline is not configured.
2. `test_2_valid_baseline_normal_telemetry`: Normal telemetry produces $\ge 95$ score and `HEALTHY` status.
3. `test_3_temperature_above_warning_threshold`: Elevated temperature triggers `WARNING` anomaly.
4. `test_4_temperature_above_critical_threshold`: Critical temperature triggers `CRITICAL` anomaly.
5. `test_5_vibration_above_warning_threshold`: Elevated vibration triggers `WARNING` anomaly.
6. `test_6_vibration_above_critical_threshold`: Critical vibration triggers `CRITICAL` anomaly.
7. `test_7_multiple_simultaneous_anomalies`: Compound anomalies produce combined penalty and `CRITICAL` status.
8. `test_8_sensor_unavailable_isolation`: Faulty sensor (`sensor_health.ina219=False`) is isolated without penalty.
9. `test_9_nan_inf_safety_and_rejection`: Pydantic rejects NaN/Inf payloads with 422.
10. `test_10_motor_stopped_behavior`: Motor stopped suppresses RPM anomalies and handles idle load safely.
11. `test_11_rpm_anomaly_while_motor_running`: RPM drop while running triggers `BELOW_BASELINE` anomaly.
12. `test_12_rpm_ignored_while_motor_stopped`: RPM at 0 while stopped is treated as normal idle state.
13. `test_13_health_score_clamping`: Heavy penalties clamp score to $[0.0, 100.0]$.
14. `test_14_alert_deduplication`: Consecutive anomaly frames update the same alert record.
15. `test_15_alert_resolution`: Cleared anomalies mark active alerts as `RESOLVED`.
16. `test_16_health_rest_endpoint`: `GET /api/health` returns structured factors and explanations.
17. `test_17_websocket_health_event_broadcast`: Ingested telemetry broadcasts `health` event over WebSocket.

---

## 14. Test Results
- **Backend Test Suite**: **28 / 28 tests passed** (11 Phase 2 API tests + 17 Phase 5 Health Engine tests).
  ```
  backend/tests/test_api.py ........... [39%]
  backend/tests/test_health_engine.py ................. [100%]
  ======================== 28 passed, 1 warning in 0.74s ========================
  ```
- **Frontend Test Suite**: **16 / 16 tests passed**.
  ```
  Test Files  1 passed (1)
  Tests       16 passed (16)
  Duration    1.59s
  ```

---

## 15. Build Result
Frontend production build via Vite succeeded cleanly:
```
dist/index.html                   0.50 kB │ gzip:   0.33 kB
dist/assets/index-DlKCcDXm.css    1.67 kB │ gzip:   0.83 kB
dist/assets/index-Cm58YsTy.js   594.83 kB │ gzip: 167.53 kB
✓ built in 3.98s
```

---

## 16. Known Limitations
- The baseline-relative health engine is strictly deterministic and rule-based; it does not perform predictive failure forecasting or time-to-failure regression (reserved for future ML exploration).
- Thresholds are initial engineering estimates and will require fine-tuning with specific motor loads and mounting dynamics.

---

## 17. Hardware Validation Status
**IMPORTANT**: Physical ESP32-S3 + sensor + motor bench validation has NOT been performed unless actually connected and tested. Telemetry validation in this phase has been verified via unit tests, simulated payloads, and contract validation.
