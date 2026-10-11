# Long-history frontend experiment candidate

Source-only synthetic boundary over the existing real App/router/native chat UI.
1000 session summaries, logical history H=320/10000/100000. The generator stores
zero bodies and materializes only a requested page (at most200), context(at
most199), or separate outline labels(at most100). Counters retain at most256
request records with aggregate generation/UTF-8 byte totals. No model, daemon,
real Hub database or user device is involved. Mutation helpers deliberately fail.

Start URL after immutable build:
/e2e-fixtures/workspace-fixture.html?list&sessionCount=1000&historyCount=100000
The ?list parameter selects /sessions?view=list; omit panes/single/savedSingle.
A new browser context is required for every cold trial. Before target click,
assert router pathname=/sessions, target chat viewport absent, target history
request count zero and target local/session cache keys absent. Do not call the
getMessageWindowState-backed activeMessageWindow probe before cold entry: it
creates an empty store. All session-store enumeration is forbidden in timing.

Use a real list click and start independent host input timers at click dispatch,
not at chat readiness. Record events delivered to the old list/overlay and late
or coalesced deliveries; never silently discard them. First half upward, second
half downward. Measure click→correct first visible chat separately. Polling RAF
is a scheduling proxy, not presented pixels. Geometry correctness runs and CPU
profiles are separate from lean timing. Check checkpoint DOM/content/anchor
correctness; take heap/forced GC only outside timed input. Page heap includes
the renderer-local fixture and is not total renderer memory.

Native initial latest fetch requests20. Its warmInitial adjacent200 page request
begins when a history cursor exists, enters the repository without publishing
into the reader, and may overlap initial presentation. Foreground older paging
can share the pending repository read. Initial fill can separately publish up
to two pages if the initial viewport is short. Report the actual request timing,
cache generation and first visible readiness; do not assume these are sequential
or claim all downloaded rows become visible.

Distant reader-context tests must preserve original user-text:{messageId} key,
context anchor ID, ascending position order, before/after flags and snapshot head.
The outline endpoint offers genuine consecutive metadata pages, not invented
mid-history entries on its latest page. Test outline discovery costs separately
from a seeded reader-context restoration; do not claim seeded restoration is a
real UI distant-jump test. No direct production-store mutation for cold entry.

Pure checks (only after measurement-slot permission):
node --test scripts/testing/history/arithmetic-history.test.mjs

No tests/build/browser have run at initial creation. Before a browser trial,
obtain independent source review, run the pure contracts, build against a frozen
source snapshot, record source/helper/asset SHA256 and verify no sources changed
during build. Do not reuse mutable main as an unlabeled immutable source.

## Explicit native response contract

All sessions in this experiment remain codexNativeSession=true; ?mixed is
rejected. Response semantics follow cli/src/codex/shared/nativeHistoryIndexed.ts
(page301–318, context320–339, outline341–366), rather than the non-native Hub
messageService. In particular, after-pages expose the full native snapshot head
and their first-row nextBefore cursor; empty pages have null cursors in this
dense logical fixture; an epoch reset drops before/after but retains until.
The real indexed reader may advance empty cursors through invisible native
sources. This all-renderable deterministic corpus does not simulate those gaps.
A future non-native experiment must use a separate explicit response contract.

Rich-content runs are rejected for now: the inherited seq320 rich answer would
not produce equivalent tails for different H. HAPI_QA_BUILD is mandatory in the
config as well as the build wrapper, preventing an unqualified Vite invocation
from overwriting the baseline browser harness output.

## Portable repository use

The generator is byte-identical to the reviewed source-only experiment; the
transform reuses ../recent/fixture-transform.mjs from this repository. No
external scratch harness or production UI copy is required. Build lifecycle and
manifest utilities also come from ../recent and are included in provenance.

From repository root, using a fresh output outside source directories:
HAPI_QA_BUILD=/tmp/hapi-history-build node scripts/testing/history/build.mjs

SOURCE_ROOT may select a frozen checkout; SOURCE_HEAD identifies an exported
snapshot without .git. The output is exclusively created, builds have180s
timeouts, and only this invocation's child process group is cleaned up. Existing
output is never deleted by the wrapper. The config also requires explicit output.
Portable helper contracts passed15/15 against accepted11c5382. Portable build/browser revalidation is pending; source portability alone
is not performance certification. Browser driver/results are separate.
