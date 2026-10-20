# Windows Codex session creation timeout

## Observed failure

On Lis-iMac, the 2026-10-10 09:37:59 local-time creation request started a HAPI child, but the child reported `ELOCKED` on `.codex/hapi-runtime-owners/ownership` at 09:38:28. The Runner timed out the child at 09:39:19 and briefly disconnected from the Hub. Its process and supervisor did not crash. The generic web error obscured this distinction.

Native discovery repeatedly tries loaded child threads and unavailable roots. Ownership checks called synchronous `tasklist` and PowerShell/CIM process-generation probes while holding the store-wide lock. Concurrent creation could exhaust the lock's retry budget. The same synchronous probes in Runner startup recovery and its periodic health check blocked its event loop, including WebSocket heartbeats and the local `/session-started` acknowledgement. Increasing request or lock timeouts would leave these causes intact.

## Fix

- Ownership admission filters unrelated records before checking processes, then uses the existing asynchronous Windows handle helper in one batch. The store-wide lock still protects reservations; live orphan, pending-creation, unreadable-record, and PID-reuse checks remain enforced.
- Runtime and child startup use the same asynchronous process-generation helper.
- Runner startup recovery and periodic pruning query child generations in a batch. A failed OS query retains quarantine/tracking rather than treating children as dead. Its control sockets and heartbeats remain responsive.
- No ownership records or native history were deleted to bypass the failure. No model request or message replay is needed for acceptance.

## Deployment

Built from the local `1beac515` source plus this fix using Bun 1.4.0. Native bridge: `D:\hapi\bin\hapi-admission-20261009.exe`. Runner: the final `hapi-admission-v3-20261009.exe` build installed at the stable `D:\hapi\bin\hapi-20261004.exe` path. The stable path preserves the supervisor's existing Runner-adoption check. The filename alone does not identify the installed source revision.

Only HAPI role processes were updated. Runner used its documented `/stop` control endpoint; detached session processes survived. The native bridge wrapper was replaced separately from the independently supervised Codex engine and relay. During the role update and creation acceptance, shared engine PID 865668, engine wrapper 1464068, relay wrapper 1187144 and supervisor 208924 remained unchanged. A later independent supervisor failure is described below. No whole-backend, desktop application, or engine restart was issued.

The launcher backup is `config\start-hapi-before-admission-20261009.ps1`. Original Runner executable is `bin\hapi-before-admission-20261009.exe`; intermediate Runner builds have separate rollback filenames. Rollback must replace only these HAPI roles, preserving engine ownership and live sessions.

## Verification

Focused CLI tests cover asynchronous ownership admission, irrelevant-record filtering, orphan/pending-creation protection, PID reuse, inaccessible Windows processes, native discovery, process helpers, control and shared-session stop behavior. CLI typecheck passed. Four isolated installed-Codex integration tests passed against a mock Responses API, with no production model calls.

The first candidate fixed the ownership-lock error but still failed the second real Windows creation because periodic Runner pruning remained synchronous. This failure was retained and led to the heartbeat correction; one successful creation was not accepted as sufficient evidence.

The second candidate created four empty Windows sessions across the periodic check: 29.117, 10.631, 10.679 and 10.511 seconds end to end. All four returned distinct native identities and active sessions. A 250 ms Hub availability sampler recorded no offline observations or request failures. Existing Windows histories returned ten messages each in 103 ms and 32 ms. The first request overlapped slow startup recovery; the final candidate additionally removes that synchronous recovery path.

The final candidate created two empty sessions in 14.211 and 10.817 seconds with zero offline observations or polling failures. After individually closing the acceptance roots and deleting their eight HAPI test rows, existing histories still returned ten messages each in 76 ms and 32 ms. Final results and cleanup are recorded in `/mnt/cache/build-cache/hapi-windows-admission-20261009/DEPLOYMENT.md`. Creation still starts a native engine and configured MCP services; these tests do not establish a 100 ms creation SLA. A successful history read does not establish desktop GUI, logoff or reboot acceptance.


## Later supervisor failure and remaining rollout boundary

At 2026-10-10 10:12:57 local time the supervisor logged `Access to the path is denied.` and exited. Its scheduled task relaunched the complete backend at 10:13:34 and restored recorded native roots. The old trap omitted source position, so the exact failing statement is unknown. The status-file publication outside the loop's recoverable block is a confirmed fatal path: a Windows reader denying delete sharing reproduces the same exception during replacement, which previously unwound supervision and disposed owned engine roles.

The source now catches IO/access failures only for observational `supervisor.json` publication and retries on the next normal loop; other failures retain their existing handling. Fatal diagnostics now include source position and script stack. `scripts/windows/tests/supervisor-status.ps1` verifies a real deny-delete reader lock, continued execution and successful publication after releasing the reader. This test passed on Lis-iMac. The updated supervisor script is installed on disk, with backup `config/supervise-before-status-fix-20261009.ps1`, but the currently running supervisor has not been restarted to load it. This is a pending activation, not a completed live fix. No forced full-backend restart was issued to apply it.

After automatic recovery, the same Windows machine was online and the two original session histories returned ten messages each in 109 ms and 42 ms. All acceptance process generations were gone; reused PIDs were excluded by their start times. These later results supersede any assumption that the original shared engine stayed alive through the entire investigation.


## Follow-up causal audit

Three independent failure boundaries were reviewed:

| Boundary | Confirmed mechanism | Prevention and verification | Current evidence gap |
|---|---|---|---|
| Session admission | Synchronous process-generation probes held the store lock and blocked Runner callbacks/heartbeats | Async generation queries; relevant-owner filtering; batched recovery/pruning; preserved orphan/PID-generation checks; focused tests and six consecutive v2/v3 real creates | Fresh engine/MCP startup remains 10–14 seconds; legacy stop/late-webhook paths still contain synchronous queries and were not refactored or accepted as globally nonblocking |
| Supervisor status/log publication | IO/access exceptions escaped supervision; cleanup and kill-on-close jobs amplified an auxiliary IO failure into an engine/backend shutdown | Catch only IO/access errors for observational status and event writes, retry at the existing loop cadence, add source position and stack to real fatal diagnostics | The old incident log does not identify its failing statement or lock holder; reproducing this path is not proof of that exact historical trigger |
| Loaded-root checkpoint | Snapshot IO failure shared the native protocol catch, incorrectly changing native health and potentially restarting the engine after 120 seconds | Separate checkpoint publication from RPC health; preserve current roots in memory and retry checkpoint on next probe | New supervisor logic is installed on disk only; existing process was deliberately not restarted |

The Windows regression test now holds real deny-delete/read-share file handles against status, checkpoint and event files. It verifies continued execution, unchanged native health under checkpoint contention, retained in-memory roots, and successful status/event writes after releasing the handles. The test passed on Lis-iMac. It never starts or stops production Codex. During file installation the supervisor PID and all observed Codex process generations were verified unchanged.

This is a prevention patch for the reproduced mechanisms, not a guarantee that arbitrary future failures cannot occur. Full closure still requires activation of the supervisor fix through a lifecycle transition that does not interrupt user work, followed by production acceptance. Do not treat files copied to disk, unit tests, or automatic recovery as proof that this activation occurred.
