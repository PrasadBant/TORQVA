# Communication Protocols & Networking Overview

This directory contains complete documentation for all network communication and protocol contracts between the **ESP32-S3 hardware node**, **FastAPI server**, and **React frontend dashboard**.

---

## Documents

1. [TCP_PROTOCOL.md](file:///d:/MAIN%20FOLDERS/Downloads/smart-motor-monitor/communication/TCP_PROTOCOL.md): Details raw TCP socket connection, telemetry payload structure, and motor control ACK protocol.
2. [PROTOCOL_DOCS.md](file:///d:/MAIN%20FOLDERS/Downloads/smart-motor-monitor/communication/PROTOCOL_DOCS.md): Detailed multi-tier protocol architecture, command workflows, and live RPM graph streaming pipeline.

---

## Architectural Stages & Readiness

| Stage | Feature | Status | Protocol |
|---|---|---|---|
| **Stage 1** | TCP Telemetry Ingestion | **IMPLEMENTED** | Raw TCP Socket (JSON / Port 5001) |
| **Stage 2** | Dashboard Motor ON/OFF Control | **IMPLEMENTED** | HTTP REST & TCP ASCII ACK Commands |
| **Stage 3** | Live RPM Time-Series Graph | **IMPLEMENTED** | WebSockets (`ws://localhost:8000/ws`) & Recharts |
