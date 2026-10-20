# Windows new-session latency: breakdown and optimization

## Result and measurement boundary

The creation path is instrumented and optimized. The requested `T(native process created) + 100 ms` target is **not met**. On Lis-iMac, three baseline isolated trials reached internal HAPI readiness in 5.38–7.84 s (median 5.58 s); three optimized trials reached it in 2.30–2.99 s (median 2.60 s). A final build with the gateway shutdown fix reached readiness in 2.71 s. This is an exploratory same-device comparison, not a production percentile or a browser acceptance result.

Both builds use Bun 1.4.0, installed native Codex 0.162.0, a private empty CODEX_HOME, a private HAPI_HOME, a fresh non-Git directory, the real Hub and a test-local Runner acknowledgement server. No model input is submitted. Timing starts at `runSharedRuntime` entry; it excludes CLI import/auth/preflight, real Runner spawn admission and browser routing/rendering. The mock acknowledgement retains the actual notifier and Windows liveness-query path, but does not exercise production Runner bookkeeping or load. Production configurations with additional MCP servers have not been benchmarked here.

`native.spawned` records the return from Node's spawn call, not an independently timestamped Windows OS process-creation event. The native process is subsequently verified by its OS creation marker. Do not equate this timestamp with either native protocol readiness or exact OS creation time. The optimized interval from this spawn marker to readiness was 1.66–2.20 s (median 1.91 s), which also fails the requested 100 ms boundary.

Sanitized stage records are retained in [the profile JSON](./2026-10-09-windows-session-startup-profile.json). Raw local trial summaries are `/mnt/cache/data-cache/hapi-startup-baseline-results-20261009.json`, `hapi-startup-optimized-v5-results-20261009.json`, and `hapi-startup-optimized-v6-results-20261009.json`. Temporary raw files expire; the checked-in-format JSON omits tokens, paths, process IDs and chat content.

## Measured breakdown

These are per-stage medians across three trials. Overlapping stages cannot be added to obtain the total.

| Stage | Baseline | Optimized | Change and interpretation |
| --- | ---: | ---: | --- |
| Runtime entry to internal readiness | 5,582 ms | 2,600 ms | About 53% lower in this harness |
| Spawn marker to internal readiness | 5,216 ms | 1,911 ms | Native initialization and HAPI binding both remain inside this interval |
| Runner notifier, including process query | 2,821 ms | 6.6 ms | Replace synchronous tasklist with the existing asynchronous Win32 generation probe |
| Native materialization stage | 1,497 ms | 934 ms | Baseline includes serial Git queries; optimized Git inspection overlaps startup, leaving mostly the native metadata RPC |
| Redundant root-client resume | 228 ms | Omitted for confirmed fresh empty starts | The client issuing thread/start is already subscribed |
| Independent control subscription | 6 ms | 242 ms | Required for reconnect settings; retained even though the optimized timings are higher |

The original materialization span combined Git inspection and the native metadata RPC. It does **not** prove that Git alone took the entire 1.4–1.8 s span. After separating and overlapping Git, the native metadata RPC itself still measured roughly 0.93 s. Native thread/start measured roughly 19–31 ms in the baseline and 24–29 ms in the final three optimized trials. Fast transport or thread/start does not make the entire creation chain fast.

## Implemented changes

1. [launch.ts](../../cli/src/codex/shared/launch.ts) checks the native version asynchronously and shares an in-flight check within the process while executable metadata is unchanged. It does not persist a version result across processes or cache failures. Nine non-mutating capability probes run concurrently.
2. [runtime.ts](../../cli/src/codex/shared/runtime.ts) starts Git inspection before native initialization, runs its three queries concurrently, and overlaps fresh Hub bootstrap with native initialization. Bootstrap remains tracked so cancellation drains a late-created session instead of leaking it.
3. [sessionFactory.ts](../../cli/src/agent/sessionFactory.ts) uses the existing atomic machine-plus-session API for fresh shared Codex roots, avoiding a separate machine-registration request. Resume and other agents retain their previous paths.
4. [root.ts](../../cli/src/codex/shared/root.ts) distinguishes authoritative empty thread/start results from resume/fork. Only confirmed empty fresh nonexternal roots skip history refresh and descendant discovery; Goal display retrieval occurs after activation. Durable queue reconciliation, ownership, permissions, settings and controls still precede usable readiness.
5. [controlClient.ts](../../cli/src/runner/controlClient.ts) uses the existing asynchronous Windows generation helper before the notifier HTTP request. [frontend.ts](../../cli/src/codex/shared/frontend.ts) avoids a redundant synchronous liveness query for a compatible Runner.
6. [gateway.ts](../../cli/src/codex/shared/gateway.ts) closes admission and tracks accepted sockets through actual socket closure. Previously, a connection could leave the RPC map before its underlying socket closed, leaving shutdown waiting at server.close. The full-stack test also reproduced the primary-exit timeout against the pre-optimization source snapshot. The fix closes only sockets owned by this gateway.

