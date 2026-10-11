# HAPI regression tests with tester-army/e2e

A standalone [tester-army/e2e](https://github.com/tester-army/e2e) suite:
8 scenarios on desktop (1440×900) and narrow-screen (390×844) Chromium,
16 checks in total. No model, account, API key, or Codex CLI is needed.

## Run

1. Install HAPI's dependencies at the repository root with `bun install --frozen-lockfile`.
2. Use Node.js 24.8+ (or Node.js 22.22.3+) and install this suite's pinned dependencies:
   `npm --prefix tests/tester-army ci --ignore-scripts`.
3. Run `E2E_TELEMETRY_DISABLED=1 bun run test:e2e:tester-army` at the root.

The suite starts Vite on `127.0.0.1:5187`, then stops it when done.
The port must be free. e2e automatically downloads its pinned Chromium if
necessary. `HAPI_REPO_DIR` optionally selects another HAPI checkout.

For an isolated Linux container with an existing Chromium, set
`CHROMIUM_EXECUTABLE=/usr/bin/chromium`. The optional system-browser provider
uses dedicated temporary profiles and `--no-sandbox`; use this only with
trusted local test pages inside an isolated environment. Leave this variable
unset for the normal e2e-managed browser. The system-browser option was used
for the verified cloud run.

Results are written under `tests/tester-army/.e2e/`: `report.json`,
`summary.md`, screenshots, and traces. They are ignored by Git.
Dependencies stay in this standalone package; the existing Playwright suite
and default CI remain unchanged. This suite is currently opt-in.

## Coverage

- tmux loading, ordinary session links, settings round trips, refresh,
  retained drafts/layout, new-session cancellation, Back/Forward,
  explicit ordinary-mode selection, and legacy workspace links
- Fork cancellation, and navigation retry without creating a second child
- Steering reconciliation without SSE, and preserving messages on errors
- Accepted scratchlist sends followed by failed cleanup: retry cleanup only
- Scratchlist persistence, session isolation, and non-destructive copy
- One-line command summaries, hidden output, and explicit detail dialogs

## What a passing run means

Tests mount production UI components and, for tmux, the real router.
Fixture backends provide controlled data and injected faults. They do not
prove real Hub/Runner/model execution, real server-side durability, or
cross-device behavior. The phone target is a narrow desktop Chromium
viewport, not touch emulation or a native phone test.

These are deterministic interactions and assertions using e2e's runner and
web engine, not natural-language `agent.act` or `agent.assert` exploration.
No model provider is configured. Telemetry is disabled in the command above.

Baseline verified on HAPI `1beac5153350ca8fc3c70cc718e49fc57ecb8380`:
16 passed, no retries, e2e 0.18.0 / web engine 0.13.0. Reports and traces
are delivered separately rather than checked into the source repository.
