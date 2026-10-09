# Warm workspace switching

The user reported a skeleton screen when alternating between two workspaces.
Earlier acceptance checked the eventual restored message, draft and reading
position. That was insufficient for a tmux-style workspace: the first frame of
an already opened workspace must also contain its existing content and editor.

## Cause and scope

`WorkspaceSurface` previously rendered one FlexLayout instance whose model was
replaced on every workspace activation. Changing workspace therefore unmounted
its pane controllers, chat reader and editor. Message caches saved downloads but
did not preserve these view instances. Returning repeated the initial chat
presentation gate, layout measurement and editor initialization.

A read-only measurement of the user's two existing workspaces did not reproduce
an extended warm skeleton in that sample. Warm first-frame times were roughly
84–230 ms; the cold second workspace took 359 ms and included skeleton frames.
Holding message responses for three seconds did not make those sampled warm
returns wait for the network. These observations establish unnecessary view
reconstruction, not that all instances of the user's symptom had one cause.

The revised surface retains the current and previous workspace. Each has a
stable, keyed layout and pane tree. The inactive stage retains its measured
geometry but is hidden, inert and excluded from accessibility navigation. It
cannot receive focus or mark a conversation read. Returning shows its existing
DOM, then refreshes messages asynchronously. Visiting a third workspace evicts
the least recently used view; its draft and semantic bookmark remain in the
existing stores. This is a two-workspace warm set, not a claim of instantaneous
access to every workspace or a fixed bound on total browser memory.

A first retained-view implementation still re-rendered FlexLayout during every
switch. A Chromium CPU profile attributed about 578 ms across ten switches to
forced geometry reads under `syncLayoutMetrics`. Layout props and the App
context are now stable across a visibility-only switch; foreground ownership
updates pane consumers without re-rendering the layout library. Stage layout,
style and paint are contained. Structural changes and real resizes still update
the layout normally.

Only the outgoing active workspace captures reading positions. A hidden reader
must not use document hit-testing to sample the foreground conversation; its
teardown keeps the bookmark captured before it was hidden. Native and legacy
reader reload capture also skip hidden stages.

## Verification

The first revised production-fixture run alternated two workspaces with
1,500-line code answers twelve times while all history requests were held.
Every sampled first frame contained the conversation with zero skeleton/blank
frames. The scrollport, composer and CodeMirror editor retained DOM identity,
and both drafts survived. First-frame times were 48–120 ms in that run.
Timing ends at the first requestAnimationFrame callback where the target view is ready; it is not a measurement of when pixels reach a physical display. This is a local Chromium measurement, not a physical-device guarantee.

The earlier retained-only builds failed the 150 ms target: a development run
reached 1.4 s; a production run failed at 228 ms. Those failures are retained in
the cache-disk artifacts rather than counted as acceptance.

The complete production-fixture suite passed 40 browser flows: native and legacy
history pagination, reading restoration, split/zoom/drag, mobile projection,
workspace movement/close/undo, send failure recovery, attachments completing
while hidden, and Goal controls. Twelve-workspace eviction still releases the
old reader DOM and restores its code bookmark. The warm test in that run took
42–66 ms. Web typecheck passed.

The composer identity assertion was then tightened to include
`contenteditable="plaintext-only"` and reject missing elements. The first
re-run retained all three DOM identities and showed no blank/skeleton frames,
but one sample took 151 ms, exceeding the 150 ms timing gate while a screenshot
browser was also running. That run is recorded as failed, not rounded to pass.

The production-fixture assets were also loaded against the real HTTPS Hub in an
isolated browser, without changing served assets. Both existing user workspaces
were warmed, then visited twelve times with message GETs delayed three seconds.
All first frames had their content, original readers and original editable
composers; times were 49–116 ms. No JavaScript errors, sends or workspace writes
occurred. This checks actual Linux/Windows conversations in a desktop Chromium
browser; it is not a physical Windows Chrome or phone measurement.

A further sequential run retained the same DOM and first-frame content but
recorded 66–303 ms. Thus the stable 150 ms latency target remains **unmet**. The
functional regression now gates first-frame content, non-null DOM identity,
drafts and bounded view retention while reporting wall time as benchmark data;
it does not use a host-dependent latency threshold as a functional pass. This
change is not evidence that the latency target passed. Further profiling found
that the former forced layout-measurement hotspot was removed, but timing tails
remain unattributed.

The tightened functional test passed, including non-null composer identity and
the subsequent third/fourth-workspace eviction check. Eighty focused web tests
passed. The 29 history/dependency/lineage/search integration checks passed; two
history-reader cases had previously timed out during a concurrent build, then
the unchanged suite passed in a separate run with the original five-second
limit. Relay's 118 checks also passed. These runs used Bun 1.4.0. Fixture
generation produced no tracked changes. No full-suite rerun is claimed for this
frontend revision.

## Release

Published at 2026-10-06 04:38 PDT. The HTTPS application serves
`/assets/index-CY-dG4_Q.js`. The production-only build is
`/mnt/cache/build-cache/hapi-workspace-warm-20261006/web`; rollback root files are
in the adjacent `previous-web` directory. Old hashed assets remain available.
Hub/native service PIDs were 3233230/2502589 immediately before and after
publication. This release did not restart either service or any native Agent.
No commit or push was made.

An isolated browser then loaded the actual served entry, without substituting
candidate assets. Twelve return switches across the user's two workspaces,
with all message GETs delayed three seconds, took 24–75 ms in that run. Every
first frame retained its content, original reader and original editable input;
there were no skeletons, JavaScript errors, sends or workspace writes.

A separate phone-sized check against the served version verified browser Back,
list refresh, cancelling session selection, selecting an already open session,
workspace/pane location labels and preservation of the two-pane desktop layout.
Real conversation reading survived reload within two CSS pixels. These are
browser checks, not physical-phone acceptance. The desktop and narrow-screen
fixture screenshots were captured with webshot and visually inspected.

The low-latency target remains distinct from the skeleton fix. The slower
long-code runs above remain valid negative evidence; this release does not
establish tmux-equivalent latency for every machine, load or workspace.

Artifacts: `/mnt/cache/data-cache/hapi-tmux-implementation/warm-*`.

The separately developed scoped-message SSE transport is not being activated by
this frontend release. App wiring continues to use the production Hub's global
workspace stream. Its deferred activation delta is saved at
`/mnt/cache/data-cache/hapi-tmux-implementation/scoped-sse-app-deferred.patch`;
Hub/helper protocol work remains in the working tree. Enabling it later needs
its own transport acceptance and backend release gates. No backend restart is
required for warm views.
