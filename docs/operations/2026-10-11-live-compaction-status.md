# Live native Codex compaction status

## Failure and cause

During native context compaction, HAPI could display only “thinking” and “Confirming delivery…” for several minutes. The completed transcript marker did not explain the live operation.

Codex emits `item/started` for a `contextCompaction` item before requesting the summary, then emits `item/completed`. See [the native compaction implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact.rs). HAPI's event converter only produced transcript markers on completion. External native history uses a different presentation path, so a start-only transcript marker would not fix both paths.

Two other layers could delay a newly added phase: the CLI used volatile heartbeats whenever the thinking boolean stayed unchanged, and the Hub did not immediately broadcast a compaction transition within the same active turn.

## Change

`NativeRuntimeStateTracker` records live compaction by turn and item identity. `SharedCodexRoot` observes it synchronously on the owning transport, before serialized history and queue work. Child thread events cannot change the root's phase. Live status remains separate from historical compaction markers.

The existing versioned execution snapshot carries optional `compacting`. CLI phase transitions use reliable Socket.IO emission. The Hub broadcasts changes immediately through its existing versioned SSE updates. Normal heartbeat throttling stays in place.

The transcript tail, composer status, workspace activity and session row display “Compacting context…”. A pending delivery shows “Confirming delivery · Codex is compacting context”. Completion, turn failure/interruption, unloading and transport loss clear the phase. Stale execution updates cannot restore it.

Queue acceptance is unchanged. Compaction events neither consume messages nor retry them. Only existing native acceptance evidence settles delivery. The change makes the wait understandable; it does not shorten Codex's compaction operation.

## Verification

- CLI lifecycle tests cover item identity, duplicate/late events, completion, interruption, failure, unloading, disconnect and history refresh.
- Root tests block `thread/queue/list` and verify immediate start/end publication in both owned-engine and external-engine modes, including child-event isolation.
- API transport tests discard volatile emissions and verify both phase transitions still arrive.
- Hub tests verify start/end broadcast inside the ordinary heartbeat throttle and reject an older phase packet.
- Web tests preserve pending delivery until genuine acceptance.
- Chromium playback at 1440 px and 390 px checks the native presentation, workspace status, queued-message explanation, stale packet rejection and eventual acceptance. Linux/Windows owner labels are synthetic; this is not real Windows or phone acceptance.

Complete typechecking passed for CLI, Hub, Web and relay. CLI and Hub full suites passed. The first full Web run had four Recent-list timeouts under concurrent test/typecheck/browser load; that file passed separately. The full Web rerun with two workers passed all 380 files (4,014 tests; one skipped), including those four cases. Shared, relay, history reader/dependencies, lineage, search and browser-harness suites passed. Fixture regeneration produced no changes.

Evidence: `/mnt/cache/data-cache/hapi-compaction-20261011/`. This temporary directory expires automatically; repository tests retain the regression coverage.

## Release boundary

Source verification does not mean the running services emit this field. CLI/owning native bridge, Hub and Web must all use the change. Updating only the frontend cannot expose a start event the old bridge never publishes.

The running Codex engines and user sessions were not restarted during this work. Deployment and real-device acceptance remain separate from the replay results. Reconnecting a bridge after it missed a start event cannot reliably infer an ongoing phase from completed history; the implementation does not guess from old markers.
