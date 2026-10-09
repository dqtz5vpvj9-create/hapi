# Workspace code-reading restoration

## Reproduced problem and causes

A compiled browser fixture with four native conversations, each ending in a 1,500-line TypeScript answer, lost its source position after projecting to a phone-sized viewport, switching panes and refreshing. A diagnostic captured source position 112020 around line 870 before the switch; one failed return showed position 74603 around line 580. A cold refresh could instead show the top of the loaded message window. This was a reading-position failure, not missing history data.

The trace identified three interacting ownership problems:

- A workspace synchronization response called `WorkspaceStore.receive → capture` while the mounted conversation was still restoring. `NativeCodexThread` saved the provisional DOM at the top of the window over its existing source bookmark.
- The native viewport identified an asynchronous CodeMirror placement by its `ChatScrollPosition` wrapper. Repeated reads created new wrappers around the same bookmark, restarting the placement during layout updates.
- Reading policy sampled intermediate programmatic scrolling before initialization and replaced the saved source with a provisional row position. Separately, a cold CodeMirror editor could refine its line-height estimate while the target line was still unmounted; allowing only one estimated placement was insufficient.

The fixes preserve the pending bookmark during initial workspace captures, identify code placement by the bookmark itself, and initialize reading only after a completed landing. Initial programmatic scrolls do not become reader samples; genuine reader movement can still take control. Sparse code placement continues only while its residual error decreases, then uses measured character coordinates. Existing cancellation and non-convergence behavior remains covered. No delayed retry loop or additional transcript store was added.

## Verification

Web typecheck, the production build and 57 related component/reading tests passed. Three of those tests cover the new asynchronous initialization and cold-code geometry cases.

The original failing browser sequence passed three consecutive runs after the fix. The final browser test was then expanded to preserve four different source positions and four drafts: maximize/restore on desktop, project to a 390×844 viewport, visit every P button, return to P1 and reload. It observes the same source character, not a newly captured hit-test column at a different width. Each retained character stays within the test's half-pixel tolerance. The visible phone code DOM remains below 150 lines.

The final compiled fixture passed 38 browser flows: 21 existing workspace flows, two lifecycle flows, nine native presentation flows and six legacy history publication flows. The lifecycle set includes visiting 12 workspaces, beyond the five-session presentation cache and eight-session history cache, then recovering reading position and drafts. The six pagination flows were also run explicitly with the native renderer and passed: forward publication after End, movement during a held page, cached publication, and six-page backward reading using wheel, touch and keyboard. These 44 final flows include attachments, Goal isolation, existing mobile destination labels, and ordinary/workspace switching.

A four-pane long-code screenshot at 1600×960 was captured using webshot and visually inspected. These checks cover functional restoration and bounded mounted content, not physical-phone keyboard behavior, process memory budgets or sustained frame rate. The earlier 13–15 second startup outliers on the plain-text workload remain unresolved; this code-restoration diagnosis does not establish their cause.

## Release and live check

Published **2026-10-06 08:33:22 UTC**, entry **`/assets/index-DRF0onHb.js`**. Only frontend assets were updated; Hub PID 3233230 and native bridge PID 3233231 remained unchanged. No native engine or Windows service was restarted.

The direct HTTPS browser check loaded that exact entry, preserved the real two-pane layout and validated mobile list destinations, browser Back, list refresh, return without selection and existing-session selection. A further read-only check scrolled the actual conversation upward, captured a visible paragraph, refreshed the workspace and recovered that paragraph within two CSS pixels of its previous position. There were no JavaScript errors or workspace writes. This live check used real messages and layout synchronization; the four long-code source-position scenarios use the controlled fixture.

Build, fixture and previous frontend root files are under `/mnt/cache/build-cache/hapi-workspace-code-reading-20261006`. Existing hashed assets were retained and the entry document published last. Private logs and results use `/mnt/cache/data-cache/hapi-tmux-implementation/code-reading-*`; diagnostic snapshots use `code-lifecycle-*-trace.json`. Cache artifacts are subject to automatic cleanup.

The full workspace goal remains open. Terminal development remains paused at the user's request.
