# Upward history prefetch and frame stalls

Status: initial synthetic investigation. The subsequent real-conversation replay
and fixes are documented in [real-history replay](./2026-10-05-real-history-replay.md).
The measurements below describe this earlier experiment, not the final candidate.

## Confirmed behavior before this change

`useHistoryPreload` only started after wheel/touch input, fetched one adjacent page, and did not recheck after completion. Its 1,000 ms input lifetime could expire during inertia. It did not warm the short initial reading window. Later requests did start before the top boundary, so the presence of requests alone was not evidence of smooth scrolling.

A compiled Chromium replay used a 390 x 844 viewport, a 20-message initial window, 1,200 synthetic messages, 500 ms older-page latency, and repeated upward wheel input. No model calls or real conversation copies were used. The first older request started with foreground loading already true. Later requests started around 2,252–3,000 CSS pixels from the boundary.

The same replay recorded 19 frames clamped at the upper edge while loading, a 103 ms p95 frame interval, and a 1,066 ms maximum interval. These are diagnostic runs with CPU profiling enabled, not device performance promises or statistically repeated benchmarks.

## Candidate changes

- Native Codex warms one adjacent older page as soon as an eligible initial window exists, without publishing it into the visible window.
- Window changes and completion re-evaluate an active reader's boundary. They do not recursively scan pages beyond that boundary.
- Same-direction inertial movement renews the active gesture; programmatic restoration does not.
- Native gesture listeners no longer reset their touch coordinates when a page changes the loaded-turn array.

A batched row-measurement experiment was also profiled, but showed no established frame-time improvement and was reverted. The candidate replay figures below include that experiment; they must not be presented as final-source performance results.

A compiled candidate replay verified the first page was fetched before input, the initial visible window remained 20 messages, and idle time did not trigger a history crawl. The continuous replay had no sampled frames waiting at the clamped top boundary, but still recorded long render frames (113 ms p95, 1,408 ms maximum in that run). This does **not** establish a scrolling performance improvement.

## Remaining cause to address

The CPU profile contains substantial assistant-ui message/composer client resource work and layout reads. Source inspection confirms `ThreadClient` builds message clients for the entire runtime message array. The native virtual list mounts a small DOM range, but `useHappyRuntime` still supplies the entire bounded message window to that runtime. Thus DOM virtualization alone does not bound all runtime work to visible nodes.

A further change must separate content-window ownership from the set of active presentation runtimes, while preserving composer behavior, stable message identity, tool interactions, and reading/navigation anchors. Do not merely shrink the history cache, remove bookmark restoration, or introduce delayed scrolling to hide the cost.

## Evidence

Temporary replay scripts, CPU source-map analysis, request traces, and logs are under `/mnt/cache/data-cache/hapi-preload-20261005`. These files are temporary and automatically expire. Browser replay used compiled local fixtures, not a Pixel 9 production session. The production bundle was not changed by this investigation.

## Validation boundary

Web typecheck and eight cache/locality unit checks passed. Five compiled prefetch flows passed: initial warm-up without publication, continuous traversal, reverse cached traversal, touch approach, and short-window entry. Two dev-browser checks also passed after retaining the gesture listener across page changes. The three End/forward-publication checks initially failed during setup because a large gesture could now consume multiple warm pages. After making setup track the actual reached frontier instead of assuming one page per gesture, all three passed in the compiled candidate. These functional checks still do not establish smoothness; the long-frame acceptance gate remains open.
