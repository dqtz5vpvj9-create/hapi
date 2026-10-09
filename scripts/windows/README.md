# Lis-iMac background runtime

This is the host-specific Windows deployment in `D:\hapi`, not a generic installer. Linux remains the only HAPI Hub. Native history stays in the existing user Codex store; the supervisor persists only the IDs of loaded root threads, not another copy of their messages.

## Process ownership

`HAPI-background` is a Windows Scheduled Task for `LIS-IMAC\lixinrui` using S4U logon. It has boot, logon and recurring one-minute triggers, unlimited execution time, and IgnoreNew instance policy. The recurring trigger also recovers a successful/unexpected exit that RestartOnFailure alone would miss. SSH only installs and dispatches tasks.

The task runs `task-host.ps1`. On this machine an S4U task marked Limited still receives an administrative batch token. `TaskHost.cs` therefore creates a restricted LUA token at medium integrity, with a private non-interactive window station and desktop in Session 0. It does not modify the interactive desktop ACL or UAC settings. The Codex engine, relay, Runner and bridge were checked at runtime and have no elevated token.

The launcher assigns its child to a kill-on-close Job Object before resuming it. Engine, relay and bridge wrappers also own kill-on-close jobs, so a dead wrapper cannot leave an orphan app-server behind. Runner is an exception: its job does not kill descendants, because detached agent sessions must survive Runner restarts. If its wrapper dies while Runner remains alive, the supervisor adopts the existing Runner instead of launching a duplicate. The outer task host still owns the entire backend tree; a whole-host failure interrupts managed sessions. See Microsoft's [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) and [CreateProcessAsUser](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw) contracts.

`HAPI-desktop` is a separate Interactive/Limited logon task. `launch-app.ps1` uses the current task's desktop session and the installed OpenAI.Codex package. The user environment and the `Codex + HAPI` shortcut point normal application launches at the shared background engine. Closing the official GUI does not own or stop that engine.

S4U does not supply Windows network-logon credentials or access to encrypted files ([Microsoft documentation](https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype)). Local Codex authentication-file access, HTTPS Hub access, a model response and a PowerShell terminal were tested under the restricted background token. Windows-integrated authentication to SMB shares, EFS and Credential Manager secrets are not claimed supported by those tests.

## Supervision and reconnection

- `supervise.ps1` starts engine, relay and Runner; the native bridge starts after an actual WebSocket initialize/loaded-thread RPC succeeds.
- A role exits into bounded exponential backoff, capped at 32 seconds. A persistent native protocol outage of 120 seconds restarts the owned engine and relay. A network failure toward the Hub does not itself restart the native engine.
- `NativeRpc.cs` uses the same-user named pipe and the official WebSocket JSON-RPC protocol. Health checks do not submit model turns.
- `native-loaded-roots.json` contains only previously observed root IDs. After engine recovery the supervisor checks the native non-archived index, reopens those same IDs and lets HAPI rediscover them. Deleted, archived, unpersisted and child threads are not reopened. A failed root recovery is retried independently of engine health.
- Recovery does not resend `turn/start`, `thread/queue/add`, or uncertain user messages. Native `thread/resume` may continue an active Goal according to Codex's own lifecycle. Interrupted ordinary turns are not replayed by this supervisor.
- `resolve-codex.ps1` resolves an installed desktop CLI version directory at child startup instead of pinning one update hash. An in-place official application update has not yet been exercised.

The existing named-pipe endpoint is retained:

```text
ws+unix://localhost/\./pipe/hapi-native-preview-20261004:/rpc
```

Its mixed slash is intentional: `//./pipe/` is normalized incorrectly by the URL parser. The relay uses `CurrentUserOnly` and exposes no TCP listener. HAPI's `ws-node` alias selects the npm WebSocket implementation for this Windows transport; Bun's built-in `ws` replacement failed the pipe handshake in deployment testing.

## Files and installation

- `config\connection.json`: restricted Hub URL/token; never commit or print it.
- `state\settings.json`: this machine's identity. Never replace it with another host's state.
- `state\supervisor.json`: current heartbeat, readiness and role PIDs.
- `state\native-loaded-roots.json`: recovery IDs only.
- `logs\supervisor.log`: role changes and recovery failures; rotated at 4 MiB.
- `logs\*-console.log`: current role startup/output plus the previous launch.
- `config\interactive-tasks-before-background`: original task XML for rollback.

After the runtime files and restricted connection configuration are installed, `register-background.ps1` registers/starts the background task. `persist-startup.ps1` registers the desktop task, persists the endpoint and disables the old interactive backend tasks. Existing interactive backend processes must be drained and stopped before starting the background task; registration is not a live migration command.

The five earlier prototype/interactive tasks remain disabled for rollback. Do not enable them alongside `HAPI-background`. The earlier `register-hapi.ps1` installer has been removed from this source tree because it recreated the conflicting interactive backend.

## Acceptance on 2026-10-04

Observed on the actual Windows device and production Hub:

