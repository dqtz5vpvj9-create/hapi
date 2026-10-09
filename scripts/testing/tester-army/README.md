# Tester Army acceptance for captured HAPI chats

This optional runner uses [Tester Army e2e](https://github.com/tester-army/e2e)
with its web engine. It is independent of the workspace's existing Playwright
suite. The package lock pins `e2e` 0.17.0 and `@e2e-dev/web` 0.12.0; use the
installed skill documentation when CLI flags differ from upstream main.

The replay server serves the selected real frontend build and private captured
API responses. It rejects session and message mutations. These tests do not
send drafts, invoke models, restart production, or import chat history.

## Run on the cache disk

First [capture a bounded history slice](../README.md) with `--dependencies`.
Include a long native Codex session whose initial page contains a Process group
with a completed CodexBash command. The current tool test expects a shell result
with an exit code. Use a unique session title for the list re-entry journey.
The capture must extend beyond seven upward traversals for the bookmark test.
The session-switching journeys need two such long sessions, both with a Process
group in the initial window. They keep drafts locally and never send them.

Copy just this runner to a new cache directory. Keep captures, traces, screenshots
and dependencies out of the source tree: reports can contain conversation text.

```sh
mkdir -p /mnt/cache/data-cache/hapi-tester-army/tests
cp /mnt/cache/src/hapi/scripts/testing/tester-army/package.json /mnt/cache/data-cache/hapi-tester-army/
cp /mnt/cache/src/hapi/scripts/testing/tester-army/package-lock.json /mnt/cache/data-cache/hapi-tester-army/
cp /mnt/cache/src/hapi/scripts/testing/tester-army/e2e.config.ts /mnt/cache/data-cache/hapi-tester-army/
cp /mnt/cache/src/hapi/scripts/testing/tester-army/tests/chat-reading.e2e.ts /mnt/cache/data-cache/hapi-tester-army/tests/
cp /mnt/cache/src/hapi/scripts/testing/tester-army/tests/session-switching.e2e.ts /mnt/cache/data-cache/hapi-tester-army/tests/
cd /mnt/cache/data-cache/hapi-tester-army
export TMPDIR=/mnt/cache/data-cache
export E2E_TELEMETRY_DISABLED=1
export npm_config_cache=/mnt/cache/data-cache/npm-e2e-cache
npm ci
export HAPI_REPO=/mnt/cache/src/hapi
export HAPI_REPLAY_DATA=/mnt/cache/data-cache/hapi-history-replay
export HAPI_REPLAY_PRIMARY_SESSION=YOUR_CAPTURED_SESSION_UUID
npx e2e run
```

Requires Node 22.12 or later and Python 3. Reuse the matching cached Playwright
Chromium; install it into the cache disk if absent. `HAPI_WEB_ROOT` can point to
a candidate build outside the repository; its default is `$HAPI_REPO/web/dist`.
Port 5313 must be free. The runner owns and stops the loopback replay server.

Results are in `.e2e/report.json` and `.e2e/summary.md`, with failure artifacts.
No test retries are enabled. Target names `mobile-chrome` and `desktop-chrome`
refer to Chromium viewport sizes, **not physical devices**.

## Coverage and observation

For each captured session, the suite opens history, retains a local draft across
viewport resizing, and reloads history. Three additional journeys run on the
primary session:

- Expand a compact tool row, open its detail, and check the actual input, result,
  exit code, successful dependency response and absence of an error alert.
- Traverse earlier history, settle the reader, reload, and require the same
  visible node within 1 CSS pixel of its saved position.
- Re-enter a cached session with the latest-page request held; require existing
  content to remain mounted across 90 animation frames, then release the request.

`session-switching.e2e.ts` also alternates between two chats three times. Each
chat must retain its own expanded Process group and unsent draft, using the
visible desktop sidebar or returning to the list on narrow screens. A second
journey reads deep into A, switches to B, then injects a new replay message and
a global SSE invalidation for A. It verifies a background fetch while B remains
selected, then holds A's subsequent requests and switches back. Starting with
the first returning-route frame, it requires 90 frames with the new message
present, no blank body and a distance from the tail of at most 1 CSS pixel.
The injected event and message are local test data; no production conversation
is changed. Reload bookmark recovery remains covered separately in
`chat-reading.e2e.ts`.

For interactive exploration using the project's MCP workflow:

```sh
npx e2e mcp --headless --max-sessions 1
```

Connect an MCP client to that stdio command, then use `open_session`, `observe`,
`locate`, `tap`, `scroll`, and `close_session`. Convert observed failures into
durable assertions and inspect the CLI failure reports. In this version,
`--headless` is necessary on a host without a display. No global MCP settings
or agent skill installation is required for an individual run.

This setup has no model configuration and does not call `agent.act`. MCP
exploration is performed by the connected agent; the saved suite is deterministic.
It does not claim autonomous model-driven exploration of every user journey.

Use the sibling `history-replay-browser.mjs` and `history-replay-motion.mjs`
for held-page intermediate frames, wheel/touch direction, request locality and
frame timing. This suite does not replace those checks. It also does not cover
real backend SSE output, actual network reconnection, physical phone gestures, sending,
approval actions, or every image/file preview. A passing report is scoped to
the captured slice and these actions.
