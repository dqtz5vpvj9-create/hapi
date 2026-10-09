# Workspace view budget

This follows the two-workspace retained-view release in
[the warm-switch record](2026-10-06-workspace-warm-switch.md). That release fixed
reconstruction when alternating two layouts, but a third layout could still
turn the next return into a cold restore. A workspace count also charged the
same amount for one reader as for four readers.

## Policy

`WorkspaceSurface` now keeps the current workspace plus four inactive pane
views, in recency order. This retains five one-pane layouts or three two-pane
layouts. The immediate previous workspace is retained even when it alone has
more than four panes: two large layouts can still alternate without eviction.
The active workspace is never reduced by this policy.

Mobile and maximized layouts count their one projected pane. Returning to a
larger desktop layout recalculates the cost and releases older views. Changing
screen size does not remount previously evicted workspaces. Drafts, pending
attachments and semantic bookmarks continue to use their existing stores.

Hidden stages retain geometry and remain inert. A warm return reuses the reader,
composer and CodeMirror instances; history refresh runs asynchronously. The
policy adds neither a second transcript store nor extra server subscriptions.
Mounted readers still subscribe to their message windows. The four-pane budget
bounds that extra view cost; it is not a bound on all browser memory.

## Measurement

The same production fixture was served from two frozen builds. Each of five
conversations has 320 rows and a 1,500-line TypeScript answer. After opening all
five, each browser revisited them twice, with a saved draft and a deep source
character bookmark. Three fresh browsers per build produced 30 measured returns.
The timer starts at the actual click and ends when that source character is
within two CSS pixels of its old position. CDP/Playwright observation overhead is
included. Browser: Chromium 153.0.8010.12, viewport 1600 × 960.

| Measurement | Two-workspace retention | Pane-budget retention |
| --- | ---: | ---: |
| Return median | 285.4 ms | 106.5 ms |
| Return P95 | 404.3 ms | 170.7 ms |
| Return maximum | 427.3 ms | 200.4 ms |
| Maximum source-position drift | 0 px | 0 px |
| Ready in the first sampled frame | 30 / 30 | 30 / 30 |
| Mounted pane views after warming | 2 | 5 |
| Final retained JS heap, three runs | 36.32 / 36.63 / 36.38 MiB | 43.72 / 43.96 / 43.58 MiB |

Thus this workload trades about 7–8 MiB of retained JS heap for fewer view
reconstructions and faster restoration. The prior presentation cache already
avoided skeleton frames in these baseline samples; this comparison does not
claim to reproduce the user's original extended skeleton. The heap includes
fixed browser-side fixture data. It is not process RSS or physical-phone memory,
and these short repeated runs do not establish a long-term memory plateau.
The 150 ms latency target remains unmet at the tail.

Evidence is under `/mnt/cache/data-cache/hapi-tmux-implementation`:
`warm-budget-before-5-repeated/summary.json`, `warm-budget-after-5/summary.json`
and their per-run observations. The initial one-run baseline is also retained
in `warm-budget-before-5`; it is not pooled with the three-run comparison.

## Verification and release

Web typecheck, the production-fixture build and 43 browser flows passed. The
two- and five-workspace cases held all history responses during 12 and 15 warm
returns respectively. All sampled first frames retained readable content and
the same non-null reader, editable composer and CodeMirror nodes, with no blank
or skeleton frames. Those first-frame samples took 41–76 ms and 46–79 ms;
they measure a different endpoint from the code-position comparison above.

Two- and four-pane workspaces enforce their six- and eight-reader limits while
preserving the previous layout. Mobile projection and return to desktop apply
the budget again. The suite also covers old-reader collection, draft/bookmark
restoration after eviction, split/resize/zoom, list navigation, send failures,
hidden uploads, Goal isolation and native/legacy history paging.

An additional 48-conversation capacity run visited every conversation and then
returned to each. All 48 source bookmarks had zero drift, and all drafts
survived. At the 12/24/36/48-visit checkpoints and after the return cycle there
were five mounted readers, five populated body windows and 7,373 document DOM
nodes. Cold returns after eviction took P50 462 ms, P95 575 ms, maximum 652 ms.
Those are not warm-switch measurements.

Total retained JS heap rose from 63.60 MiB at 12 visits to 73.88 MiB at 48, and
87.46 MiB after returning to all 48. Thus the reader and body-window bounds held,
but total memory growth remains unresolved. This run is not a before/after
comparison of heap growth, nor evidence of a long-term plateau. See
`warm-budget-capacity-48/summary.json` and `warm-budget-browser-regression.log`.

A subsequent diagnostic run revisited the same 48 conversations four times.
All 192 returns preserved their code positions with zero drift. Post-GC JS heap
was 73.45 MiB after the initial visits, then 87.16, 88.18, 88.45 and 88.74 MiB.
Between the first and fourth revisit snapshots, compiled code grew by 1.375 MiB;
DOM counts did not grow each round. This narrows the late growth but does not
explain the earlier jump. A separate initial/first-return snapshot pair shows
growth primarily in objects, arrays and closures, whose retainers still need
investigation. Do not describe total memory as bounded on this evidence.
Raw observations and heap summaries are in `view-budget-heap-48`,
`view-budget-initial-heap-48`, `view-budget-heap-diff.json` and
`view-budget-initial-heap-diff.json` under the evidence directory above.

Published at 2026-10-06 05:00 PDT. The HTTPS application now serves
`/assets/index-DLr2d-OT.js` from the production-only build at
`/mnt/cache/build-cache/hapi-workspace-budget-20261006/web`. Root-file rollback
copies are in its sibling `previous-web` directory; old hashed assets remain
available. Hub/native bridge PIDs stayed 3233230/2502589. No backend service or
native Agent was restarted, and no commit or push was made.

Before publication, the production-only candidate was exercised against the
real HTTPS Hub in an isolated desktop Chromium context. Twelve returns between
the user's existing Linux/Windows chat layouts, with message GETs delayed three
seconds, kept the same readers and editable inputs with no skeletons; first
sampled frames took 16–55 ms. No chat sends or workspace writes occurred.

After publication, a new browser loaded the actual served entry without asset
substitution. The same twelve-return check took 19–41 ms, with content and input
identity preserved in every sampled first frame. It reported no JavaScript
errors or attempted writes. These observations are desktop Chromium checks of
real conversations, not measurements on physical Windows Chrome or a phone.
Evidence: `warm-budget-candidate-live.json`, `warm-budget-published-live.json`,
and `warm-budget-published.json`.

A separate browser using a 390 × 844 viewport loaded the published entry and
passed list/back/cancel/select navigation, workspace location labels, source
passage restoration within two pixels after reload, and restoration of the two
desktop panes. The shared layout remained unchanged, with no JavaScript errors
or attempted writes. Evidence: `warm-budget-live-mobile-reading.json`.

The five-workspace compiled-fixture screenshot `warm-budget-desktop.png` was
captured using webshot after visiting all five and returning to the first, then
visually inspected. It shows the returned content, unobscured composer and
bottom workspace controls. It is visual evidence, not the latency measurement.
