# Browser E2E (opt-in)

`torqva.e2e.mjs` drives real Chrome through: sign-in, scenario start with human approval, approve, device ack,
recovery, keyboard navigation, responsive widths (1024/768/390, no horizontal overflow), and a simulated network failure.

    npm i --no-save playwright-core
    # backend running with TORQVA_TOKENS containing the sha256 of your token; frontend: npm run dev
    TORQVA_TOKEN=<token> node e2e/torqva.e2e.mjs

Not wired into `npm test`: Playwright is not a project dependency (adding it needs sign-off).

`torqva-attestation.e2e.mjs` (Phase 9) drives the Attestation tab: candidate capture, eligibility failures, confirmation gating, attest / activate / roll back, rejection, stale-decision handling, 1024/768/390 px layouts and the read-only viewer. It needs an operator and a viewer token:

    TORQVA_TOKEN=<operator token> TORQVA_VIEWER_TOKEN=<viewer token> node e2e/torqva-attestation.e2e.mjs

Start the frontend with `npm run dev -- --host 127.0.0.1` (the scripts use 127.0.0.1). Use a freshly started backend for a clean candidate/version history.

`torqva-c2c4.e2e.mjs` (Phase 10) drives the Decisions and Evaluation views (prediction status, predicted-vs-observed record, diagnostic-test card, C2/C4 validation card, responsive widths). Start the backend with `TORQVA_C2_VARIANT=noise_aware` to exercise the opt-in predictor:

    TORQVA_TOKEN=<operator token> node e2e/torqva-c2c4.e2e.mjs

`torqva-twin.e2e.mjs` drives the Digital Twin: physical mode with no board (everything UNAVAILABLE, nothing animated, no writes), then a simulation started from the Live Monitor: the shaft animates only while simulation time advances, selection by click and keyboard, the trend chart, the light theme and 1024/768/390 px layouts. For the 3D viewport (WebGL 2) it checks that the canvas really draws, renders only on demand, orbit, Ctrl + scroll zoom (plain scrolling still scrolls the page), the view presets and orthographic projection, picking a part in the scene, isolate, explode, section, recovery from a lost graphics context, the switch to the 2D drawing, no WebGL context or GPU geometry leak over six remounts, and no Three.js warnings (44 checks). Run it against `npm run dev:sim`, then `node e2e/torqva-twin.e2e.mjs`. `playwright-core` is not a project dependency: install it with `npm install --no-save playwright-core` (a later plain `npm install` removes it again).

The app opens in physical mode, so `torqva-lab`, `torqva-c2c4` and `torqva-attestation` set the remembered mode to simulation before loading the page.

`torqva-app.e2e.mjs` (frontend redesign) drives the root route `/` with the dev server's automatic sign-in: every page, SIM provenance labels, simulator controls, the backend-unreachable stale warning and recovery, and 1440/1024/768/390 px layouts. Start everything with `npm run dev` (it launches the backend with a local-only token and the app with the matching dev token), then `node e2e/torqva-app.e2e.mjs`. The older E2E scripts sign in with a typed token, so run them against `npm run dev:ui` plus your own backend started with `TORQVA_TOKENS` (the automatic dev sign-in is off there because `VITE_TORQVA_DEV_TOKEN` is unset).

`torqva-workbench.e2e.mjs` drives the analyst workflow in simulation mode against `npm run dev:sim`: a scenario that holds its action for approval, C1 conditions and hypotheses, a two-step RPM profile validated and run on a simulator copy (live time unchanged), a custom C2 target that is re-predicted before it can be selected, the C3 gate and Supervisor check and a confirmed request that reaches the simulated device with that exact target, the lifecycle, 1024/768/390 px layouts, and the same pages locked in physical mode with no simulator calls (35 checks): `node e2e/torqva-workbench.e2e.mjs`.
