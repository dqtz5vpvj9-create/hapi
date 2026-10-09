# Private real-history replay

Use actual history pages to test chat geometry, grouping, image loading and
reverse traversal. Uniform synthetic messages do not exercise native pages
containing almost entirely tools, partially loaded turns, or sparse cursors.

Capture files contain private conversation data. Keep them on the cache disk,
outside Git and public static roots. The replay server binds only loopback,
never forwards requests, and rejects message/session mutations. No model run,
history import, or second production database is involved.

## Capture and serve

Supply the Hub token through the existing environment or a private env file;
never put it in a URL or commit it. The capture prints only IDs and counts.

```sh
node --env-file=/path/to/private/hapi.env scripts/testing/capture-history-replay.mjs \
  --url http://127.0.0.1:3006 \
  --output /mnt/cache/data-cache/hapi-history-replay \
  --rows 2000 --pages 60 SESSION_UUID ANOTHER_SESSION_UUID
```

Each session contains an initial 20-record page followed by the **actual**
returned pages, preserving native IDs, phase/lifecycle fields, sparse cursors,
and tool payloads. The limits bound capture work; the last page can exceed the
requested row count. The script also saves readable referenced artifacts and
auxiliary UI responses. Unavailable artifacts and retried metadata 503s are
recorded separately. Do not replace those failures with invented content.

Add `--dependencies` when testing tool detail. It captures exact dependency
requests for initial-page message IDs in the same history epoch. If that epoch
changes during capture, start a new capture; do not patch a newer response into
an older snapshot or rewrite its version to force it to pass.

Build a candidate into the cache disk with Vite's `--outDir`, or select the
existing deployed `web/dist` as the baseline. Do not overwrite `web/dist` for
an experiment.

```sh
python3 scripts/testing/history-replay-server.py \
  --data /mnt/cache/data-cache/hapi-history-replay \
  --web-root /path/to/compiled/web \
  --port 5310 --latency-ms 80
```

Open `http://127.0.0.1:5310/sessions/SESSION_UUID`. Local fake authentication,
Codex theme, and acknowledged mention onboarding are supplied by the replay
server. It supports paging in both directions and context restoration inside
the captured slice. It caps history at the capture boundary and freezes the
advertised tail at capture start; it does not emulate future SSE output.
Uncaptured endpoints return 404. With `--dependencies`, initial-page tool detail
requests are replayed exactly; outline and uncaptured dependency requests still
return 404. This is not acceptance of sending or the live backend.

An optional [Tester Army runner](tester-army/README.md) adds browser journeys
for opening chats, tool results, draft retention, bookmark reload and cached
re-entry while an update is held. Install its dependencies on the cache disk.

## Check every intermediate prepend frame

```sh
node scripts/testing/history-replay-browser.mjs \
  --url http://127.0.0.1:5310 --session SESSION_UUID --pages 30 \
  --output /mnt/cache/data-cache/hapi-history-replay/anchor-result.json \
  --browser /path/to/playwright/chromium
```

The test holds each older-page response, stops the reader, and then releases
it while recording the visible anchor through rendering and measurement.
Missing anchors or any drift above 1 CSS pixel fail. `--width 1440` tests the
same path at desktop width. A zero-page run is not pagination acceptance.
Use separate ports for baseline and candidate with the **same** capture.

Also exercise real wheel/touch inertia, direction reversal across the bounded
window, group expansion, tool detail, bookmark reload, and image preview.
The motion runner records native input direction and every animation frame:

```sh
node scripts/testing/history-replay-motion.mjs \
  --url http://127.0.0.1:5310 --session SESSION_UUID --gesture touch \
  --output /mnt/cache/data-cache/hapi-history-replay/touch-result.json \
  --browser /path/to/playwright/chromium
```

Repeat with `--gesture wheel`. It flags common visible nodes moving more than
8 px against recent input, saves the complete trace for attribution, and reports
frame intervals and mounted nodes. This direction heuristic complements the
1 px stationary test; it is not a general smoothness score. Physical Chrome
gestures remain a separate device test. Start each run in a fresh tab; clearing
sessionStorage immediately before reload is insufficient because pagehide saves
the current bookmark again.

Stationary anchor stability is not a substitute for gesture attribution or
performance measurement. Record frame intervals and request directions; a
latest-tail refresh after returning to the end is different from re-fetching
already visited historical pages. Browser simulation and physical-device
results must remain separately labeled. Use the webshot skill for screenshots
and inspect the resulting image.

Stop replay servers and remove temporary browser/device forwards after use.
The private cache directory expires automatically; remove experimental build
copies proactively when they are no longer needed.

## Workspace working-set measurements

Serve a compiled `workspace-fixture.html` build on loopback, then run:

```sh
node scripts/testing/workspace-working-set.mjs \
  --url http://127.0.0.1:5192 \
  --output /mnt/cache/data-cache/hapi-workspace-working-set \
  --browser /path/to/playwright/chromium --runs 3 --cycles 5
```

The first cycle visits twelve workspaces by default and saves a distinct draft and deep
code position in each. Subsequent cycles reopen every reader and measure the
DOM click to restoration of the same source character within 2 CSS pixels.
Every cycle collects garbage outside the timed interval and records retained
JS heap, DOM counts and fixture response bytes. Failing runs remain in the
output. The fixed mock server itself holds all histories in the browser;
heap figures include that cost and are not browser RSS.

Use `--sessions 48 --cycles 2` to measure opening more distinct conversations.
The fixture accepts `?workingSet=48` and creates those workspaces before the first
sample. During the first cycle the script collects a sample after every twelve
visits, including the retained message-window count and serialized UTF-16 size.
That serialized size describes cache contents, not their actual heap allocation.
The second cycle checks every draft and original source character after eviction.

When supplying a Vite config or output directory, invoke Vite directly from
`web`, for example `bun ./node_modules/vite/bin/vite.js build --config /path/to/fixture.config.mjs --outDir /mnt/cache/build-cache/hapi-fixture`.
Do not append those flags to `bun run build`: its compound script passes trailing
arguments to `cp`, and Vite would build into the served `web/dist` directory.

Use `--heap-snapshots --runs 1` for a separate diagnosis run; snapshots are taken
after the initial visit cycle, the first revisit cycle and the final cycle. Do not mix those timings
with performance samples, or run builds/tests alongside timed measurements.