The startup trace is opt-in with `HAPI_TRACE_SESSION_STARTUP=1`. [startupTrace.ts](../../cli/src/codex/shared/startupTrace.ts) emits a correlation ID, PID, monotonic elapsed/duration values, stage and outcome. It excludes RPC arguments, credentials, paths and content. Shutdown checkpoints are included to distinguish admission drain from native process cleanup.

## Necessary work retained; rejected shortcuts

The metadata write that materializes an empty native rollout remains on the critical path. The independent control observer still performs a normal thread/resume. Experimental use of excludeTurns on this nonexternal empty-resume path produced `invalid paginated history lineage` with installed Codex 0.162.0 and broke later terminal attachment, so that change was reverted. A frontend-created thread also still requires its independent root-client subscription; only the original initiating client skips a duplicate subscription.

No early success response, fake turn, fabricated completion, shared-process reuse across configuration identities, relaxed ownership check or queue-delivery change is used to meet a latency number. To pursue 100 ms, the remaining native materialization and initialization costs need a measured native-level change or an explicitly designed preinitialized execution pool. Neither is implemented or validated by this patch.

## Verification and remaining failure

With Bun 1.4.0 selected in PATH, the affected shared-runtime/bootstrap/control suites passed: **253 tests, one separately gated native-name test skipped**. This includes four installed-native integration cases and the full CLI/Runner/native TUI/mock Responses/MCP/Hub integration. That test covers fresh send/reply, independent roots, terminal attach/detach, primary exit, Runner recovery, fork, archive/reopen, settings, questions and exactly-once pending-input recovery. A further process/probe check passed **35 tests** (four overlap the first group). CLI typecheck and git diff --check passed. No real model quota was used.

Initial full-stack failures were retained during diagnosis. The secondary TUI assertion was corrected to inspect a recent user turn rather than an early turn outside the native TUI's initial history window. Plan-card assertions now explicitly request a sufficiently large history page rather than assuming the default latest page contains earlier cards. Neither correction removes the corresponding semantic assertion.

**Windows teardown is not accepted yet.** The final Windows profiling build reached readiness in 2.71 s, then returned exit 1 because the existing process-tree teardown could not prove the entire private engine tree stopped. Its shutdown.engine span took 31.17 s; ownership was retained as designed. Earlier experimental cleanup snapshots also returned scan_failed. Some intermediate trials exited 0 without the harness completion marker, so those exit codes alone are not cleanup evidence. They remain valid readiness observations only. Do not advertise these measurements as a successful Windows lifecycle or production rollout.

The profiling script now emits an explicit completed event only after runtime shutdown and its own archive request finish. Test-session Hub rows are removed only after verifying inactivity and their exact private test working directory. Process identities that cannot be matched are not signalled. The profiling runs checked that the production supervisor and main native-engine generation stayed unchanged during each batch.

No production binary, service or Codex desktop application was restarted or replaced for these measurements. This local patch has not been released.

## Earlier read-only transport reference

The preceding read-only check against the running native engine observed one connection/initialize at 65.74 ms, twenty thread/loaded/list calls at median 0.38 ms and maximum 4.95 ms, and twenty warm HTTPS health calls at median 1.24 ms and maximum 12.96 ms. These do not cover cold process creation, authenticated binding, durable writes, MCP startup or browser usability. Original reference: `/mnt/cache/build-cache/hapi-windows-admission-20261009/latency-readonly-20261009.json`.
