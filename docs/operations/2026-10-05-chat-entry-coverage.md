# First-page coverage investigation

The reported Pixel family session uses `HappyThread`, not `NativeCodexThread`:
its metadata has no `codexNativeSession` flag. Capture and replay the actual
session without changing that flag. Native-only acceptance missed this path.

The first response contains 20 raw records and advertises older history. After
filtering and grouping, these records occupy only a small part of the viewport.
`HappyThread` deferred automatic coverage until its 1,800 ms initial scroll
settling deadline. The pending first page was therefore displayed long before
the history page needed to fill the screen. A zero distance from the scroll
floor did not establish that the visible content reached the composer.

The fix lets an undersized, committed first window bypass that deadline.
Coverage uses actual scrollport geometry and the existing `hasMore` flag;
it starts without waiting for timed tail corrections. Normal history paging,
the bounded loader, pre-publication anchor and user-input cancellation retain
their existing coordination. The initial scroll timers themselves are not
replaced by this fix.

The later **HAPI Main** report uses the native DSH presentation and has a
different missing transition. Its latest 20 raw tool records collapse into
`Process (10)`. The adjacent-page preloader warms data, but the native view
only published older data in response to reader motion. A viewport containing
that single process row therefore remained almost empty indefinitely.

Native opening now checks the committed projection against the actual scrollport
geometry. If the latest window is still too short and has older
history, it consumes the existing page loader without starting a reader-owned
history navigation. DSH remains the sole tail-position owner. Pointer, touch,
wheel, keyboard or reader scroll cancels this opening-only demand before an
in-flight page is published. The demand stops after two bounded pages even if
filtering leaves no visible rows; it never crawls the transcript to fill a screen.

The DSH coordinator also ignores content reconciliation before the first
window is ready. A ResizeObserver callback on an empty, still-loading view
must not mark the conversation as initialized and hide its loading skeleton.

Use the scrollport's `scrollHeight`, not the virtual column's bounding height,
for coverage. A diagnostic first commit had 20 rows already measuring 220 px
each while their virtual container still reported only 260 px. The rows overflow
that stale height until virtual measurements publish. Testing the bounding box
alone incorrectly initiated another page for an already full viewport.

Short complete conversations retain normal top alignment. No bottom-alignment
CSS, full-history scan, total-height metadata or new presentation barrier is
introduced. A partially loaded long conversation still requires network I/O;
removing the artificial delay cannot make an uncached page arrive synchronously.

## Evidence

Private artifacts are under
`/mnt/cache/data-cache/hapi-entry-gap-20261005`; they are bounded captures,
not an additional application database. Replay does not invoke the model.

- The actual 620-record capture reproduces a 525 CSS px gap. The first request
  is 20 records; the next request is a bounded 200-record history page.
- With an artificial 700 ms response delay, the baseline interval between the
  first recorded content frame and the filled viewport was about 3.08 seconds;
  the candidate run was about 1.53 seconds. These are individual diagnostic
  runs, not a controlled performance benchmark or a mobile-device measurement.
- Desktop Chromium geometry sampling had a 0.5 ms median, 1.3 ms p95 and
  7.2 ms maximum. This measures the probe's DOM lookup/geometry reads, not
  network latency or total React/browser layout cost.
- `e2e/chat-entry-coverage.spec.ts` checks top alignment of complete short
  conversations in both renderers, immediate loading of a collapsed partial
  page, and the first 12 overflowing frames after page publication. The latter
  stay within 1 CSS px of the scroll floor.
- A single frozen native response supplied 31 records for the HAPI Main replay.
  The offline fixture partitions it into a 20-record tail and 11 earlier
  records, without combining epochs from the actively changing conversation.
  Baseline rendering remained at `Process (10)` with a 562 px gap. The candidate
  consumed the earlier page without a gesture and settled with a 12 px gap.
  At 100 ms injected response latency, this diagnostic run filled in about
  512 ms after the first sampled content. It is not a phone benchmark.