| Scenario | Result |
|---|---|
| Background process identity | Engine, Runner and bridge in Session 0, non-elevated |
| Relay termination | Automatic recovery; original native history remained readable |
| Engine wrapper termination | Recovery observed about 14 s after fault-command completion |
| Native bridge wrapper termination | Recovery observed about 10 s |
| Runner wrapper termination | Recovery observed about 5 s |
| Runner wrapper and actual Runner termination with an existing session | Both faults preserved the session process and native ID; a subsequent model request completed |
| Supervisor termination | Task Scheduler recovery observed about 23 s |
| Original application restart through Start menu | 3/3 launches; background engine unchanged, no extra stdio engine |
| Original application native thread | Actual desktop screenshot inspected; original thread and input rendered |
| Mobile-sized production browser | Original history rendered; new Windows session, model response, reload and PowerShell terminal passed |
| Repeated task dispatch | 10 dispatches retained one supervisor and the same process ID |

Each timed fault scenario is one measured attempt, not a latency SLA. The test checked one shared listener, one Runner, one native bridge, unchanged machine/native-session identity and unchanged original history count. The application launch checks establish process topology; they do not by themselves prove every GUI screen works.

Actual logoff, cold reboot without a desktop login, login after reboot, RDP disconnect/reconnect and movement to a different desktop session still require device acceptance. Session 0 placement is an architectural prerequisite, not a substitute for those tests. The test window was requested because logoff/reboot closes unrelated desktop applications.

Temporary evidence is in `/mnt/cache/data-cache/hapi-windows-ha-20261004`; it may contain private screenshots and expires with the cache. Keep only sanitized reports in shared documentation.

The managed-session archive API timed out during test cleanup even though the session subsequently became inactive and could be deleted. This failure remains unresolved; successful backend recovery does not establish reliability of every session operation.

### Repeating the acceptance checks

The scripts in `tests/` target this installed `D:\hapi` runtime. Upload the PowerShell test helpers to `D:\hapi\scripts` and invoke them using `pwsh.exe -NoLogo -NoProfile -NonInteractive -File`. `validate.ps1` parses the deployed scripts, compiles both C# helpers and checks repeated task dispatch. `app-cycle.ps1` must run as an Interactive Scheduled Task in the intended desktop session.

For the Node tests, set `HAPI_API_URL`, `CLI_API_TOKEN`, `HAPI_WINDOWS_MACHINE_ID`, `HAPI_WINDOWS_SESSION_ID` and `HAPI_ACCEPTANCE_DIR`; `HAPI_WINDOWS_SSH` defaults to `Lis-iMac`. Keep credentials outside shell history and logs. `fault-matrix.mjs` terminates production backend roles and should run only in an agreed test window with no unrelated active turns. `runner-survival.mjs` creates a temporary session and makes one standard-tier model request after two Runner faults. Its report records the created session ID, which must be archived and deleted after inspection. These are device integration tests, not an unattended production health check.

## Recovery and limits

Inspect the two tasks, supervisor heartbeat, role logs and native RPC before declaring the device healthy. A running task alone is insufficient. To stop the backend intentionally, disable `HAPI-background` before stopping it, otherwise its recurring trigger brings it back. Wait for the owned process tree to exit before restarting or rolling back.

Power loss/reboot terminates in-flight processes. The intended contract is automatic service recovery with preserved native identities/history and no supervisor-generated duplicate submissions, not uninterrupted computation while Windows is down. Full reboot/logoff acceptance remains pending.

### Before a Hub restart

Run `tests/hub-connectivity.ps1` in the Runner's account and session context. It checks fresh DNS resolution, HTTPS without a proxy, and a direct WebSocket handshake; its JSON records the caller identity and failing stage. Do not use a successful browser or proxy-enabled request as a substitute. After a restart, verify that the same machine ID registers and native history remains available. See the [reconnect incident and release checks](../../docs/operations/2026-10-05-hub-reconnect.md).

### Native discovery repair, 2026-10-05

The Windows native bridge now uses `bin\hapi-native-20261005.exe`; the Runner continues using `bin\hapi-20261004.exe`. Both come from the existing Windows build snapshot, with the native bridge receiving only the `nativeDiscovery.ts` / `runtime.ts` pre-resume check already applied to Linux. A loaded thread without a rollout must fail before publishing or reactivating a HAPI session. Otherwise every five-second discovery retry inserts an empty row and shifts the live list. Updating only the Linux bridge leaves Windows affected.

The bridge wrapper alone was restarted by its supervisor; engine, pipe and Runner wrapper PIDs were preserved. The previous launcher is retained under `config\start-hapi-before-native-20261005.ps1`. Restore its native executable selection to roll back, without restarting the engine or Runner.

Use the validated **Bun 1.4.0** toolchain for the Windows build. A 1.3.13 build of the same bridge source failed to open the named pipe despite a successful build and `--version`; that candidate was rolled back. The 1.4.0 transport smoke passed on the device. On this build host the validated toolchain is `/mnt/cache/build-cache/hapi-upstream-toolchain/bun`; put `TMPDIR` and `BUN_INSTALL_CACHE_DIR` on the cache disk.

Before changing the running native launcher, compile `cli/scripts/windows-native-transport-smoke.ts` with the **same toolchain** as the candidate executable and run it against the existing local relay. It checks handshake, Codex initialization and reconnect without submitting a model turn. A successful Hub WebSocket check does not test this named-pipe transport. Keep the old binary and launcher available until an original Windows session's authenticated history read also passes through the new bridge.
