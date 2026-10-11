# Reproducible long-history browser procedures

These procedures exercise the real application through the arithmetic native
fixture. They measure renderer-local synthetic response handling, not the real
Hub, native daemon, filesystem index, physical phone, or mobile network.

## Run from the repository

Build after adding these files; a prior six-file-only build is intentionally
rejected because its helper manifest does not include this browser procedure.
Choose fresh build/results destinations outside the harness source tree.

    HAPI_QA_BUILD=/tmp/history-build node scripts/testing/history/build.mjs
    HAPI_QA_BUILD=/tmp/history-build HAPI_QA_CHROMIUM=/usr/bin/chromium node scripts/testing/history/browser/run.mjs cold cold-full '[{"historyCount":320,"viewport":"phone","mode":"full","cpu":false}]'
    HAPI_QA_BUILD=/tmp/history-build HAPI_QA_CHROMIUM=/usr/bin/chromium node scripts/testing/history/browser/run.mjs warm warm-code '[{"historyCount":100000,"viewport":"phone","mode":"lean","cpu":false,"warmMode":"code"}]'
    HAPI_QA_BUILD=/tmp/history-build HAPI_QA_CHROMIUM=/usr/bin/chromium node scripts/testing/history/browser/run.mjs warm warm-target '[{"historyCount":100000,"viewport":"phone","mode":"lean","cpu":false,"warmMode":"target"}]'
    HAPI_QA_BUILD=/tmp/history-build HAPI_QA_CHROMIUM=/usr/bin/chromium node scripts/testing/history/browser/run.mjs geometry early-geometry '[{"historyCount":100000,"viewport":"phone","mode":"lean","cpu":false}]'

HAPI_QA_RESULTS defaults to test-results/history. HAPI_QA_CHROMIUM selects an
installed trusted Chromium executable; when unset, Playwright uses its installed
browser. SOURCE_ROOT can select a frozen product snapshot. Each cohort accepts
1–30 explicit cells. H is320,10000,100000; viewports are phone390×844 or
desktop1600×960. CPU profiles require lean mode and run separately. Geometry
is a separate lean-labelled diagnostic with mandatory extra geometry reads.
Run serially on an idle own-cloud machine; do not overlap tests/builds/profiling
or interpret emulation as a measurement on the user's device.

## Preserved experimental meaning

- Cold: fresh browser context and actual session-list route; certify1000 logical
  roots, no target history fetch/cache/seats, no chat viewport before activation.
- Warm code: enter a different conversation through actual UI, scroll, return;
  keep target history cold. Warm target: prime the target's runtime/data before
  returning. The warm driver records its actual priming separately.
- Actual trusted row activation starts the independent host60-event,1-second
  up-then-down schedule. It never waits for chat readiness. Host dispatch,
  browser event timestamps and handler execution time are different fields.
- Retain deliveries to the old list, loading body and target. A globally
  observed wheel does not prove the loaded chat moved. Opposite-direction
  coalescing can reduce event count/absolute delta without proving lost input.
- Declared presentation is the production visibility flag. Lean mode does not
  certify per-frame geometry. Full mode records visible canonical keys, role,
  content, order/coverage and measurement overhead. An empty mounted seat or
  initial skeleton is not usable message content. Opening is separately counted.
- Passive geometry records capture/microtask/next-RAF and publication/scroll
  geometry, including the scrollable floor before visible readiness. These
  extra layout reads can perturb timing; do not pool this diagnostic with lean
  frame results or present it as direct pixel-presentation measurement.
- Heap is page JavaScript including the fixture, not total renderer/RSS. Forced
  GC occurs outside input/CPU timing. Final loaded-window and mounted-row
  counts differ from logical history length and total request generation.

## Evidence and failure contracts

Each run saves a terminal status, exact build and asset identities, frozen
runtime helper hashes, cell preflight, raw observation/dispatch, summaries and
screenshots. CPU cells additionally save a profile. Errors and partial runs
remain in their fresh result directory; stop repetitions on first failure.
The runner verifies all build assets and product/helper sources before launch
and after completion, and uses the repository's owned-child timeout/cleanup.
Frozen helper files are evidence snapshots; rerun using this repository runner
and its verified build, rather than invoking the flat frozen runner copy.

Passing a smoke gate establishes its recorded functional/end-state checks. It
is not a claim that first-second scrolling was responsive or that no early
input was clamped/coalesced. Preserve raw phase and recipient fields when
summarizing; do not replace them with a single pass/fail or claim zero loss.
Distant outline/context navigation and sustained paging are separate experiments
not implemented by these cold/warm/geometry drivers.

Pure contracts:

    node --test scripts/testing/history/arithmetic-history.test.mjs scripts/testing/history/browser/cells.test.mjs

The origin manifest records source driver/probe hashes. This addition-only
portability stage changes executable selection and relative cold-file names,
but preserves the measured driver/probe algorithms and phase fields. Portable
runner and all three scenarios require their own validation before certification.
