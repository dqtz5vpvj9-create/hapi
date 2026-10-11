# Recent real-route regression harness

Source-only local QA for the production App/router/components through the existing
`web/e2e-fixtures/workspace-fixture.tsx`. A strict Vite transform extends only the
fake Hub: deterministic flat roots, lazy 320-message histories, versioned SSE and
genuine distinct-native root insertion. No copied application fixture, real Hub,
model calls, CI changes, or package changes.

## Run from the repository root

Requires installed repository dependencies, Node 20+, and a Playwright Chromium
installation. Process-group watchdogs require a POSIX host. Uses Playwright's
browser by default; set `PLAYWRIGHT_CHROME_PATH` to an existing executable if needed.
Do not run a browser measurement concurrently with builds or other measurements.

    node --test scripts/testing/recent/*.test.mjs
    HAPI_QA_BUILD=/tmp/hapi-recent-build-1 node scripts/testing/recent/build.mjs
    HAPI_QA_BUILD=/tmp/hapi-recent-build-1 node scripts/testing/recent/run.mjs smoke-1 '[{"count":1000,"viewport":"phone","entry":"ui","mode":"full","cpu":false}]'
    HAPI_QA_BUILD=/tmp/hapi-recent-build-1 node scripts/testing/recent/run.mjs anchor-1 '[{"count":1000,"viewport":"phone","entry":"saved","mode":"anchor","cpu":false}]'

Use fresh build directories and labels. `SOURCE_ROOT` selects an alternate checkout
(default: this repository); `HAPI_QA_RESULTS` selects the result parent (default:
`test-results/recent`). Keep build/results outside the harness source directory.
Results, screenshots, profiles, frozen runtime helper copies and bundles are local
outputs, not files to commit. A cell supports count 4–5000, viewport `phone` or
`desktop`, entry `saved` or `ui`, mode `full`, `lean` or `anchor`, and boolean `cpu`.
Anchor requires at least 100 roots and supports saved entry without profiling. Maximum 30 cells; first failure
stops the run. Each browser process group has a 22-second watchdog with TERM/KILL;
the build is bounded to 180 seconds. Failed or interrupted work is not a pass.

## Evidence and limitations

Build receipts hash web/shared sources, tracked fixtures, package/lock files and
harness files before/after build, plus emitted assets. Runs check the receipt and
asset hashes, require current relevant source and helper hashes to match that build,
freeze helper copies with hashes and record terminal status. Source or helper drift
is rejected: rebuild before running after edits. `SOURCE_ROOT` selects the checkout
whose current sources are checked and whose installed runtime dependencies are used.
The receipt identifies bytes, not historical performance equivalence. It is not a
cryptographic signature or protection against a hostile receipt writer.

Full mode checks titles, order, coverage, date headings and integer-device-pixel
hit targets on visible rows; unsampleable fractional slices remain unobservable.
It records DOM-sampling overhead. Lean mode uses RAF and trusted wheel event times
without per-frame DOM reads and does not prove per-frame visual correctness. The
stable-selector wheel listener retargets a replaced viewport, rather than silently
losing saved-entry input. Host input is 60 independently scheduled trusted wheel
events over one second, down then reverse; boundary/coalescing are not input loss.

Anchor mode separately asserts the same row/top within 2px after timestamp SSE and
a real new top root (including logical count and identity), then wheel reversal.
It does **not** test explicit refresh. Phone means 390×844 Chromium emulation with
wheel, not physical touch/network evidence. CDP JS heap includes fixture/transient
garbage and is not renderer RSS. Flat roots do not prove bounded work for a huge
expanded subtree. CPU profiles are optional, separate from correctness claims.

`origin.json` records frozen upstream source hashes and archive hash. That archive
also contains obsolete helpers; it is not an acceptance bundle. In particular,
old-listener saved-entry lean evidence and old cloned-native prepend evidence must
not be used. The corrected native identity is now in this copied fixture transform;
the v2 driver's temporary emit adapter is removed. Original baseline-red explicit
refresh comparisons are not included or relabeled as passing here.

Portable integration and the changed insert fixture require a fresh browser smoke
and anchor run before acceptance. At preparation time only static checks and helper
unit tests were permitted; no fresh build or browser/performance run was performed.

### Validation update — 2026-10-11

The preparation-time limitation above is historical. A fresh build against clean
`a1d178bbe61da05012c549f571c5a0ca5b17b47c`, 14 helper tests and four native-cloud
Chromium cells passed: phone UI/full, phone saved/lean, desktop UI/full and phone
SSE/genuine-insert anchor. The inserted list had 1001 roots with `chat-1001` first;
both anchor deltas were 0px. The full phone run retained 40 unobservable fractional
hit slices. A separate sandbox Chromium setup failure was preserved, then the same
build passed through the supported own-cloud terminal. No explicit-refresh or
physical-phone claim follows from these checks.

Tested source identity:
`f4870de99666dbfd07aba389357f4a0aa7042be2d12dc9390656dc151732937f`.
This validation note is the only post-build source edit; all runtime/config/test
files are byte-identical to the passing build. Because receipts also hash this
README, build afresh from the published source before running subsequent checks.
