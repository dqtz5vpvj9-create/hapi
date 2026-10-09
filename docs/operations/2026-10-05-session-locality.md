# Recent-session locality — 2026-10-05

Explicitly switching between sessions opens the latest content. The user
clarified that returning to the old reading position is not the goal of this
interaction. The earlier A→B→A bookmark-restoration criterion is withdrawn.
Page reloads and returning from the same session's files or terminal retain
their existing bookmark behavior.

Released to the production Web UI on 2026-10-05. Production Hub, Runner, CLI
and native engines were not restarted; no conversation content was changed
by the acceptance checks.

## Findings

The message window and history-page repository already retained data across
session navigation. The mounted `SessionChatInner`, however, owned the
normalization/reconciliation caches, native content projection, disclosure
state and measured virtual-row sizes. Its session key isolated views but also
discarded this prepared state on every switch. On the baseline, opening a
Process group in A, visiting B, then returning to A closed the group on both
narrow and desktop Chromium. Drafts were already preserved.

The app's global SSE connection already receives other sessions' change
notifications. Its `onEvent` callback discarded them, while the selected
session's separate subscription updated only that session's message window.
Retaining a cached window therefore did not keep its content fresh. Cached
content could already render with requests held; the gap was background
freshness and prepared-state reuse, not an unconditional network wait.

## Implementation

- [RecentSessionWarmup](../../web/src/lib/recent-session-warmup.ts) keeps a
  five-session working set, including the selected session. It uses the
  existing global SSE connection, coalesces notifications and reads one
  inactive session's bounded latest page at a time. Full incoming messages
  can enter inactive tail windows directly; a bounded read reconciles their
  cursors. No idle polling or per-session SSE connection is added.
- [useRecentSessionWarmup](../../web/src/hooks/useRecentSessionWarmup.ts)
  connects that scheduler to navigation and network availability. Explicit
  cross-session navigation selects the cached tail before the new view mounts.
  The ordinary foreground synchronization still validates it afterward.
  Navigating within the same session and reloading the page keep their
  existing behavior.
- [message-window-store](../../web/src/lib/message-window-store.ts) provides
  `openMessageTailFromCache` and `warmMessageTail`. Background reads retain
  a fresh latest page in the existing repository. They do not replace an
  inactive historical reading window; explicit session selection adopts the
  fresh tail and clears its old bookmark. A departing foreground sync finishes
  before a background read takes its baseline. A read that becomes selected,
  is evicted or loses its authorization lifetime is cancelled.
- [SessionPresentation](../../web/src/chat/sessionPresentation.ts) retains
  normalization/reconciliation and native projection state for five recently
  visited native sessions. An inactive tail can prepare its updated content
  before selection. Background preparation does not change the LRU order.
  History-epoch changes invalidate disclosure and measured geometry.
- [WindowedMessageList](../../web/src/components/AssistantChat/VirtualMessageList.tsx)
  retains measured virtual-row sizes when width matches. It does not replay
  `scrollTop`; the existing scroll coordinator opens the latest content.
  [NativeCodexThread](../../web/src/components/AssistantChat/NativeCodexThread.tsx)
  still saves bookmarks before navigation for reload and same-session views,
  preventing teardown geometry from overwriting a valid bookmark.

The scheduler yields when the selected session is loading its tail or older
history. Background reads are serial and start at most once per second,
or once per five seconds on a reported 3G connection. Hidden pages, offline
connections, 2G and data-saving mode pause prefetch. Where the browser does not
report connection quality, serial requests and response backpressure still
bound the work. Background failures retain readable content; a subsequent
change notification or reconnection can retry.

These are HAPI lifecycle and virtualization adaptations, not new DSH
presentation rules. They keep no hidden mounted chat trees, add no transcript
database or persistence format, and never invoke a model. The five-session
limit is a count bound, not a measured heap-byte budget. Evicted sessions also
open the latest content, but use the ordinary latest-page refresh path.

## Acceptance

Tests use private captures of two long Linux native Codex conversations
(1,023 and 1,035 records) and one Windows native conversation (17 records).
The loopback replay server rejects writes and injects 700 ms history-response
latency. The background-update journey appends one synthetic user message to
a captured response and dispatches its invalidation through the browser's
actual global EventSource listener. It does not send anything to a real agent.

