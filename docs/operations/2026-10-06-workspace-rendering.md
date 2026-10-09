# Workspace rendering measurements — 2026-10-06

Mobile session selection already returns to the existing session list. Terminal work remains paused. This investigation follows the initial-render stalls observed during attachment testing; it does not replace the full workspace acceptance plan.

## Workload and measurement boundary

`scripts/testing/workspace-performance.mjs` runs the real App against the compiled workspace fixture. Only the Hub boundary is simulated. The fixture contains 320 deterministic text messages per session and uses the production native-chat presentation, composer, virtual history and layout code. No model, native engine or production workspace is changed.

The cases are ordinary single-view chat and workspaces with one, two and four visible chats at 1600×960. Each opens a fresh browser context, waits for every chat's presentation flag, idles for two seconds, appends one message per visible chat in each of 20 ticks nominally 100 ms apart, scrolls the first chat upward, and leaves and restores the view. A busy main thread can stretch the tick interval; the recorded duration is the actual duration, not an assumed two seconds. The four-pane workload contains four times as many new messages as the single-pane workload.

Measurements include Chrome's main-thread `TaskDuration`, script and layout duration, animation-frame intervals, long tasks, DOM elements, mounted message seats, JS heap and heap retained after explicit garbage collection. Transfer bytes come from CDP; fixture response bytes count serialized simulated HTTP bodies, not compressed wire bytes or SSE payloads. These are headless Chromium 153.0.8010.12 measurements on the shared 12-CPU development host, not phone FPS, network latency or process RSS. The test does not cover large code blocks, expanded tools, actual typing or a hidden working set beyond the cache budget.

The original baseline completed five runs of all four cases. A separate paired run alternates reference and candidate builds, reversing their order in successive rounds. Failed samples remain in the output. CPU profiling and React commit diagnostics run separately from the timing comparison. All artifacts and browser temporary profiles use the cache disk.

## Cause and candidate change

The native thread's chat-context memo depended on the entire props object. In addition, the parent recreated the plan-focus callback and the send hook recreated retry/discard callbacks on every message-window update. This invalidated unchanged message action consumers during scroll and streaming commits.

The candidate lists the context's actual dependencies, keeps the plan-focus callback stable, and forwards retry/discard actions to the latest handlers through the thread's existing current-props reference. Permission, disabled, history-operation and active-tool values still invalidate the context when they change. No message contents, history pagination, reading coordinator or layout persistence behavior is changed by this patch.

A separate React commit diagnostic counted 120 chat-context changes during the two-pane, 40-message workload before the patch and 40 afterward. The remaining changes include the latest completed-answer boundary used by history actions. This count establishes the removed invalidations; it is not a frame-rate result.

## Paired results

All 40 samples completed without JavaScript errors, unexpected fixture requests or message sends. Each cell below is the median of five runs; milliseconds are rounded. Reference and candidate were alternated within each round.

| View | First presentation, reference → candidate (ms) | Stream main-thread time, reference → candidate (ms) | Median paired stream change | Stream frame p95, reference → candidate (ms) | Retained heap, reference → candidate (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ordinary single view | 2,150 → 1,794 | 2,332 → 1,636 | −22.9% | 133 → 83 | 25.2 → 24.9 |
| Workspace, one pane | 2,044 → 1,964 | 2,341 → 1,602 | −33.8% | 100 → 67 | 32.7 → 32.6 |
| Workspace, two panes | 2,290 → 2,288 | 3,892 → 3,171 | −15.9% | 267 → 167 | 36.5 → 36.6 |
| Workspace, four panes | 3,181 → 2,916 | 4,866 → 4,298 | −12.6% | 300 → 250 | 36.2 → 36.2 |

The paired change is the median of the five candidate/reference percentage changes, not the percentage difference between the two medians. All five four-pane samples used less main-thread time during updates; the other cases had individual slower samples. This supports the specific context-invalidation fix, not a general smoothness or 60 FPS claim. The frame p95 column is the median of per-run frame p95 values, not a pooled percentile.

The remaining startup stalls are material: the candidate one-pane maximum was **15,152 ms**, and four-pane maximum **13,363 ms**, versus reference maxima of 3,839 and 5,688 ms respectively. The one-pane outlier contained a roughly 10.4-second frame gap and 14.8 seconds of main-thread task time; the four-pane outlier had a large wait not accounted for by its task time. These samples are retained. Shared-host contention and presentation-readiness behavior need further investigation; neither is established as the cause. Startup latency is not accepted as solved.

A subsequent diagnostic run instrumented React's commit hook and sampled the actual presentation predicate, reading owner, virtual-layout readiness and scroll geometry. Ten one-pane and ten four-pane openings all completed: 1,288–1,960 ms and 2,000–2,691 ms respectively, with no sampled state where the predicate was ready while the body remained hidden. This did not reproduce the earlier stalls or substantiate a missed-notification fix. The extra instrumentation makes these diagnostic timings unsuitable for extending the paired performance comparison. No visibility-condition change was made on this evidence. Raw diagnostic records are under `presentation/` in the artifact directory below.

Scroll main-thread medians for single/one/two/four panes were 1,738/1,547/973/570 ms before and 1,648/1,391/1,013/645 ms after. View-restoration medians were 442/479/830/946 ms before and 329/496/789/1,059 ms after. The fix does not establish improvement in these phases. Each viewport has different geometry and content visible after scrolling, so those figures should only be compared within the same case.

## Verification and release status

The completed candidate passed Web typecheck and all 20 workspace browser flows against the compiled fixture, with the existing five-second assertion deadline. These flows cover mobile list navigation, desktop sidebar selection, independent draft and reading state, single/workspace switching, resize, drag, zoom, four chats, legacy/native history, attachment completion while hidden/reloaded, removal of an in-flight attachment, and goal editing in its originating pane. The real Hub is not exercised by these fixture flows.

The production-only build and 74 session/plan tests also passed. A compiled four-pane screenshot at 1600×960 was captured with webshot and visually inspected.

Published at **2026-10-06 07:54:09 UTC**, Web entry **`/assets/index-CGQ7L37N.js`**. Build and previous root files are at `/mnt/cache/build-cache/hapi-workspace-rendering-20261006/{web,previous-web}`. Existing hashed assets remain available; rollback restores the previous root files with `index.html` last. Only frontend assets were published. Hub PID 3233230 and native bridge PID 3233231 remained unchanged; no Windows service or native engine was restarted.

The direct HTTPS browser check loaded this exact entry and passed mobile browser Back, list refresh, return without selection, and selection of the already-open chat. The user's current two-pane layout was preserved when returning to desktop width. There were no JavaScript errors or workspace writes. A separate 390×844 production-list screenshot, captured through the read-only loopback authentication proxy, was visually inspected. The proxy and three fixture servers were stopped afterward.

The full workspace goal remains open, and terminal work is paused. These headless checks do not establish real-phone keyboard behavior or sustained multi-device performance.

Private artifacts are under `/mnt/cache/data-cache/hapi-workspace-performance-20261006` and `/mnt/cache/data-cache/hapi-tmux-implementation/performance-*`. Frozen fixture builds are under `/mnt/cache/build-cache/hapi-workspace-performance-20261006/{baseline,context-handlers}`. The cache is subject to seven-day cleanup; final aggregate results belong in this document.

An initial profiling attempt omitted `Profiler.enable`; a subsequent benchmark launch used a TMPDIR too long for Chromium's Unix socket. Both failed before collecting workload samples and were corrected in the harness. The first partial candidate did not establish a timing improvement and is not the final comparison candidate.
