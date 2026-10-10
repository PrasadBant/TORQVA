# Browser E2E (opt-in)

`torqva.e2e.mjs` drives real Chrome through: sign-in, scenario start with human approval, approve, device ack,
recovery, keyboard navigation, responsive widths (1024/768/390, no horizontal overflow), and a simulated network failure.

    npm i --no-save playwright-core
    # backend running with TORQVA_TOKENS containing the sha256 of your token; frontend: npm run dev
    TORQVA_TOKEN=<token> node e2e/torqva.e2e.mjs

Not wired into `npm test`: Playwright is not a project dependency (adding it needs sign-off).
