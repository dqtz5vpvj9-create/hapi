# Windows HAPI memory profile — 2026-10-11 UTC

The complaint is supported by current measurements. The HAPI service core alone has a median **404.7 MiB working set and 1,280.2 MiB private commit**. Its console/process-marker helpers add **25.1 MiB / 11.0 MiB**. A separate existing HAPI session and its stdio MCP bridge add another **49.0 MiB / 548.6 MiB**. Codex and its tools are additional costs, rather than part of that service-core total.

Two causes are established: six resident PowerShell hosts have a substantial fixed cost; restoring a saved thread with `thread/resume` starts configured MCP processes even when no model input or tool call is submitted. Merely reading saved history does not require that execution allocation. An isolated production HAPI stdio MCP bridge alone commits approximately **265 MiB** before any tool invocation.

## Measurement boundary

Measured the deployed Lis-iMac installation, not the pending source startup optimizations. Runner uses `hapi-20261004.exe`, native bridge uses `hapi-admission-20261009.exe`, and the installed native engine reports `codex-cli 0.162.0-alpha.2`.

Four live samples span **01:29:00–01:30:03 UTC**. Rows below are medians of each sample's group sum. Windows `WorkingSet64`, `PrivateMemorySize64`, and the separate performance-counter private working set were collected. Private commit is not physical resident RAM; summed working sets also count shared pages more than once. Low working sets under memory pressure do not eliminate a process's committed-memory cost. This profile does not establish a heap leak or identify the internal allocator responsible for each committed page.

The original reported 335 MiB / 1.17 GiB was not measured under an identical workload, so the difference must not be called a controlled version regression. Later read-only native probing counted 17 loaded threads; the supervisor's initial saved-root list contained 16 IDs. These are distinct counters.

The sampler, SSH shells, official Codex desktop UI, unrelated PowerShell chains, and Java/Gradle/ADB user work were excluded. The latter have shared-engine ancestry but are task workloads, not HAPI's idle overhead. No production process was explicitly stopped or restarted. The existing relay automatically changed PID during observation; core supervisor, engine, native bridge, Runner, and the separate existing session retained their process generations. Thus unchanged state is not claimed for every role.

## Live breakdown

| Component | Processes | Working set, MiB | Private commit, MiB | Private working set, MiB |
|---|---:|---:|---:|---:|
| Task host, supervisor, four role PowerShell hosts | 6 | 178.6 | 368.5 | 78.9 |
| HAPI Runner and native bridge binaries | 2 | 226.1 | 911.7 | 185.5 |
| Core console/process-marker helpers | 10 | 25.1 | 11.0 | 4.2 |
| Separate existing HAPI session and HAPI stdio MCP bridge | 2 | 49.0 | 548.6 | 40.4 |
| Shared native Codex engine | 1 | 406.2 | 1,007.7 | 346.5 |
| Separate session's native Codex engine | 1 | 31.9 | 78.7 | 19.0 |
| Shared engine's Node MCP entrypoints | 34 | 125.0 | 1,305.6 | 53.5 |
| Shared engine's CUA/REPL/code-mode processes, including descendants | 52 | 566.5 | 483.8 | 99.7 |

This table excludes the separate engine's other tools and consoles beneath tool processes; it is a component breakdown, not a complete machine/process-tree total. The last row includes 17 CUA Node processes, 34 REPL processes, and one code-mode host. Their presence does not prove they were never used, or that they can be safely shared between threads.

The 34 MCP entrypoints are 17 `WeFlow-MCP/launch.mjs` processes and 17 `./mcp/server.bundle.mjs` processes. The latter's owning server name was not established. Many launched in pairs within seven seconds of the earlier engine startup, while later pairs have newer creation times. That supports per-thread execution initialization as the scaling mechanism; it does not prove every individual thread was restored by the supervisor rather than opened by a user.

### PowerShell cost by role

| Resident host | Working set, MiB | Private commit, MiB |
|---|---:|---:|
| Task Scheduler/token/job host | 6.6 | 79.5 |
| Supervisor | 51.4 | 90.0 |
| Engine launcher | 12.3 | 43.3 |
| Native bridge launcher | 6.7 | 40.5 |
| Runner launcher | 36.5 | 36.0 |
| Pipe relay host | 64.5 | 79.1 |

Calling another `.ps1` with `&` does not itself create a new PowerShell process. The deployed topology is **task host → supervisor → four role hosts**; the pipe role executes its relay inside that role's host. Six hosts were counted by process identity, not by the number of script files.

## Controlled history-only experiment

Used a separate, unique `CODEX_HOME` below `D:\hapi\temp`, a synthetic saved transcript, the installed native binary, and local MCP fixtures. The configured model endpoint was `127.0.0.1:1`; no `turn/start` or `tools/call` was issued, and no Hub registration was performed. This is a native API allocation experiment, not an end-to-end production UI benchmark. The fresh private home also triggered native plugin-bootstrap Git activity. Native-engine stage deltas are therefore not attributed exclusively to MCP initialization; directly measured MCP process costs and their recorded startup events remain the causal comparison.