- That native replay's animation-frame probe also captured one intermediate
  layout before ResizeObserver reconciliation (117 px from the new floor).
  This observation is retained rather than claiming every sampled intermediate
  layout was already at the bottom. Layout sampling before browser paint and
  an actual displayed frame are not interchangeable acceptance evidence.
- Replay screenshots verify the reported process-only layout and the filled
  body. One media resource was unavailable in the bounded capture, so these
  screenshots do not establish media-preview acceptance.

## Release boundary and build incident

Focused opening checks passed in Chromium: loading-state retention, genuine
short conversations in both renderers, filled first pages in both renderers,
native cancellation, and intermediate frames for both collapsed first pages
(9 tests). Broader continuous-wheel and reverse-reading tests exceeded their
45-second limits in both the candidate and the control with these native changes
removed. Their artifacts are retained separately in `native-results` and
`native-before-results`; neither result is full scrolling acceptance.

The final scoped legacy change also passed the three forward-publication
checks (End, moving upward during a pending page, and cached forward paging).
Native adjacent-page warming/reuse, touch at a warm boundary, and a filled
20-record cold opening retained their existing behavior (three further browser
checks). The focused HappyThread/DSH unit suite passed 41 tests. These are
desktop Chromium checks, including a 390 by 844 viewport, not a Pixel 9 run.

Before the authorized release described below, validation encountered a build
incident:
`bun run --cwd web build --outDir ...` incorrectly passed the extra arguments
to the trailing `cp` in the package script. Vite therefore wrote into the served
`web/dist` directory. The previous complete static bundle was immediately
restored from `/mnt/cache/build-cache/hapi-session-locality-20261005/web`;
the HTTPS entry again references `/assets/index-CI7_dkxO.js`.

The Hub and native service remained active with unchanged PIDs. Subsequent
candidate builds invoke `bunx vite build --outDir <cache-path>` directly from
`web`, which writes its application and service-worker outputs under the cache
directory. The authorized release publishes that verified bundle explicitly.

## Authorized production release

At the user's request, the checked frontend was published on 2026-10-05 at
23:00:52 UTC. The HTTPS entry now loads `/assets/index-RBDNvXqH.js` from
`/mnt/cache/build-cache/hapi-entry-gap-20261005/checked-web`. Assets were copied
before atomic root-file replacement; previously published hashed assets remain
available. The entry HTML, its seven linked JavaScript/CSS assets and `sw.js`
matched the candidate over HTTPS. Rollback root files are retained at
`/mnt/cache/build-cache/hapi-entry-gap-20261005/previous-entry`.

Authenticated Chromium checks opened and reloaded HAPI Main, the reported
Pixel-family conversation, and the existing Windows conversation at widths of
390 and 1440 CSS pixels. All six combinations loaded the new entry and rendered
content without page-script errors. Both reported long conversations filled
their viewports without a gesture. These are desktop-browser mobile viewports,
not new Pixel 9 device checks. Service workers were blocked in the fresh test
contexts; an existing PWA's worker-update lifecycle was not reverified.

The live checks also retained these limitations:

- A fixed 1.2-second observation initially ran before Main's history page had
  arrived. Waiting for actual coverage subsequently confirmed automatic
  publication. This is not a guarantee that uncached opening has no network
  wait or partially filled intermediate frame.
- Main's incremental history requests intermittently returned HTTP 503, then
  recovered with successful responses while the body remained readable. The
  six-combination run recorded one such failure among 32 history responses;
  an earlier diagnostic recorded two. No backend fix is claimed by this release.
- The legacy Pixel-family path had one sampled 144 CSS-pixel distance from the
  scroll floor shortly after publication. A focused repeat sampled zero distance
  throughout 20 observations over about two seconds. The repeat does not erase
  that earlier observation or establish complete intermediate-frame acceptance.
- The Windows machine briefly appeared inactive during a later preflight and
  was active again on the next query without intervention. Its machine identity
  was unchanged. The cause of that transient status is not established here.

Hub and native bridge PIDs and process start times were unchanged across
publication. Both registered machines were online on the final check. No CLI,
Hub, Runner or native engine restart, conversation mutation, or history rewrite
was performed. Evidence is retained as `publish-result.json`,
`publish-assets.json`, `publish-live.json`, `publish-diagnostic.log`, and
`publish-pixel-settling-retry.log` in the private evidence directory above.


