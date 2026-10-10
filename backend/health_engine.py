"""
Deterministic Baseline-Relative Health Engine & Anomaly Detection (Phase 5).
Compares live multi-parameter sensor telemetry against stored baseline calibration.
Calculates percentage deviations, evaluates thresholds, computes weighted condition scores,
and generates explainable anomaly records without using opaque ML models.
"""

import time
import math
from abc import ABC, abstractmethod
from typing import Optional, Dict, Any, List
from models import (
    TelemetryPayload,
    BaselineState,
    HealthResult,
    HealthStatus,
    AnomalyDetail,
    AnomalyType,
    AlertSeverity,
)
from config import AppConfig


class BaseHealthEngine(ABC):
    """Abstract boundary interface for motor condition and anomaly analysis engines."""

    @abstractmethod
    def evaluate(
        self,
        telemetry: Optional[TelemetryPayload],
        baseline: Optional[BaselineState],
        is_connected: bool,
        config: AppConfig
    ) -> HealthResult:
        """Evaluates telemetry against baseline and thresholds to generate a HealthResult."""
        pass


class RuleBasedHealthEngine(BaseHealthEngine):
    """
    Deterministic rule-based health estimation engine.
    Performs baseline-relative deviation analysis, respects sensor health flags,
    and produces explainable condition scores and anomaly advisories.
    """

    @staticmethod
    def _calc_deviation_percent(current: float, baseline: Optional[float]) -> Optional[float]:
        """Calculates signed percentage deviation relative to baseline: ((current - baseline) / |baseline|) * 100."""
        if baseline is None or math.isnan(baseline) or math.isinf(baseline) or abs(baseline) < 1e-5:
            return None
        return round(((current - baseline) / abs(baseline)) * 100.0, 1)

    def evaluate(
        self,
        telemetry: Optional[TelemetryPayload],
        baseline: Optional[BaselineState],
        is_connected: bool,
        config: AppConfig
    ) -> HealthResult:
        # 1. Handle Disconnected / Offline State
        if not is_connected or telemetry is None:
            return HealthResult(
                score=0.0,
                status=HealthStatus.OFFLINE,
                factors={
                    "temperature": 0.0,
                    "vibration": 0.0,
                    "rpm": 0.0,
                    "current": 0.0,
                    "power": 0.0
                },
                alerts=[],
                anomalies=[],
                explanations=["No live telemetry connection detected. Device is offline."],
                evaluated_sensors=[],
                unavailable_sensors=["adxl345", "ds18b20", "ina219", "a3144"],
                baseline_age_seconds=None,
                diagnostic_explanation="No live telemetry connection detected. Hardware node is offline."
            )

        # Track evaluated vs unavailable sensors based on sensor_health flags
        sensor_health = telemetry.sensor_health
        evaluated_sensors: List[str] = []
        unavailable_sensors: List[str] = []

        if sensor_health.ds18b20:
            evaluated_sensors.append("temperature")
        else:
            unavailable_sensors.append("ds18b20")

        if sensor_health.adxl345:
            evaluated_sensors.append("vibration_rms")
        else:
            unavailable_sensors.append("adxl345")

        if sensor_health.a3144:
            evaluated_sensors.append("rpm")
        else:
            unavailable_sensors.append("a3144")

        if sensor_health.ina219:
            evaluated_sensors.extend(["voltage", "current", "power"])
        else:
            unavailable_sensors.append("ina219")

        # 2. Handle Motor Stopped / Stationary State
        if not telemetry.motor_running:
            return HealthResult(
                score=100.0,
                status=HealthStatus.HEALTHY,
                factors={
                    "temperature": 100.0,
                    "vibration": 100.0,
                    "rpm": 100.0,
                    "current": 100.0,
                    "power": 100.0
                },
                alerts=[],
                anomalies=[],
                explanations=["Motor is stationary. Operating anomalies are evaluated while running."],
                evaluated_sensors=evaluated_sensors,
                unavailable_sensors=unavailable_sensors,
                baseline_age_seconds=(time.time() - baseline.saved_at) if (baseline and baseline.saved_at) else None,
                diagnostic_explanation="Motor is stationary. Operating condition is nominal while stopped."
            )

        # 3. Handle Missing / Unconfigured Baseline
        if baseline is None or baseline.status.value != "SAVED":
            return HealthResult(
                score=100.0,
                status=HealthStatus.BASELINE_REQUIRED,
                factors={
                    "temperature": 100.0,
                    "vibration": 100.0,
                    "rpm": 100.0,
                    "current": 100.0,
                    "power": 100.0
                },
                alerts=[],
                anomalies=[],
                explanations=["Baseline calibration is required for baseline-relative anomaly detection."],
                evaluated_sensors=evaluated_sensors,
                unavailable_sensors=unavailable_sensors,
                baseline_age_seconds=None,
                diagnostic_explanation="Live telemetry active. Baseline calibration is required to establish nominal reference operating conditions."
            )

        baseline_age = (time.time() - baseline.saved_at) if baseline.saved_at else None

        # 4. Multi-Parameter Baseline-Relative Evaluation
        factors: Dict[str, float] = {
            "temperature": 100.0,
            "vibration": 100.0,
            "rpm": 100.0,
            "current": 100.0,
            "power": 100.0
        }
        anomalies: List[AnomalyDetail] = []
        alerts: List[Dict[str, Any]] = []
        explanations: List[str] = []

        dev_limits = config.baseline_deviations

        # --- A. Temperature Evaluation ---
        if sensor_health.ds18b20 and baseline.temperature is not None:
            dev_t = self._calc_deviation_percent(telemetry.temperature, baseline.temperature)
            is_crit = (dev_t is not None and dev_t >= dev_limits.temperature_critical_percent) or (telemetry.temperature >= config.temperature.critical)
            is_warn = (dev_t is not None and dev_t >= dev_limits.temperature_warning_percent) or (telemetry.temperature >= config.temperature.warning)

            if is_crit:
                factors["temperature"] = 20.0
                dev_str = f"{dev_t:+.1f}%" if dev_t is not None else "N/A"
                msg = f"Temperature {telemetry.temperature:.1f}°C is {dev_str} relative to baseline ({baseline.temperature:.1f}°C)."
                anom = AnomalyDetail(
                    sensor="temperature",
                    type=AnomalyType.ABOVE_BASELINE if (dev_t and dev_t > 0) else AnomalyType.ABSOLUTE_LIMIT_EXCEEDED,
                    severity=AlertSeverity.CRITICAL,
                    current=telemetry.temperature,
                    baseline=baseline.temperature,
                    deviation_percent=dev_t,
                    message=msg,
                    suggested_inspection="Inspect motor cooling, airflow clearance, ventilation path, and ambient thermal conditions."
                )
                anomalies.append(anom)
                alerts.append({
                    "severity": "CRITICAL",
                    "parameter": "temperature",
                    "title": "Critical Motor Temperature",
                    "message": msg,
                    "current_value": telemetry.temperature,
                    "baseline_value": baseline.temperature,
                    "suggested_inspection": anom.suggested_inspection
                })
                explanations.append(msg)
            elif is_warn:
                factors["temperature"] = 60.0
                dev_str = f"{dev_t:+.1f}%" if dev_t is not None else "N/A"
                msg = f"Temperature {telemetry.temperature:.1f}°C is {dev_str} above baseline ({baseline.temperature:.1f}°C)."
                anom = AnomalyDetail(
                    sensor="temperature",
                    type=AnomalyType.ABOVE_BASELINE,
                    severity=AlertSeverity.WARNING,
                    current=telemetry.temperature,
                    baseline=baseline.temperature,
                    deviation_percent=dev_t,
                    message=msg,
                    suggested_inspection="Monitor thermal trend and verify motor casing ventilation."
                )
                anomalies.append(anom)
                alerts.append({
                    "severity": "WARNING",
                    "parameter": "temperature",
                    "title": "Elevated Temperature Rise",
                    "message": msg,
                    "current_value": telemetry.temperature,
                    "baseline_value": baseline.temperature,
                    "suggested_inspection": anom.suggested_inspection
                })
                explanations.append(msg)
            else:
                explanations.append(f"Temperature ({telemetry.temperature:.1f}°C) is within nominal baseline range.")
        elif not sensor_health.ds18b20:
            explanations.append("Temperature sensor (DS18B20) is unavailable; excluded from health scoring.")

        # --- B. Vibration RMS Evaluation ---
        if sensor_health.adxl345 and baseline.vibration_rms is not None:
            dev_v = self._calc_deviation_percent(telemetry.vibration_rms, baseline.vibration_rms)
            is_crit = (dev_v is not None and dev_v >= dev_limits.vibration_critical_percent) or (telemetry.vibration_rms >= config.vibration_rms.critical)
            is_warn = (dev_v is not None and dev_v >= dev_limits.vibration_warning_percent) or (telemetry.vibration_rms >= config.vibration_rms.warning)

            if is_crit:
                factors["vibration"] = 20.0
                dev_str = f"{dev_v:+.1f}%" if dev_v is not None else "N/A"
                msg = f"Vibration RMS {telemetry.vibration_rms:.3f}g is {dev_str} relative to baseline ({baseline.vibration_rms:.3f}g)."
                anom = AnomalyDetail(
                    sensor="vibration_rms",
                    type=AnomalyType.ABOVE_BASELINE if (dev_v and dev_v > 0) else AnomalyType.ABSOLUTE_LIMIT_EXCEEDED,
                    severity=AlertSeverity.CRITICAL,
                    current=telemetry.vibration_rms,
                    baseline=baseline.vibration_rms,
                    deviation_percent=dev_v,
                    message=msg,
                    suggested_inspection="Inspect motor mounting bolts, shaft alignment, coupling balance, and bearing wear."
                )
                anomalies.append(anom)
                alerts.append({
                    "severity": "CRITICAL",
                    "parameter": "vibration",
                    "title": "Critical Vibration Oscillation",
                    "message": msg,
                    "current_value": telemetry.vibration_rms,
                    "baseline_value": baseline.vibration_rms,
                    "suggested_inspection": anom.suggested_inspection
                })
                explanations.append(msg)
            elif is_warn:
                factors["vibration"] = 60.0
                dev_str = f"{dev_v:+.1f}%" if dev_v is not None else "N/A"
                msg = f"Vibration RMS {telemetry.vibration_rms:.3f}g is {dev_str} above baseline ({baseline.vibration_rms:.3f}g)."
                anom = AnomalyDetail(
                    sensor="vibration_rms",
                    type=AnomalyType.ABOVE_BASELINE,
                    severity=AlertSeverity.WARNING,
                    current=telemetry.vibration_rms,
                    baseline=baseline.vibration_rms,
                    deviation_percent=dev_v,
                    message=msg,
                    suggested_inspection="Check motor mounting rigidity and mechanical load balance."
                )
                anomalies.append(anom)
                alerts.append({
                    "severity": "WARNING",
                    "parameter": "vibration",
                    "title": "Elevated Vibration",
                    "message": msg,
                    "current_value": telemetry.vibration_rms,
                    "baseline_value": baseline.vibration_rms,
                    "suggested_inspection": anom.suggested_inspection
                })
                explanations.append(msg)
            else:
                explanations.append(f"Vibration RMS ({telemetry.vibration_rms:.3f}g) is within nominal baseline range.")
        elif not sensor_health.adxl345:
            explanations.append("Vibration sensor (ADXL345) is unavailable; excluded from health scoring.")

        # --- C. RPM Evaluation ---
        if sensor_health.a3144 and baseline.rpm is not None and baseline.rpm > 100.0:
            dev_r = self._calc_deviation_percent(telemetry.rpm, baseline.rpm)
            abs_dev_r = abs(dev_r) if dev_r is not None else 0.0
            is_crit = (abs_dev_r >= dev_limits.rpm_critical_percent) or (telemetry.rpm <= config.rpm.min_critical) or (telemetry.rpm >= config.rpm.max_critical)
            is_warn = (abs_dev_r >= dev_limits.rpm_warning_percent) or (telemetry.rpm <= config.rpm.min_warning) or (telemetry.rpm >= config.rpm.max_warning)

            if is_crit:
                factors["rpm"] = 20.0
                direction_str = "below" if (dev_r and dev_r < 0) else "above"
                anom_type = AnomalyType.BELOW_BASELINE if (dev_r and dev_r < 0) else AnomalyType.ABOVE_BASELINE
                msg = f"Shaft speed {telemetry.rpm:.0f} RPM is {abs_dev_r:.1f}% {direction_str} baseline ({baseline.rpm:.0f} RPM)."
                anom = AnomalyDetail(
                    sensor="rpm",
                    type=anom_type,
                    severity=AlertSeverity.CRITICAL,
                    current=telemetry.rpm,
                    baseline=baseline.rpm,
                    deviation_percent=dev_r,
                    message=msg,
                    suggested_inspection="Inspect mechanical load resistance, shaft coupling, and supply voltage."
                )
                anomalies.append(anom)
                alerts.append({
                    "severity": "CRITICAL",
                    "parameter": "rpm",
                    "title": "Severe Speed Drift Anomaly",
                    "message": msg,
                    "current_value": telemetry.rpm,
                    "baseline_value": baseline.rpm,
                    "suggested_inspection": anom.suggested_inspection
                })
                explanations.append(msg)
            elif is_warn:
                factors["rpm"] = 60.0
                direction_str = "below" if (dev_r and dev_r < 0) else "above"
                anom_type = AnomalyType.BELOW_BASELINE if (dev_r and dev_r < 0) else AnomalyType.ABOVE_BASELINE
                msg = f"Shaft speed {telemetry.rpm:.0f} RPM is {abs_dev_r:.1f}% {direction_str} baseline ({baseline.rpm:.0f} RPM)."
                anom = AnomalyDetail(
                    sensor="rpm",
                    type=anom_type,
                    severity=AlertSeverity.WARNING,
                    current=telemetry.rpm,
                    baseline=baseline.rpm,
                    deviation_percent=dev_r,
                    message=msg,
                    suggested_inspection="Verify motor drive voltage stability and mechanical load consistency."
                )
                anomalies.append(anom)
                alerts.append({
                    "severity": "WARNING",
                    "parameter": "rpm",
                    "title": "Moderate Speed Deviation",
                    "message": msg,
                    "current_value": telemetry.rpm,
                    "baseline_value": baseline.rpm,
                    "suggested_inspection": anom.suggested_inspection
                })
                explanations.append(msg)
            else:
                explanations.append(f"Shaft speed ({telemetry.rpm:.0f} RPM) is within nominal baseline range.")
        elif not sensor_health.a3144:
            explanations.append("RPM sensor (A3144) is unavailable; excluded from health scoring.")

        # --- D. Current Evaluation ---
        if sensor_health.ina219 and baseline.current is not None:
            dev_i = self._calc_deviation_percent(telemetry.current, baseline.current)
            is_crit = (dev_i is not None and dev_i >= dev_limits.current_critical_percent) or (telemetry.current >= config.current.critical)
            is_warn = (dev_i is not None and dev_i >= dev_limits.current_warning_percent) or (telemetry.current >= config.current.warning)

            if is_crit:
                factors["current"] = 20.0
                dev_str = f"{dev_i:+.1f}%" if dev_i is not None else "N/A"
                msg = f"Current draw {telemetry.current:.2f}A is {dev_str} relative to baseline ({baseline.current:.2f}A)."
                anom = AnomalyDetail(
                    sensor="current",
                    type=AnomalyType.ABOVE_BASELINE if (dev_i and dev_i > 0) else AnomalyType.ABSOLUTE_LIMIT_EXCEEDED,
                    severity=AlertSeverity.CRITICAL,
                    current=telemetry.current,
                    baseline=baseline.current,
                    deviation_percent=dev_i,
                    message=msg,
                    suggested_inspection="Inspect for mechanical binding, excessive friction, or electrical overload."
                )
                anomalies.append(anom)
                alerts.append({
                    "severity": "CRITICAL",
                    "parameter": "current",
                    "title": "Critical Current Draw",
                    "message": msg,
                    "current_value": telemetry.current,
                    "baseline_value": baseline.current,
                    "suggested_inspection": anom.suggested_inspection
                })
                explanations.append(msg)
            elif is_warn:
                factors["current"] = 60.0
                dev_str = f"{dev_i:+.1f}%" if dev_i is not None else "N/A"
                msg = f"Current draw {telemetry.current:.2f}A is {dev_str} above baseline ({baseline.current:.2f}A)."
                anom = AnomalyDetail(
                    sensor="current",
                    type=AnomalyType.ABOVE_BASELINE,
                    severity=AlertSeverity.WARNING,
                    current=telemetry.current,
                    baseline=baseline.current,
                    deviation_percent=dev_i,
                    message=msg,
                    suggested_inspection="Inspect motor load condition and drive temperature."
                )
                anomalies.append(anom)
                alerts.append({
                    "severity": "WARNING",
                    "parameter": "current",
                    "title": "Elevated Current Draw",
                    "message": msg,
                    "current_value": telemetry.current,
                    "baseline_value": baseline.current,
                    "suggested_inspection": anom.suggested_inspection
                })
                explanations.append(msg)
            else:
                explanations.append(f"Current draw ({telemetry.current:.2f}A) is within nominal baseline range.")
        elif not sensor_health.ina219:
            explanations.append("Power monitor (INA219) is unavailable; current excluded from health scoring.")

        # --- E. Power Evaluation ---
        current_power = telemetry.power if telemetry.power is not None else (telemetry.voltage * telemetry.current)
        if sensor_health.ina219 and baseline.power is not None:
            dev_p = self._calc_deviation_percent(current_power, baseline.power)
            is_crit = (dev_p is not None and dev_p >= dev_limits.power_critical_percent) or (current_power >= config.power.critical)
            is_warn = (dev_p is not None and dev_p >= dev_limits.power_warning_percent) or (current_power >= config.power.warning)

            if is_crit:
                factors["power"] = 20.0
                dev_str = f"{dev_p:+.1f}%" if dev_p is not None else "N/A"
                msg = f"Active power {current_power:.1f}W is {dev_str} relative to baseline ({baseline.power:.1f}W)."
                anom = AnomalyDetail(
                    sensor="power",
                    type=AnomalyType.ABOVE_BASELINE if (dev_p and dev_p > 0) else AnomalyType.ABSOLUTE_LIMIT_EXCEEDED,
                    severity=AlertSeverity.CRITICAL,
                    current=current_power,
                    baseline=baseline.power,
                    deviation_percent=dev_p,
                    message=msg,
                    suggested_inspection="Inspect electrical supply efficiency and overall motor electrical impedance."
                )
                anomalies.append(anom)
                alerts.append({
                    "severity": "CRITICAL",
                    "parameter": "power",
                    "title": "Critical Power Draw",
                    "message": msg,
                    "current_value": current_power,
                    "baseline_value": baseline.power,
                    "suggested_inspection": anom.suggested_inspection
                })
                explanations.append(msg)
            elif is_warn:
                factors["power"] = 60.0
                dev_str = f"{dev_p:+.1f}%" if dev_p is not None else "N/A"
                msg = f"Active power {current_power:.1f}W is {dev_str} above baseline ({baseline.power:.1f}W)."
                anom = AnomalyDetail(
                    sensor="power",
                    type=AnomalyType.ABOVE_BASELINE,
                    severity=AlertSeverity.WARNING,
                    current=current_power,
                    baseline=baseline.power,
                    deviation_percent=dev_p,
                    message=msg,
                    suggested_inspection="Verify electrical loading and drive train resistance."
                )
                anomalies.append(anom)
                alerts.append({
                    "severity": "WARNING",
                    "parameter": "power",
                    "title": "Elevated Power Draw",
                    "message": msg,
                    "current_value": current_power,
                    "baseline_value": baseline.power,
                    "suggested_inspection": anom.suggested_inspection
                })
                explanations.append(msg)
            else:
                explanations.append(f"Active power ({current_power:.1f}W) is within nominal baseline range.")
        elif not sensor_health.ina219:
            explanations.append("Power monitor (INA219) is unavailable; power excluded from health scoring.")

        # 5. Weighted Score Calculation Normalized Across Healthy Sensors
        w = config.health_weights
        weights_map = {
            "temperature": w.temperature if sensor_health.ds18b20 else 0.0,
            "vibration": w.vibration if sensor_health.adxl345 else 0.0,
            "rpm": w.rpm if sensor_health.a3144 else 0.0,
            "current": w.current if sensor_health.ina219 else 0.0,
            "power": w.power if sensor_health.ina219 else 0.0,
        }
        total_weight = sum(weights_map.values())

        if total_weight > 0.0:
            raw_score = sum(factors[k] * weights_map[k] for k in weights_map) / total_weight
        else:
            raw_score = 100.0

        total_score = round(max(0.0, min(100.0, raw_score)), 1)

        # 6. Overall Health Status Classification
        if any(a.severity == AlertSeverity.CRITICAL for a in anomalies) or total_score < 50.0:
            status = HealthStatus.CRITICAL
            diagnostic_summary = "Significant anomaly detected relative to learned baseline. Mechanical and electrical inspection advised."
        elif any(a.severity == AlertSeverity.WARNING for a in anomalies) or total_score < 85.0:
            status = HealthStatus.WARNING
            diagnostic_summary = "Operating parameters show noticeable deviation from baseline conditions. Continued monitoring recommended."
        else:
            status = HealthStatus.HEALTHY
            diagnostic_summary = "All monitored parameters are operating in close alignment with baseline calibration."

        return HealthResult(
            score=total_score,
            status=status,
            factors=factors,
            alerts=alerts,
            anomalies=anomalies,
            explanations=explanations,
            evaluated_sensors=evaluated_sensors,
            unavailable_sensors=unavailable_sensors,
            baseline_age_seconds=baseline_age,
            diagnostic_explanation=diagnostic_summary
        )


# Global singleton instance
health_engine: BaseHealthEngine = RuleBasedHealthEngine()