| Stage | Native engine private commit, MiB | Fixture tool processes | Tool invocations |
|---|---:|---:|---:|
| Initialize, no thread | 17.8 | 0 | 0 |
| `thread/read`, `includeTurns:false`, saved synthetic history | 18.5 | 0 | 0 |
| `thread/resume`, `excludeTurns:true`, same history | 25.1 | 2 | 0 |

Both Node fixtures received `initialize`, `notifications/initialized`, and `tools/list`. Together they committed approximately **39.6 MiB**, with about **107.5 MiB summed working set**. The MCP process cost, rather than model generation or a tool invocation, is therefore directly observed. `excludeTurns:true` reduces returned history; it does not mean “history-only execution with tools disabled.”

A second controlled run configured one Node fixture and the **deployed `hapi-20261004.exe mcp` bridge**, pointing at an unused loopback HTTP endpoint. The bridge had **264.7 MiB private commit / 124.0 MiB working set** after resume, without a tool invocation. Six seconds after `thread/unsubscribe`, it still had **264.7 MiB / 123.3 MiB**. This short observation proves that unsubscribe did not promptly reclaim these processes in this test; it does not establish permanent retention or a leak. Closing the isolated native server ended the test tools; final process checks confirmed no recorded test process remained active, and all five private trial directories were removed. The checks are in the evidence JSON.

Two preliminary test limitations are preserved in the evidence rather than hidden: an empty `thread/start` with no turn did not persist a resumable rollout, and this installed alpha binary rejected `thread/read(includeTurns:true)` with `list_turns is not supported yet`. The successful cold comparison uses an explicitly saved synthetic rollout and metadata reads. It establishes tool-allocation behavior, not full-turn API support or large-history UI memory use.

## Causal paths and next changes

1. **Separate history availability from execution restoration.** The deployed supervisor restores previously loaded roots with `thread/resume(...excludeTurns:true)`. Current HAPI native connection code also resumes a saved thread when opening it. Reuse the existing native history reader and register history access without resuming an idle thread; attach immediately when the native thread is already live, and resume a cold thread when the user actually starts or continues execution. Preserve thread/HAPI identity and queued-input confirmation. Recovery of genuinely running or pending work must remain distinct from reopening idle history. This addresses a cost that grows with loaded threads.
2. **Remove the full CLI process from the small HAPI MCP forwarding path.** `buildHapiMcpBridge` already starts an in-process Streamable HTTP MCP endpoint, then configures an additional stdio process to forward to it. The latter is the measured approximately 265 MiB fixed allocation. Test native Codex connecting directly to the existing HTTP endpoint, preserving tool exposure, session isolation, approval behavior, and endpoint lifetime. The protocol support and actual memory saving must be verified before release; they are not claimed as implemented here.
3. **Reduce resident shell launchers while keeping the Windows lifecycle guarantees.** Launch native roles directly under the existing restricted token and owned jobs, and host the relay without a resident PowerShell runtime where possible. Replacing the token/job host requires an equivalent implementation, not removal of the privilege or ownership boundary. The current 368.5 MiB is the total observed shell-host budget, not an assured saving: replacement processes also cost memory.

Avoid globally disabling user MCPs or unloading a user's live tools to improve a screenshot of memory usage. Do not infer an achievable target from working-set trimming. Acceptance should compare equal workloads: service only; many history panes with zero turns; one active thread; repeated resume/close; existing Linux/Windows execution; reconnect and restart recovery. Track process counts, private commit and private working set over time. A history-pane-only test should allocate zero execution MCP processes, while first execution must still initialize the configured tools correctly.

## Evidence and reproduction

- [Sanitized measurements, process identities, samples and successful/negative experiments](./2026-10-11-windows-memory-profile.json).
- [Read-only live sampler](./windows-memory-profile-20261011/profile.ps1).
- [Isolated history/production-bridge experiment](./windows-memory-profile-20261011/history-profile.py) and [Node MCP fixture](./windows-memory-profile-20261011/mcp-fixture.mjs).
- Deployed snapshots: [task host](./windows-memory-profile-20261011/deployed-task-host.ps1), [supervisor](./windows-memory-profile-20261011/deployed-supervise.ps1), [role launcher](./windows-memory-profile-20261011/deployed-start-role.ps1). These are frozen evidence, not replacement installation scripts.
- Current source paths: [native connect/resume](../../cli/src/codex/shared/runtime.ts), [bridge construction](../../cli/src/codex/utils/buildHapiMcpBridge.ts), [in-process MCP server](../../cli/src/claude/utils/startHappyServer.ts), [stdio forwarder](../../cli/src/codex/happyMcpStdioBridge.ts), [token and job ownership](../../scripts/windows/TaskHost.cs).

The scripts are machine/version-specific reproductions. The history script expects the fixture uploaded as `D:\hapi\temp\memory-mcp-fixture-20261011.mjs`, and pins the installed native binary's path. It creates a new private trial directory each run; never point it at the user's real `CODEX_HOME`. Run Python via `C:/Python311/python.exe <uploaded-script>` and PowerShell via `pwsh.exe -NoLogo -NoProfile -NonInteractive -File <uploaded-script>`. The raw captures stayed on the temporary cache; retained evidence excludes raw command lines, tokens, environment values, and actual conversation bodies. No application change, commit, push or deployment was performed for this profiling task.