## Follow-up: first visible presentation

The release above fixed eventual coverage, but it still exposed the initial
partial window before coverage and virtual geometry settled. Its visible
correction is the next reported defect. First data, first mounted DOM, and first
presentable viewport are separate boundaries.

Both renderers now use `useInitialChatPresentation`. During opening, the real
bounded message window remains mounted and is measured with `visibility:hidden`
and `inert`; the existing loading skeleton is an overlay outside that measured
column. It becomes visible once the rendered message version matches the live
window, the mounted rows match virtual geometry, and the existing scroll owner
has completed the intended landing. A complete short conversation stays at the
top. Only first-viewport coverage is required, not full history, image download,
or successful background revalidation.

`WindowedMessageList.isLayoutReady` reports readiness without moving the reader.
It checks row measurements and the committed virtual extent, and requires the
last row to be mounted for a tail landing. The native path additionally observes
DSH initialization, navigation, and opening coverage. The legacy path observes
its existing restoration and history-loader state. Its temporary tail scroll
anchor is not a saved reading bookmark; otherwise the bookmark branch can bypass
the floor check. The live-store/render version check also prevents a stale
`hasMore` prop from exposing an incomplete window.

Presentation is one-shot per mounted session. Already displayed content stays
visible during background synchronization, errors, and history paging. Successful
empty responses and failed coverage requests finish opening through the existing
empty/error paths. Cached, usable windows can be shown while a held latest-tail
request is still pending. Existing layout/resize controllers continue positioning;
this hook introduces no scroll writes or fixed delay. Legacy opening scroll timers
are cleared after presentation, while its input-attribution deadline keeps its
existing meaning. No service, protocol, native history, or database changes are
part of this follow-up.

The final candidate is
`/mnt/cache/build-cache/hapi-first-presentation-20261006/web-final`. It was
subsequently published together with the async-question frontend fix; see the
combined release record below. Backend processes were unchanged by this release.

### Follow-up evidence

- Candidate web typecheck and the focused HappyThread/mobile-scroll/DSH suite
  passed before the later concurrent workspace edits (56 unit tests).
- In the frozen production-data replay, HAPI Main and the Pixel-family session
  each pass at 390 and 1440 CSS-pixel widths. From the first visible frame,
  120 or more animation-frame samples have zero tail-distance and zero range
  in the final visible node's bottom coordinate. There are no page-script
  errors or later hidden-body frames. Controls recorded visible bottom-coordinate
  changes of about 581 and 513 CSS pixels respectively at mobile width.
- The four production-build runs are recorded in
  `first-paint-final-replay-results.json`; trajectories are in the corresponding
  `first-paint-*-candidate.json` files under the private evidence directory.
- `first-paint-main-final.png` and `first-paint-pixel-final.png` were captured
  with webshot and visually inspected. The Main capture still lacks the media
  payload already noted above; it verifies viewport placement, not media loading.
- These are desktop Chromium runs, including mobile-sized viewports. They are
  not new Pixel 9 measurements, production verification, compositor video
  capture, or proof of a particular FPS. The replay made no model calls.

- Final immutable fixture build: all 20 opening cases and all four selected
  forward-pagination/legacy-bookmark cases pass (24 browser checks). This avoids
  Vite HMR during concurrent edits. The earlier development-server runs contain
  intermittent End-navigation failures, and one diagnostic run overlapped an
  incomplete `retainSessionPresentation` export update and a tail reload. Those
  failed logs are retained; the fixed-build pass does not establish that every
  earlier failure had the same cause.
- The separate focused regression run also passed native adjacent-page reuse,
  stable answer identity, native expanded-process restoration, pending-question
  focus, and virtual-code source restoration. A later whole-workspace typecheck
  fails in concurrently developed `SessionPaneController.tsx` (duplicate React
  imports) and `workspace/layoutAdapter.ts` (`splitterSize`/`getRoot` API types).
  Those files were not changed by this fix. The earlier checked production
  candidate remains separate from that unfinished workspace integration.
