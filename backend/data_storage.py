"""
Database storage layer using SQLite.
Supports real-time telemetry persistence, historical time-series retrieval,
parameterized queries, index optimization, automated retention cleanup,
and deduplicated alert lifecycle management (ACTIVE/RESOLVED).
"""

import json
import sqlite3
import time
import os
from typing import Optional, List, Dict, Any
from pathlib import Path
from models import TelemetryPayload, BaselineState, AlertRecord


class DataStorage:
    def __init__(self, db_path: str = "data/motor_monitor.db"):
        self.db_path = db_path
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self.init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def init_db(self) -> None:
        """Initializes SQLite schema for telemetry, baseline, and alerts with proper indexing and auto-migration."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            
            # Telemetry Table with X/Y/Z vibration & server reception timestamps
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS telemetry (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp REAL NOT NULL,
                    server_received_at REAL NOT NULL,
                    source TEXT NOT NULL,
                    device_id TEXT NOT NULL,
                    temperature REAL NOT NULL,
                    vibration_x REAL NOT NULL,
                    vibration_y REAL NOT NULL,
                    vibration_z REAL NOT NULL,
                    vibration_rms REAL NOT NULL,
                    rpm REAL NOT NULL,
                    voltage REAL NOT NULL,
                    current REAL NOT NULL,
                    power REAL NOT NULL,
                    health_score REAL,
                    status TEXT,
                    motor_running INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                )
            """)

            # Automatic Schema Migration Check for telemetry table
            cursor.execute("PRAGMA table_info(telemetry)")
            existing_telemetry_cols = {row["name"] for row in cursor.fetchall()}
            
            if "server_received_at" not in existing_telemetry_cols:
                cursor.execute("ALTER TABLE telemetry ADD COLUMN server_received_at REAL DEFAULT 0.0")
            if "vibration_x" not in existing_telemetry_cols:
                cursor.execute("ALTER TABLE telemetry ADD COLUMN vibration_x REAL DEFAULT 0.0")
            if "vibration_y" not in existing_telemetry_cols:
                cursor.execute("ALTER TABLE telemetry ADD COLUMN vibration_y REAL DEFAULT 0.0")
            if "vibration_z" not in existing_telemetry_cols:
                cursor.execute("ALTER TABLE telemetry ADD COLUMN vibration_z REAL DEFAULT 0.0")
            
            # High performance indexing
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry(timestamp DESC)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_telemetry_device_id ON telemetry(device_id)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_telemetry_source ON telemetry(source)
            """)

            # Baseline Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS baseline (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    saved_at REAL NOT NULL,
                    temperature REAL NOT NULL,
                    vibration_rms REAL NOT NULL,
                    voltage REAL NOT NULL,
                    current REAL NOT NULL,
                    power REAL NOT NULL,
                    rpm REAL NOT NULL,
                    samples INTEGER NOT NULL,
                    duration_seconds REAL NOT NULL
                )
            """)

            # Alerts Table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp REAL NOT NULL,
                    severity TEXT NOT NULL,
                    parameter TEXT NOT NULL,
                    title TEXT NOT NULL,
                    message TEXT NOT NULL,
                    current_value REAL NOT NULL,
                    baseline_value REAL,
                    suggested_inspection TEXT NOT NULL,
                    source TEXT NOT NULL,
                    status TEXT DEFAULT 'ACTIVE',
                    resolved_at REAL DEFAULT NULL
                )
            """)
            
            # Automatic Schema Migration Check for alerts table
            cursor.execute("PRAGMA table_info(alerts)")
            existing_alert_cols = {row["name"] for row in cursor.fetchall()}
            if "status" not in existing_alert_cols:
                cursor.execute("ALTER TABLE alerts ADD COLUMN status TEXT DEFAULT 'ACTIVE'")
            if "resolved_at" not in existing_alert_cols:
                cursor.execute("ALTER TABLE alerts ADD COLUMN resolved_at REAL DEFAULT NULL")

            cursor.execute("UPDATE alerts SET status = 'ACTIVE' WHERE status IS NULL OR status = ''")
            cursor.execute("UPDATE alerts SET source = 'live' WHERE source IS NULL OR source = ''")

            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp DESC)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status)
            """)
            conn.commit()

    def save_telemetry(
        self,
        telemetry: TelemetryPayload,
        server_received_at: float,
        health_score: Optional[float] = None,
        status: Optional[str] = None
    ) -> int:
        """Persists a validated telemetry record to SQLite."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            power_val = telemetry.power if telemetry.power is not None else (telemetry.voltage * telemetry.current)
            
            cursor.execute(
                """
                INSERT INTO telemetry (
                    timestamp, server_received_at, source, device_id,
                    temperature, vibration_x, vibration_y, vibration_z, vibration_rms,
                    rpm, voltage, current, power, health_score, status,
                    motor_running, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    telemetry.timestamp,
                    server_received_at,
                    telemetry.source,
                    telemetry.device_id,
                    telemetry.temperature,
                    telemetry.vibration_x,
                    telemetry.vibration_y,
                    telemetry.vibration_z,
                    telemetry.vibration_rms,
                    telemetry.rpm,
                    telemetry.voltage,
                    telemetry.current,
                    power_val,
                    health_score,
                    status,
                    1 if telemetry.motor_running else 0,
                    json.dumps(telemetry.model_dump())
                )
            )
            conn.commit()
            return cursor.lastrowid

    def get_latest_telemetry(self, source: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Retrieves the most recent telemetry sample, optionally filtered by source ('live' / 'demo')."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            if source:
                cursor.execute(
                    "SELECT * FROM telemetry WHERE source = ? ORDER BY timestamp DESC LIMIT 1",
                    (source,)
                )
            else:
                cursor.execute(
                    "SELECT * FROM telemetry ORDER BY timestamp DESC LIMIT 1"
                )
            row = cursor.fetchone()
            if row:
                data = dict(row)
                data["payload"] = json.loads(data["payload_json"])
                data["motor_running"] = bool(data["motor_running"])
                return data
            return None

    def get_history(
        self,
        minutes: float = 5.0,
        source: Optional[str] = None,
        limit: int = 5000
    ) -> List[Dict[str, Any]]:
        """
        Retrieves chronological time-series telemetry within the specified lookback window.
        Uses indexed timestamp filtering for high query efficiency.
        """
        now = time.time()
        cutoff_timestamp = now - (minutes * 60.0)

        with self._get_connection() as conn:
            cursor = conn.cursor()
            if source:
                cursor.execute(
                    """
                    SELECT id, timestamp, server_received_at, source, device_id,
                           temperature, vibration_x, vibration_y, vibration_z, vibration_rms,
                           rpm, voltage, current, power, motor_running, health_score, status
                    FROM telemetry
                    WHERE timestamp >= ? AND source = ?
                    ORDER BY timestamp ASC
                    LIMIT ?
                    """,
                    (cutoff_timestamp, source, limit)
                )
            else:
                cursor.execute(
                    """
                    SELECT id, timestamp, server_received_at, source, device_id,
                           temperature, vibration_x, vibration_y, vibration_z, vibration_rms,
                           rpm, voltage, current, power, motor_running, health_score, status
                    FROM telemetry
                    WHERE timestamp >= ?
                    ORDER BY timestamp ASC
                    LIMIT ?
                    """,
                    (cutoff_timestamp, limit)
                )
            
            rows = cursor.fetchall()
            results = []
            for r in rows:
                item = dict(r)
                item["motor_running"] = bool(item["motor_running"])
                results.append(item)
            return results

    def cleanup_old_telemetry(self, retention_seconds: float = 86400.0) -> int:
        """Removes telemetry older than the configured retention threshold. Baseline & alerts are preserved."""
        cutoff = time.time() - retention_seconds
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM telemetry WHERE timestamp < ?", (cutoff,))
            conn.commit()
            return cursor.rowcount

    def save_baseline(self, baseline: BaselineState) -> int:
        """Saves baseline calibration parameters."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO baseline (
                    saved_at, temperature, vibration_rms, voltage,
                    current, power, rpm, samples, duration_seconds
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    baseline.saved_at or 0.0,
                    baseline.temperature or 0.0,
                    baseline.vibration_rms or 0.0,
                    baseline.voltage or 0.0,
                    baseline.current or 0.0,
                    baseline.power or 0.0,
                    baseline.rpm or 0.0,
                    baseline.samples,
                    baseline.duration_seconds
                )
            )
            conn.commit()
            return cursor.lastrowid

    def get_latest_baseline(self) -> Optional[Dict[str, Any]]:
        """Retrieves the latest saved baseline calibration record."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM baseline ORDER BY id DESC LIMIT 1
            """)
            row = cursor.fetchone()
            if row:
                return dict(row)
            return None

    def save_alert(self, alert: AlertRecord) -> int:
        """Saves an alert event directly."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO alerts (
                    timestamp, severity, parameter, title, message,
                    current_value, baseline_value, suggested_inspection, source,
                    status, resolved_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    alert.timestamp,
                    alert.severity,
                    alert.parameter,
                    alert.title,
                    alert.message,
                    alert.current_value,
                    alert.baseline_value,
                    alert.suggested_inspection,
                    alert.source,
                    alert.status or "ACTIVE",
                    alert.resolved_at
                )
            )
            conn.commit()
            return cursor.lastrowid

    def save_alert_with_deduplication(self, alert: AlertRecord) -> int:
        """
        Persists an alert while avoiding high-frequency duplicates.
        If an ACTIVE alert exists for the same parameter and severity on this source,
        it updates the existing record's timestamp and measurement value instead of inserting a new row.
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT id FROM alerts
                WHERE parameter = ? AND severity = ? AND source = ? AND status = 'ACTIVE'
                ORDER BY timestamp DESC LIMIT 1
                """,
                (alert.parameter, alert.severity, alert.source)
            )
            existing = cursor.fetchone()
            if existing:
                alert_id = existing["id"]
                cursor.execute(
                    """
                    UPDATE alerts
                    SET timestamp = ?, current_value = ?, baseline_value = ?, message = ?, suggested_inspection = ?
                    WHERE id = ?
                    """,
                    (
                        alert.timestamp,
                        alert.current_value,
                        alert.baseline_value,
                        alert.message,
                        alert.suggested_inspection,
                        alert_id
                    )
                )
                conn.commit()
                return alert_id
            else:
                return self.save_alert(alert)

    def resolve_cleared_alerts(self, active_parameters: List[str], resolved_at: float, source: str = "live") -> int:
        """
        Marks active alerts as RESOLVED when their corresponding physical anomaly condition clears.
        """
        with self._get_connection() as conn:
            cursor = conn.cursor()
            if active_parameters:
                placeholders = ",".join("?" for _ in active_parameters)
                query = f"""
                    UPDATE alerts
                    SET status = 'RESOLVED', resolved_at = ?
                    WHERE (source = ? OR source IS NULL) AND status = 'ACTIVE' AND parameter NOT IN ({placeholders})
                """
                cursor.execute(query, [resolved_at, source] + active_parameters)
            else:
                cursor.execute(
                    """
                    UPDATE alerts
                    SET status = 'RESOLVED', resolved_at = ?
                    WHERE (source = ? OR source IS NULL) AND status = 'ACTIVE'
                    """,
                    (resolved_at, source)
                )
            conn.commit()
            return cursor.rowcount

    def get_alerts(self, limit: int = 100, active_only: bool = False, source: Optional[str] = None) -> List[Dict[str, Any]]:
        """Retrieves most recent alerts, optionally filtering for active only and source."""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            conditions = []
            params: List[Any] = []
            if active_only:
                conditions.append("status = 'ACTIVE'")
            if source:
                conditions.append("source = ?")
                params.append(source)
            
            where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""
            query = f"SELECT * FROM alerts {where_clause} ORDER BY timestamp DESC LIMIT ?"
            params.append(limit)
            cursor.execute(query, params)
            return [dict(r) for r in cursor.fetchall()]
