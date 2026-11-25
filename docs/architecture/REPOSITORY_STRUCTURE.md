# Repository structure

```text
TORQVA/
  frontend/                     React/Vite site
    src/app/                    App shell, navigation and global styles
    src/access/                 Sign-in and token handling
    src/control/                Direct Manual Control dashboard
    src/device/                 Device connection and firmware UI
    src/telemetry/              Live stream, sensor readings and ACK presentation
    src/safety/                 Limits, warnings and alarms
    src/pages/                  Physical, simulation and workflow views
    src/components/, shared/    Reusable JSX, charts, 3D and API client
    src/tests/, e2e/            Vitest and browser suites
  backend/                      FastAPI service
    torqva/api/                 HTTP and WebSocket routes
    torqva/control/             Direct command lifecycle and parameter checks
    torqva/device/              Bridge, wire protocol, USB, Wi-Fi and firmware tools
    torqva/telemetry/           Device state, history, fan-out and recording
    torqva/safety/              Readiness reporting and operating configuration
    torqva/access/              Tokens, roles and device keys
    torqva/models/, shared/     Common models and persistence
    torqva/legacy/              Proposal/workflow and older transport contracts
    torqva/analysis/             Diagnostics and recommendation engines
    torqva/research/, simulation/ Evaluation studies and simulator
    data/, tests/               Runtime state and pytest suites
  firmware/                     PlatformIO project
    src/                        ESP32 entry point and board drivers/communication
    lib/torqva_core/            Shared control, protocol, safety and driver logic
    test/, tools/               Native suites and firmware-in-the-loop CLI
  config/                       Seed data and configuration ownership
  scripts/                      Provisioning, builds, development and test tools
  docker/                       Container toolchain for firmware compilation
  tests/                        System and hardware acceptance runbooks
  docs/                         Architecture, hardware, testing, reports and history
```

The firmware core remains a PlatformIO library shared by physical profiles, native tests and firmware-in-the-loop. Keeping the reusable firmware logic in that library gives each build the same control and safety implementation. The ESP32 board entry point controls peripheral initialization and actual pin I/O.

`backend/main.py` composes the FastAPI app, while `backend/torqva/service.py` wires the simulation and physical services. Browser unit tests, Playwright scripts, pytest integration tests and firmware tests use their subsystem's existing discovery and dependency setup. Test acceptance entry points are indexed under [tests](../../tests/README.md).

Evaluation artifacts in `docs/eval/` remain at their runtime path. The default operating config lives in `config/defaults/device_config.json`; the applied local runtime file lives under `backend/data/` or at the path selected by the environment. Site credentials and generated binaries are runtime artifacts.
