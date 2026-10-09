# Distinct-session working-set capacity

The earlier fixed-twelve-workspace benchmark checked repeated reopening and DOM
release. It did not bound the message bodies retained while opening more distinct
conversations. `message-window-store` capped rows within each conversation but
kept every visited conversation's rows indefinitely.

The existing recent-session controller now releases an inactive conversation's
server bodies when it leaves the five-session recent set. Subscribed readers are
not evicted. More than five simultaneously visible readers remain foreground;
this is not a five-pane restriction. Release preserves local/queued rows and the
semantic reading bookmark in memory, including when session storage is full.
It aborts the departing read and advances the existing generations, so late
responses cannot repopulate the released window. Reopening uses the existing
message-context API to recover the saved source identity. Global queue-control
events can still mark the preserved local IDs consumed while a pane is hidden.

This adds no database copy, protocol or history format. The page repository and
presentation cache retain their separate existing limits. Lightweight per-session
state, drafts and unsent messages remain; this is a bound on cached server bodies,
not a fixed limit on all browser memory.

## Measurement

One before/after pair used Chromium 153.0.8010.12 at 1600×960. Each run visited 48
different one-pane workspaces, saved an independent draft and a deep position in
a 1,500-line TypeScript answer, then returned to all 48. Full garbage collection
occurred outside the timed intervals. Builds and tests did not run alongside
these measurements.

| After first visits | Baseline body windows | Revised body windows | Baseline JS heap | Revised JS heap |
| --- | ---: | ---: | ---: | ---: |
| 12 conversations | 12 | 5 | 53.31 MiB | 50.36 MiB |
| 24 conversations | 24 | 5 | 61.58 MiB | 54.45 MiB |
| 36 conversations | 36 | 5 | 70.05 MiB | 57.90 MiB |
| 48 conversations | 48 | 5 | 79.25 MiB | 62.37 MiB |
| Return to all 48 | 48 | 5 | 79.37 MiB | 66.43 MiB |

After the first 48 visits, the retained windows' serialized UTF-16 size was
18.80 MiB before and 1.96 MiB after. That serialized size is not heap allocation.
All 48 revised return visits preserved their draft and original source character
with zero measured pixel drift. Restore P50/P95/max were 346/884/951 ms; baseline
values were 414/786/907 ms. This single pair does not establish a latency gain.
An evicted reader may need a context fetch; network cost remains a tradeoff.

The mock backend holds all 48 histories in the browser before measurement.
Heap figures include that fixed cost and V8 compilation; they are not RSS or
phone measurements. Heap still increased as more distinct sessions were visited
despite the five-window bound. The remaining growth needs separate attribution;
this result does not establish an overall memory plateau.

## Verification

- Web typecheck and all 3,689 web tests passed. Added cases cover preserved queue
  identity, consumption while hidden, full session storage, subscribed readers,
  late replies after release, and source-message recovery.
- The initial 39-flow browser run passed 38 flows. The failed cold-return flow
  exposed a missing message-context endpoint in the fixture. After adding that
  endpoint, all three affected lifecycle flows passed, including the failed
  case. The other 36 flows used unchanged product code and remain valid.
- The 48-session compiled-browser measurement checked all 48 independent drafts
  and code positions, with no unexpected API requests or JavaScript errors.
- Six additional native-renderer pagination flows passed, bringing the unique
  browser-flow coverage to 45. The history checks exercised wheel, touch,
  keyboard, forward continuation, regrouping and page-cache eviction.

## Release

Published the production-only build at 2026-10-06 02:31 PDT. The HTTPS page serves
`/assets/index-D3zTdGPV.js`. Hub/native PIDs remained 3233230/3233231. Root-file
rollback data is in `hapi-workspace-capacity-20261006/previous-web`; old hashed
assets were retained and `index.html` was switched last.

The post-release HTTPS browser check matched that entry, verified
`Workspace 1 · P1` and `Workspace 1 · P2` in the phone-sized session list,
and exercised browser Back, list refresh, return without selection and selecting
the existing session. Real conversation reading survived refresh within 2 CSS
pixels. The actual two-pane desktop layout was preserved, with no JavaScript
errors or workspace/API writes. This was browser emulation, not physical-phone
acceptance. No commit or push was made.

The first build attempt mistakenly appended Vite arguments to the compound web
build script, which passed them to `cp` after Vite wrote to the served directory.
The previous verified production build was restored immediately, including older
hashed assets from retained release builds. Subsequent builds invoked Vite
directly with explicit cache-disk output directories. This was an operational
mistake, not a planned deployment; no backend service was restarted. The correct
invocation is now documented in `scripts/testing/README.md`.

Artifacts are under `/mnt/cache/data-cache/hapi-tmux-implementation/capacity-*`
and `/mnt/cache/data-cache/hapi-workspace-capacity-{baseline,fixed}-20261006`.
Builds are under `/mnt/cache/build-cache/hapi-workspace-capacity-20261006`.
These cache artifacts expire and are not durable product data.