- Fixture artifacts and logs: `first-paint-static-opening.log` (20 passed),
  `first-paint-static-regression.log` (4 passed), `first-paint-unit-complete.log`
  (56 passed), `first-paint-typecheck-complete.log` (candidate pass), and
  `first-paint-typecheck-workspace-final.log` (later concurrent errors). Static fixtures
  live under `/mnt/cache/build-cache/hapi-first-presentation-20261006/fixtures`.
  All temporary loopback replay, fixture, and development servers started for
  this investigation were stopped after acceptance.

### Combined production release, 2026-10-06

At the user's explicit request, the checked candidate was published at
02:03:01 UTC as `assets/index-BVgty0mQ.js`. This exact candidate had been built
and checked before the later workspace integration. It includes the first-visible
presentation fix and the other agent's async-question parsing, Skip action,
answer submission, and failure/retry behavior. The async bridge had already been
published by that agent as `hapi-question-skip-20261005`; this release retained
that running backend. No Hub, Runner, native bridge, or Codex engine restart was
performed. The unfinished workspace UI and its later `questionDraft` refactor
are not part of this bundle. The shared development tree was not reverted.

Release verification:

- The HTTPS entry, all seven linked JS/CSS assets, service worker script, and
  manifest match the checked candidate bytes. Previous hashed assets remain
  available. Previous root files are backed up under
  `/mnt/cache/build-cache/hapi-first-presentation-20261006/previous-combined-entry`.
- HAPI Main, the Pixel-family session, and an existing Windows session opened
  and reloaded successfully at both 390 and 1440 CSS-pixel widths. All six checks
  loaded the new entry and reached `data-chat-presented="true"`; measured final
  tail distance was zero. There were no page-script errors and all 31 history
  responses succeeded. These live smoke checks supplement the first-frame
  replay evidence above; they are not a new physical-phone gesture test.
- Both registered machines remained online. Hub PID 2777710 and native-bridge
  PID 3662316, including their process start times, were unchanged.
- The candidate and the actual HTTPS bundle each passed four isolated-question
  browser cases: blank Skip, failed Skip followed by retry with the draft intact,
  free-text submission, and no Skip action for blocking questions. All permission
  writes were intercepted for a synthetic session; no real question was answered
  or skipped. Three async-bridge tests also passed, including the native reply
  envelope/acknowledgment and skipping without interrupting the running turn.

Private release evidence is in
`/mnt/cache/data-cache/hapi-combined-release-20261006`: `publish-result.json`,
`served-assets.json`, `publish-live.json`, `candidate-questions.json`,
`live-questions.json`, `async-bridge-test.log`, and the before/after service
records. Browser fixtures initially needed a correct empty scratchlist response;
the corrected fixture passed. The deliberate retry case returns a simulated 503.
The permission checks block service workers, so their registration warning is a
test-context effect. A separate browser with service workers enabled successfully
installed the worker from the session-list page, gained its controller, and then
opened the real Main conversation using the published bundle. That run had five
successful history responses and no page-script errors (`sw-list.log`,
`service-worker.json`, `sw-browser.json`). Fresh-context probes starting directly
inside the active Main chat twice exceeded a 30-second worker-controller wait;
the last diagnostic showed the worker still installing, with no missing local
precache files. The successful list-first run does not establish the cause of
those cold-install delays. One additional active-chat probe also observed a
retryable history 503; this release makes no backend availability claim.

The live Main conversation changed during these extra probes: one later window
contained short commentary and collapsed process groups, with five mounted nodes,
zero scroll offset, and content shorter than the viewport. The bounded coverage
policy remains in effect, so a blanket assertion that every live long session
must always overflow the viewport is not a valid service-worker test. No bottom
alignment was added for short visible content, and no further source changes were
made during publication.

`live-mobile.png` was captured with webshot from the final live DOM snapshot and
visually inspected. The snapshot restores the captured tail reading position for
the still image; interactive navigation evidence comes from the browser runs,
not this serialized screenshot. The temporary candidate replay server was stopped.
