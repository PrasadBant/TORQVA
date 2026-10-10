"""
Asyncio TCP Server for ESP32-S3 Telemetry Ingestion & Bidirectional Motor Control.
Listens on TCP 0.0.0.0:5001, reads newline-delimited JSON telemetry from ESP32,
validates payloads, persists to SQLite, and sends motor control commands over the active TCP stream.
"""

import asyncio
import json
import time
import logging
from typing import Optional, Dict, Any, Callable

logger = logging.getLogger("tcp_server")
logging.basicConfig(level=logging.INFO)


class ESP32TCPServer:
    def __init__(self, host: str = "0.0.0.0", port: int = 5001):
        self.host = host
        self.port = port
        self.server: Optional[asyncio.Server] = None
        self.is_running = False
        self.active_connections = 0
        self.active_writer: Optional[asyncio.StreamWriter] = None
        self.pending_acks: Dict[str, asyncio.Future] = {}

    def parse_and_normalize_raw_json(self, raw_str: str) -> Optional[Dict[str, Any]]:
        """
        Parses raw string and normalizes ESP32 TCP JSON packet fields.
        Handles both ESP32 TCP schema ("vibration", "status", "motor", "reason", "condition")
        and internal schema ("vibration_rms", "hardware_condition", "motor_running").
        """
        cleaned = raw_str.strip()
        if not cleaned:
            return None

        # Basic JSON structure check
        if not (cleaned.startswith("{") and cleaned.endswith("}")):
            return None

        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError:
            return None

        if not isinstance(data, dict):
            return None

        # Check key numeric fields
        required_numeric_keys = ["temperature", "voltage", "current"]
        for key in required_numeric_keys:
            if key not in data:
                logger.warning(f"[TCP] Telemetry payload missing expected key '{key}': {data}")
                return None

        # Safe type conversions
        try:
            temp = float(data.get("temperature", 0.0))
            volt = float(data.get("voltage", 0.0))
            curr = float(data.get("current", 0.0))
            rpm = float(data.get("rpm", 0.0))
            
            pwr_raw = data.get("power")
            pwr = float(pwr_raw) if pwr_raw is not None else round(max(0.0, volt * curr), 2)

            vrms_raw = data.get("vibration_rms", data.get("vibration", 0.0))
            vrms = float(vrms_raw)

            # Motor running status parsing
            motor_val = str(data.get("motor", "")).upper()
            if "motor_running" in data:
                motor_running = bool(data["motor_running"])
            elif motor_val:
                motor_running = (motor_val in ["RUNNING", "ON", "1", "TRUE"])
            else:
                motor_running = (rpm > 50.0 or abs(curr) > 0.3)

            # Status / condition parsing
            status_str = str(data.get("status", data.get("hardware_condition", "NORMAL"))).upper()
            reason_str = str(data.get("reason", data.get("hardware_reason", "")))
            condition_val = float(data.get("condition", 100.0 if status_str in ["NORMAL", "MOTOR OFF"] else 70.0))

            normalized = {
                "device_id": str(data.get("device_id", "ESP32-MOTOR-01")),
                "firmware": str(data.get("firmware", "1.0.0")),
                "timestamp": float(data.get("timestamp", time.time())),
                "motor_running": motor_running,
                "temperature": temp,
                "vibration_x": float(data.get("vibration_x", 0.0)),
                "vibration_y": float(data.get("vibration_y", 0.0)),
                "vibration_z": float(data.get("vibration_z", 0.0)),
                "vibration_rms": vrms,
                "rpm": rpm,
                "voltage": volt,
                "current": curr,
                "power": pwr,
                "sensor_health": data.get("sensor_health", {
                    "adxl345": True, "ds18b20": True, "ina219": True, "a3144": True
                }),
                "source": "live",
                "hardware_condition": status_str,
                "hardware_reason": reason_str,
                "hardware_baseline_stored": bool(data.get("hardware_baseline_stored", True)),
                
                # Direct TCP fields for frontend compatibility
                "vibration": vrms,
                "condition": condition_val,
                "status": status_str,
                "motor": "RUNNING" if motor_running else "OFF",
                "reason": reason_str,
            }
            return normalized

        except (ValueError, TypeError) as err:
            logger.warning(f"[TCP] Error parsing numeric telemetry values: {err}")
            return None

    async def send_motor_command(self, command: str, timeout: float = 5.0) -> Dict[str, Any]:
        """
        Sends motor control command (MOTOR_ON / MOTOR_OFF) over the active ESP32 TCP socket stream,
        and awaits string ACK response from ESP32.
        """
        cmd_str = command.strip().upper()
        if cmd_str not in ["MOTOR_ON", "MOTOR_OFF"]:
            return {"success": False, "message": f"Invalid motor command '{command}'. Must be 'MOTOR_ON' or 'MOTOR_OFF'."}

        if self.active_writer is None or self.active_writer.is_closing():
            logger.warning(f"[TCP] Motor command '{cmd_str}' rejected — ESP32 not connected over TCP port 5001")
            return {"success": False, "message": "Motor command failed — ESP32 is not connected over TCP port 5001"}

        expected_ack = f"{cmd_str}_ACK"
        loop = asyncio.get_running_loop()
        ack_future = loop.create_future()
        self.pending_acks[expected_ack] = ack_future

        try:
            # Send command line over existing TCP socket connection
            command_bytes = f"{cmd_str}\n".encode("utf-8")
            self.active_writer.write(command_bytes)
            await self.active_writer.drain()
            logger.info(f"[TCP] Sent command line to ESP32: '{cmd_str}'")

            # Await acknowledgement from ESP32
            received_ack = await asyncio.wait_for(ack_future, timeout=timeout)
            logger.info(f"[TCP] ESP32 confirmed command execution: '{received_ack}'")
            return {
                "success": True,
                "command": cmd_str,
                "ack": received_ack,
                "message": f"Command {cmd_str} sent and acknowledged by ESP32 ({received_ack})"
            }

        except asyncio.TimeoutError:
            logger.warning(f"[TCP] Timeout waiting for '{expected_ack}' from ESP32")
            return {
                "success": False,
                "command": cmd_str,
                "message": f"Command {cmd_str} sent over TCP but acknowledgement '{expected_ack}' timed out"
            }
        except Exception as e:
            logger.error(f"[TCP] Failed to transmit command over socket: {e}")
            return {
                "success": False,
                "command": cmd_str,
                "message": f"TCP transmission error: {e}"
            }
        finally:
            self.pending_acks.pop(expected_ack, None)

    async def handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        on_telemetry_received: Optional[Callable[[Dict[str, Any], str], None]] = None
    ):
        """Handles individual ESP32 TCP client session for telemetry ingestion & command dispatch."""
        peer_name = writer.get_extra_info("peername")
        client_ip = peer_name[0] if peer_name else "unknown"
        self.active_connections += 1
        self.active_writer = writer
        
        logger.info(f"[TCP] ESP32 connected: {client_ip}:{peer_name[1] if peer_name else ''}")
        print(f"\n[TCP] ESP32 connected: {client_ip}")

        try:
            while self.is_running:
                line_bytes = await reader.readline()
                if not line_bytes:
                    logger.info(f"[TCP] ESP32 connection closed by remote peer: {client_ip}")
                    print(f"[TCP] ESP32 connection closed by peer: {client_ip}")
                    break

                try:
                    line_str = line_bytes.decode("utf-8", errors="replace").strip()
                except Exception:
                    continue

                if not line_str:
                    continue

                # Check for string command acknowledgements from ESP32 (e.g. MOTOR_ON_ACK, MOTOR_OFF_ACK)
                if line_str in ["MOTOR_ON_ACK", "MOTOR_OFF_ACK"]:
                    logger.info(f"[TCP] Command ACK received from {client_ip}: '{line_str}'")
                    if line_str in self.pending_acks and not self.pending_acks[line_str].done():
                        self.pending_acks[line_str].set_result(line_str)
                    continue

                payload_dict = self.parse_and_normalize_raw_json(line_str)
                if payload_dict:
                    logger.info(
                        f"[TCP] Received valid JSON from {client_ip} "
                        f"(temp={payload_dict['temperature']}°C, volt={payload_dict['voltage']}V, "
                        f"rpm={payload_dict['rpm']}, status={payload_dict['status']})"
                    )
                    
                    if on_telemetry_received:
                        await on_telemetry_received(payload_dict, client_ip)
                else:
                    logger.warning(f"[TCP] Unparseable line received from {client_ip}: {line_str[:100]}")

        except asyncio.CancelledError:
            pass
        except (ConnectionResetError, BrokenPipeError, OSError) as e:
            logger.warning(f"[TCP] Connection error from {client_ip}: {e}")
            print(f"[TCP] Connection lost from {client_ip}: {e}")
        except Exception as e:
            logger.error(f"[TCP] Unexpected client handler error: {e}", exc_info=True)
        finally:
            self.active_connections = max(0, self.active_connections - 1)
            if self.active_writer == writer:
                self.active_writer = None
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass
            logger.info(f"[TCP] Client session ended for {client_ip}")

    async def start(self, on_telemetry_received: Callable[[Dict[str, Any], str], None]):
        """Starts the asyncio TCP server."""
        self.is_running = True
        
        async def client_cb(reader, writer):
            await self.handle_client(reader, writer, on_telemetry_received)

        self.server = await asyncio.start_server(
            client_cb,
            host=self.host,
            port=self.port,
            reuse_address=True
        )
        logger.info(f"[TCP] ESP32 TCP server started on {self.host}:{self.port}")
        print(f"ESP32 TCP server started on {self.host}:{self.port}")
        print("Waiting for ESP32...")

        async with self.server:
            await self.server.serve_forever()

    async def stop(self):
        """Gracefully stops the TCP server."""
        self.is_running = False
        self.active_writer = None
        if self.server:
            self.server.close()
            await self.server.wait_closed()
            logger.info("[TCP] ESP32 TCP server stopped.")


# Global singleton TCP server instance
tcp_server = ESP32TCPServer(host="0.0.0.0", port=5001)
