// Shared, mode-independent descriptions of TORQVA's diagnostic vocabulary. Presentation only: no data, no requests.
// Test descriptions follow the backend test library (backend/torqva/diagnostics.py) and its learned outcome signatures.

export const TEST_SPECS = {
  T1: {
    code: 'T1', name: 'Speed-Step Dynamic Response (T1)', short: 'Speed step to 70 %', duration_s: 40,
    target: 'Separates imbalance from looseness, and looseness from a faulty vibration channel.',
    method: 'The setpoint is stepped down to 70 % and held for 40 s. With imbalance, the 1x vibration and the 2x+3x harmonics both scale with roughly the square of speed; with looseness the harmonics scale far less steeply. The looseness exponent is a simulation modelling assumption and must be re-fitted on real fault data.',
    signals: ['1x Vibration Exponent', 'Harmonics (2x+3x) Exponent', 'Current-per-RPM Ratio'],
  },
  T3: {
    code: 'T3', name: 'Thermal Equilibrium Observation (T3)', short: 'Observe up to 300 s', duration_s: 300,
    target: 'Separates a cooling failure from an overload.',
    method: 'Speed is held while the housing temperature is compared with the learned thermal model for up to 300 s. The observation is the slope of the difference between the two.',
    signals: ['Housing Thermal Drift Slope (°C / 100 s)'],
  },
  T4: {
    code: 'T4', name: 'Inertial Coast-Down Deceleration (T4)', short: 'Driver disabled', duration_s: 40,
    target: 'Separates friction/overload from cooling or electrical faults.',
    method: 'The driver is disabled and a decay time constant tau is fitted to the speed over the following 40 s. The observation is ln tau.',
    signals: ['Deceleration Time Constant tau', 'ln(tau) Friction Metric'],
  },
};

// What each learned C4 outcome means, in the backend's own terms (diagnostics.py docstrings and the gate's look-alike rule).
export const TEST_OUTCOMES = {
  T1: ['Imbalance: the 1x vibration and the 2x+3x harmonics both scale with roughly the square of speed (exponents near 2).',
    'Looseness: the harmonics scale far less steeply than the 1x component.',
    'A faulty vibration channel does not follow the speed change the way a mechanical cause does.'],
  T3: ['Cooling failure: the housing warms faster than the learned thermal model predicts (positive residual slope).',
    'Overload: the extra heat follows the higher current, so the residual against the current-driven model stays smaller.'],
  T4: ['Friction or overload shortens the coast-down time constant tau; cooling and electrical faults leave it near its learned value.'],
};

// Labels for the C1 feature vector (backend sim.FEATURES). Vibration features come from the simulator's vibration model.
export const FEATURE_LABEL = {
  vib_rms: 'vibration RMS', v1x: '1x vibration', v2x: '2x harmonic', v3x: '3x harmonic', vhf: 'high-frequency vibration',
  i_per_krpm: 'current per 1000 rpm', duty: 'drive duty', thermal_resid: 'thermal residual', voltage: 'supply voltage', power: 'electrical power',
};

// C1 score statuses (backend detection.py) in plain language.
export const SCORE_STATUS = {
  OK: 'scored against the healthy baseline learned for this speed range',
  INTERPOLATED: 'scored against a baseline interpolated between learned speed ranges',
  FROZEN: 'scored against a frozen baseline',
  UNLEARNED_BIN: 'not scored: no healthy baseline was learned for this speed range',
  TRANSIENT: 'not scored: the speed is changing, so the window is neither evidence for nor against an anomaly',
  INVALID_INPUT: 'not scored: the window failed input validation',
};

// Outcome categories of a diagnostic sequence (backend workbench.run_sequence).
export const ASSESSMENT = {
  consistent_with_baseline: ['ok', 'Consistent with baseline over the tested conditions'],
  anomalous: ['warn', 'Anomalous response observed'],
  hypothesis_supported: ['info', 'Fault hypothesis supported by the evidence'],
  inconclusive: ['wait', 'Inconclusive — further testing recommended'],
  invalid: ['off', 'Invalid test — required measurements were unavailable'],
  aborted: ['stop', 'Test aborted'],
};