| Check | Result |
| --- | --- |
| Store, presentation, SSE and SessionChat regression | 162 tests passed |
| Final scheduler tests, including evicted-session entry | 4 passed |
| Web typecheck and isolated Vite build | Passed |
| Final combined Tester Army regression | 16 passed: opening all three captures, draft/resize/reload, tool details, bookmark reload, held-update re-entry and both switching journeys on both sizes |
| Background update while B is selected; then hold A's requests and select A | Passed at 390×844 and 1440×900: 90 returning-route frames per size, zero blank frames, zero frames missing the new message, maximum distance from the tail 0 CSS pixels |
| Disclosure and draft retention | Three alternating cycles passed on both sizes; includes direct desktop sidebar selection |

The final combined browser regression passed against the final candidate in
133 seconds. Results are recorded in `warm-final.log` and
`.e2e/warm-final/summary.md`.

The reusable [session-switching journeys](../../scripts/testing/tester-army/tests/session-switching.e2e.ts)
and [runner instructions](../../scripts/testing/tester-army/README.md) are in
the source tree. Private logs/reports remain on the cache disk under
`/mnt/cache/data-cache/hapi-e2e-20261005-review/`:

- `warm-switch.log`, `.e2e/warm-switch/summary.md`: initial four successful
  switching journeys and their per-frame measurements.
- `warm-regression.log`, `warm-final-unit.log`: source regression and final
  scheduler checks, including request ownership, burst coalescing,
  data-saving/2G suspension, eviction and no idle polling.
- `warm-typecheck.log`, `warm-build.log`: candidate checks.
- `switch-baseline.log`, `switch-desktop-baseline.log`: original failures.
- `switch-pagination.json`, `switch-pagination.log`: preceding twenty-page
  prepend check, maximum displacement 0.5 CSS pixels. This is earlier evidence,
  not a new measurement of the current candidate.

The replay port was verified closed after the final run. The owned temporary
18 MiB candidate build was removed; private captures and reports remain on
the cache disk for review.

## Remaining boundaries

The mobile target is a Chromium viewport, not a physical Pixel or iPhone.
The Windows capture verifies web rendering of its content, not a live Windows
backend reconnect. The new background-update test exercises the real browser
subscription with a synthetic notification; it does not establish live
backend SSE delivery or disconnect recovery. There is no comparative device
CPU, heap or battery measurement yet.

Modal state, focused elements and whole mounted React trees are not retained.
The first visit, page reload and LRU eviction still have cold work. Recently
visited sessions can display the latest cached content immediately and remain
fresh while the user works elsewhere in the visible app.

## Production release

The HTTPS entry is now `assets/index-CI7_dkxO.js`. The rebuilt release contains
the same content-addressed chunks as the final tested candidate. It lives at
`/mnt/cache/build-cache/hapi-session-locality-20261005/web`; assets were copied
first and entry files replaced atomically in `/mnt/cache/src/hapi/web/dist`.
Old content-addressed assets remain available to already-open clients.

Authenticated HTTPS browser checks at 390 and 1440 CSS-pixel widths opened and
reloaded two real Linux conversations and one Windows conversation. Each
loaded the new entry. Four subsequent in-app selections per size all entered
at the latest content, with a measured tail distance of 0 CSS pixels. The 39
observed history responses had no HTTP errors; neither browser reported a
page-script error. Live checks allowed authentication and the app's normal
visibility report, but rejected conversation mutations. Service workers were
blocked in these fresh browser contexts, so this verifies fresh loading, not
an existing installed PWA's update lifecycle.

The public HTTPS entry, its seven linked entry assets and `sw.js` were checked
against the release. Both registered machines remained online. Hub and native
bridge process IDs matched the pre-release snapshot; the standalone Linux
Runner unit was already inactive and remained unchanged. The app's existing
PWA update banner lets an already-open client choose **Reload** to activate
the new worker; publication does not force reload an active conversation.

Rollback entry files are in
`/mnt/cache/build-cache/hapi-session-locality-20261005/previous-entry`.
Restore these root files to `web/dist` with atomic file replacements, keeping
the old assets that are already present; no backend restart or history change
is needed. Release evidence is in `publish-build.log`, `publish-preflight.log`,
`publish-live.json`, and `publish-services-before.txt` /
`publish-services-after.txt` under the private cache-disk evidence directory.
