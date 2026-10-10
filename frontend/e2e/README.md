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
