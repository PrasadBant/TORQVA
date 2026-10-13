# System Development Phases & Roadmap

This project is executed through 10 distinct, sequential phases to guarantee architectural cleanliness, reliable hardware integration, and a production-grade predictive maintenance platform.

---

## Phase Breakdown

### Phase 1: Foundation & Communication Architecture *(Current Phase)*
- Establish folder structure and clean separation of concerns.
- Create FastAPI backend with Pydantic validation, SQLite storage schema, and WebSocket manager.
- Formulate data contracts, API specifications, and command queues.
- Define ESP32 firmware skeleton with modular sensor abstractions.
- Execute unit and integration tests for backend contract verification.

### Phase 2: Backend Telemetry Ingestion & Database
- Implement high-throughput telemetry ingestion pipeline.
- Build historical aggregation, time-series query APIs, and SQLite query indexing.
- Implement automated heartbeat monitors and stale connection watchdog routines.

### Phase 3: ESP32 Real Sensor Integration
- Wire and integrate ADXL345 (I2C), DS18B20 (OneWire), INA219 (I2C), and A3144 (Interrupt) on ESP32-S3.
- Implement digital filtering, interrupt debounce, and vibration RMS calculation algorithms.
- Verify hardware telemetry accuracy and live HTTP POST transmission.

### Phase 4.1: Dashboard Validation & Bug Fix Pass *(Completed)*
- Integration review between FastAPI backend and React frontend.
- Validated state synchronization across all 7 sensor streams, health radial gauge, and alerts feed.
- Verified all 16 Vitest frontend tests and 11 backend API tests passing.

### Phase 5: Health Engine & Baseline-Relative Anomaly Detection *(Completed)*
- Built deterministic `RuleBasedHealthEngine` evaluating live telemetry against 30-second steady-state baseline.
- Implemented transparent percentage deviation calculation: $\text{deviation\_percent} = \frac{\text{current} - \text{baseline}}{|\text{baseline}|} \times 100$.
- Centralized configurable deviation thresholds in `BaselineDeviationThresholds` (warning / critical percentages).
- Sensor health isolation: hardware failures (`sensor_health == false`) exclude metric from scoring without false penalties.
- Motor stopped state handling: suppresses RPM and load anomalies when motor is not running.
- Alert deduplication and lifecycle management (`ACTIVE` vs `RESOLVED`) in SQLite.
- Verified with 28 passing backend tests (11 API + 17 Health Engine tests) and 16 passing frontend tests.
- *Note*: Physical ESP32-S3 + sensor + motor bench validation is pending physical hardware connection.

### Phase 6: Machine Learning Model Exploration & Edge Deployment *(Upcoming)*
- Construct modern industrial telemetry dashboard shell using React and Vite.
- Implement responsive layout, glassmorphic dark mode styling, and navigation.
- Implement WebSocket consumer hooks for seamless real-time UI state synchronization.

### Phase 7: Live Charts, Alerts & Historical Analytics
- Integrate high-performance live time-series charts (vibration, temperature, RPM, electrical power).
- Implement interactive alert feeds with severity filtering and inspection recommendations.
- Add historical playback and telemetry log export capabilities.

### Phase 8: Demo Mode & Fault Injection Simulator
- Finalize the synthetic telemetry engine supporting normal, high temperature, high vibration, low RPM, high current, and compound anomaly profiles.
- Add UI controls for switching simulation modes for demonstrations without physical hardware.

### Phase 9: Full End-to-End Integration Testing
- Test complete closed-loop pipeline: Physical Sensors → ESP32 → FastAPI → SQLite → WebSocket → React UI.
- Verify recovery during Wi-Fi disconnection, backend restarts, and sensor fault injection.

### Phase 10: Hackathon Polish & Presentation
- Fine-tune micro-interactions, responsive typography, and diagnostic UX.
- Prepare project documentation, architectural diagrams, and video demonstration assets.
