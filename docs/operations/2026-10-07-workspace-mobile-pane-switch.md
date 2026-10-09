# Mobile pane switching without reopening the chat

## Cause and implementation

Workspace retention kept entire layouts mounted, but `VisiblePane` still
returned `null` for nonfocused panes on phones and when maximized. Each P1/P2
return remounted its reader and composer and repeated initial presentation.
Caching message data alone could not preserve the already rendered view.

A pane now mounts on its first visit and remains mounted within the retained
workspace. Inactive panes are hidden and inert, do not receive focus or mark
messages read, and keep their own last visible dimensions. This overrides
FlexLayout's `display:none` and zero-sized maximized sibling panels, preventing
virtual readers from collapsing while hidden. Existing foreground synchronization
continues behind the retained content. The workspace retention budget reserves
all panes of a retained layout even on mobile, rather than counting only the
projected pane. The existing immediate-previous-workspace exception remains.

## Evidence

The former published build was tested with the same new return checks. Native
history showed opening skeletons across six sampled frames, through 497.5 ms;
mixed history showed skeletons initially and replaced the saved reader/editor.
See `mobile-warm-baseline-returns.log`. This establishes a lifecycle failure,
not a conclusion that every observed delay was network latency.

An intermediate, unreleased candidate retained the DOM but resized hidden
panes to the active pane's dimensions. The four-long-code regression caught a
112 px source-position shift after restoring desktop splits. It was replaced
with per-pane size capture. The code virtualization assertion now checks each
retained reader's DOM bound instead of assuming only one reader exists on a
phone. The source-position checks were preserved.

Two browser return regressions cover native and mixed history at 390 × 844.
After opening both panes, they hold history requests and switch twelve times,
sampling six animation frames on each return. Every sampled frame must show
content without skeletons, preserve the original reader/editor nodes, keep
scroll drift within 2 px and retain the independent draft. Hidden readers must
keep nonzero geometry. The broader workspace suite also covers resizing,
maximizing, mobile projection, long source bookmarks, history navigation,
cache eviction/garbage collection, sending, attachments, Goal drafts and resume.

The production candidate was also exercised against two real HTTPS sessions
using an isolated Chromium context, with history requests delayed by 3 seconds.
All sixteen returns kept the original content and DOM on the first sampled
animation frame, without application writes or page errors. First-frame timings
were 68–150 ms while other regression work was running. This is desktop Chromium
with a phone viewport, not a physical-phone or tmux latency benchmark.
The returned phone view was captured with webshot and visually inspected.

Builds are outside served assets at
`/mnt/cache/build-cache/hapi-workspace-mobile-warm-20261007`.
Candidate production assets are in `web-v2`; `web` is the superseded candidate.
Evidence is under `/mnt/cache/data-cache/hapi-tmux-implementation`:
`mobile-warm-v2-targeted.log`, `mobile-warm-v2-regression.log`,
`mobile-warm-v2-typecheck.log`, `mobile-warm-v2-production-build.log`,
`mobile-warm-candidate-live.json` and `mobile-warm-return.png`.

## Scope

This fixes warm P1/P2 returns and protects existing reading behavior. A first
visit, page reload, or reopening an evicted workspace can still load. The mounted
view budget is not a bound on total browser heap. It does not claim zero switch
latency, sustained mobile frame rate, or completion of all tmux capabilities.

## Published acceptance

Web typecheck and production build passed. All 32 compiled workspace browser
regressions passed in 3 minutes. The corrected long-code case also verifies
source positions after refreshing, in addition to resizing and projection.

Published 2026-10-07T05:06:16.543Z with entry `/assets/index-BN_Vvwpv.js`. The previous
root assets are backed up in `/mnt/cache/build-cache/hapi-workspace-mobile-warm-20261007/previous-web`;
old hashed assets remain available. Hub/native bridge PIDs stayed
3233230/2502589 and both services remained active.

A fresh isolated browser fetched the published HTTPS entry and performed
16 real-session mobile pane returns. Every sampled frame retained content,
reader and composer identity. There were 2 actual history requests delayed by
3 seconds, zero page errors and zero application writes. First sampled frames
ranged from 46.7 to 91.6 ms. See `mobile-warm-published-live.json`
and `mobile-warm-published.json`. This verifies the published browser flow,
while physical-phone latency remains unmeasured.
