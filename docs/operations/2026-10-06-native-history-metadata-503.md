# Native history metadata 503 — 2026-10-06

The reported desktop workspace showed empty HAPI Tmux and disk-cleanup panes
with `Native Codex history metadata is unavailable or not yet synchronized`.
Authenticated repeated reads reproduced 503 for both sessions while HAPI Main
continued returning history. This was a backend history failure.

## Causes and changes

1. Codex can normalize an open turn to `interrupted` when the thread is no
   longer active. It does not persist a completion timestamp or rollout end
   ordinal for that normalization. Its read API and sparse SQLite index then
   legitimately report different statuses. HAPI required equality and rejected
   the whole page indefinitely. The disk-cleanup session demonstrated exactly
   this state: API `interrupted`, index `inProgress`, both completion times null,
   and no end ordinal. The installed source behavior is
   `normalize_thread_turns_status` in Codex
   `codex-rs/app-server/src/request_processors/thread_processor.rs`
   (local source revision `e7bffc5a2`).

   `NativeIndexedHistory.synchronize` now recognizes that precise case.
   `NativeHistoryMetadata.turn` applies the bounded API status overlay to
   returned execution metadata without inventing a completion, interruption
   event, or index row. Other status/time mismatches still fail synchronization.

2. Ordinary native notifications incremented the same revision used to reject
   reads invalidated by rollback. A live append could therefore invalidate an
   otherwise coherent read transaction. Production logs contained failures at
   this post-read check; Tmux also recovered intermittently before deployment.

   Structural resets now have their own revision. Appends allow the coherent
   prefix captured by the SQLite transaction to finish; body identities are
   still checked against bounded official RPC results. Notifications received
   during synchronization keep the next read dirty. Rollback/retraction still
   revokes the in-flight result and its coordinates.

The change adds no transcript store, index writes, full-history scan, or model
request. Existing replacement/fork cutoffs, terminal-notification synchronization,
and bounded item RPCs remain in use. It does not make genuinely inconsistent
native metadata readable by suppressing every error.

## Verification

- Four new regression cases cover stale-turn normalization (warm, cold and
  context reads), append arrival during metadata/body RPCs, and structural reset
  during a body RPC. No fake `Aborted by user` record is emitted for an open turn
  that only received read-time normalization.
- The new cases, indexed lifecycle tests and durable stop tests passed: 26 tests.
- Dependency history, root behavior, asynchronous questions and interruption
  projection passed: 54 tests.
- The existing legacy-history suite passed its 11 functional checks with a
  one-off 20-second test timeout. Its large eviction tests exceeded their normal
  5-second deadline on this host, including a single-worker rerun. No test source
  or default deadline was changed. This is not a performance pass.
- Both the working CLI and isolated release snapshot passed typechecking.
- Read-only calls through the real native socket returned 20 messages from
  each reported session using the patched reader before deployment.

Private diagnostic files are in
`/mnt/cache/data-cache/hapi-metadata-503-20261006`. They contain bounded reads,
test logs and release checks and are subject to the cache retention policy.

## Production release and recovery

The Linux native bridge was updated on 2026-10-06 at 11:17:54 UTC using Bun
1.4.0. The executable and isolated source are under
`/mnt/cache/build-cache/hapi-metadata-503-20261006`. The build manifest records
the unfinished TerminalHost CLI registrations and capability advertisement
excluded from this release. Concurrent working-tree files were preserved.

Only `hapi-native.service` was restarted: PID 3233231 became 2502589. Hub PID
3233230 and the existing native Codex socket owner PID 2259627 remained unchanged.
No Hub, Web, Runner or Windows version was replaced.

Readiness checks caught a separate recovery limitation: discovery reattaches
only threads in `thread/loaded/list`. Some previously bound, idle sessions were
not loaded in the engine, so their history handlers did not automatically
return. During startup, probes correctly failed with `RPC handler not registered`;
machine-online and process-active states were not treated as readiness.

The disk-cleanup session was reattached through the existing authenticated
`hapi/connectThread` operation, asserting the original HAPI and native IDs.
The same comparison found 14 other missing bindings owned by the old bridge,
still marked running rather than archived. They were reattached with the same
identity check. All 30 previous bindings are present in the new bridge. No
messages were submitted or replayed by the recovery scripts. This manual
reattachment does not establish automatic recovery of unloaded bindings;
future bridge releases must capture previous bindings and verify their history
handlers, including idle sessions, before declaring recovery complete.

Authenticated HTTPS checks returned successful repeated history pages for
Tmux, disk-cleanup, HAPI Main and an existing Windows session. Older-page reads
also checked for duplicates. Both machine IDs remained online.
After recovery, a separate read of all 30 previous Linux bindings returned
HTTP 200 for every session, rather than relying on registration alone.

The final read-only Chromium run opened and reloaded the two reported sessions
at 1600px and 390px widths, then opened the current shared workspace at each
width. Its 28 history responses had no HTTP failures and it recorded no page
script errors. The current workspace had two desktop chat panes and one visible
mobile pane. It was read without changing its saved layout. These are desktop
browser viewport checks, not a new phone-device run.

A previous post-release browser attempt timed out waiting for first presentation
despite successful API probes. The later passing run does not explain that
intermittent timeout; its failed log is retained separately. The initial
workspace probe also required correction to wait for the expected chat-pane
count instead of accepting zero panes during initialization.

`workspace-restored.png` was captured using webshot through a temporary
loopback-only read-only proxy and visually inspected: both current panes show
their conversation bodies. Direct HTTPS browser checks were performed separately.

## Rollback

The prior native systemd override is saved as `previous-native.conf` in the
private diagnostic directory. Restoring it, reloading systemd and restarting
only the native bridge returns to the prior executable. Repeat binding/identity
and authenticated history readiness checks after any restart. No database
migration, history rewrite or frontend rollback is needed for this change.
