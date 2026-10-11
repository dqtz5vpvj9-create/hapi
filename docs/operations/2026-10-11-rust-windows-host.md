# Rust Windows host candidate — 2026-10-11 UTC

This is the retained pre-deployment candidate report. See the [production adoption and measured savings](./2026-10-11-rust-host-production.md) for the subsequent deployment, including its cold-recovery limitation.

Implemented the Windows resident infrastructure in
[`native/windows-host`](../../native/windows-host/README.md). The candidate uses
two native processes in place of six PowerShell hosts: an S4U token/job
bootstrap and a restricted supervisor containing the relay/protocol probe.
Runner, the HAPI native bridge and Codex remain separate existing executables.
The production task/action and all production launchers remain unchanged.

## Observed memory

The isolated S4U test took four samples after 32 concurrent client connections,
protocol/restoration and fault checks. Both hosts together consistently reported:

| Boundary | Working set | Private commit |
|---|---:|---:|
| Rust bootstrap + supervisor | 15.12 MiB | 3.47 MiB |
| Earlier six production PowerShell hosts | 178.6 MiB | 368.5 MiB |

The second row comes from the separate [production memory
profile](./2026-10-11-windows-memory-profile.md). These are different workloads,
not a controlled net-saving measurement. The candidate's child processes were
synthetic fixtures, not the user's running Codex/tools. Do not subtract the rows
and call the result a verified production saving, or use the candidate host
numbers as the total HAPI footprint. Private commit is not resident RAM, and
summed working sets count shared pages more than once.

The Windows GNU release executable is 1,272,832 bytes. Its PE imports use
Windows system/UCRT libraries; the CLR directory is empty and no .NET, Bun,
Node or Java VM is embedded. Tokio supplies native async I/O scheduling.
Observed OS thread counts were three for the bootstrap and four for the
supervisor; a single-thread async executor does not mean the Windows process
contains exactly one OS thread.

## Device acceptance

The final isolated run completed at **2026-10-11T02:56:02.8284610Z**. Its uniquely
named S4U task used a private temporary directory, pipe, AF_UNIX socket and fake
installed `codex.exe`. It had no Hub credentials or real conversation history.
All **20 checks passed**, covering:

- medium-integrity, non-administrative Session 0 engine/Runner/bridge;
- real same-user named-pipe → AF_UNIX → WebSocket JSON-RPC traffic;
- persisted root restoration, pagination and already-loaded/child/archived/
  deleted exclusions, with zero model-turn, tool-call or input replay;
- native arguments containing spaces, empty values, quotes, Unicode and trailing
  path backslashes;
- 32 simultaneous WebSocket RPC clients and duplicate task dispatch/supervisor exclusion;
- Runner self-replacement adoption and detached-child survival across a Runner
  fault;
- engine/native-bridge descendant cleanup and automatic restart;
- continued operation while status-file replacement is denied by a reader;
- exactly two resident native hosts, four memory samples, and complete owned
  tree cleanup after terminating the isolated supervisor;
- unchanged production supervisor, engine, Runner and native bridge PIDs.

A separate read-only candidate `probe` also initialized against the **existing
production native pipe** and successfully called `thread/loaded/list`, returning
17 loaded IDs. The retained evidence records only that count, not user thread
IDs. It did not resume a thread, submit a turn or invoke a tool. This verifies
compatibility with the real local protocol, not a complete HAPI workflow under
the new supervisor.

Retained [JSON evidence](./2026-10-11-rust-windows-host.json) includes all checks,
sample values and candidate metadata. The reusable
[`windows-smoke.ps1`](../../native/windows-host/tests/windows-smoke.ps1) runs
against actual Windows Scheduled Tasks and synthetic child processes. The test
task is removed in `finally`; the temporary report is copied before cleanup. All four trial directories and
helper binaries/scripts have been removed; no test task or process remains.
The candidate executable is retained in the local build cache, with its path
recorded in the evidence JSON.

The first test attempt did **not** pass. Its polling helper converted a missing
role PID to zero, then treated Windows PID 0 as a live replacement. That allowed
some restart waits to finish too soon and made the cleanup assertion invalid.
The helper now rejects nonpositive PIDs, recovery waits require a populated live
replacement PID, and cleanup checks include a complete executable inventory.
Source review also corrected readiness during the interval between engine exit
and replacement. The reported 20-check run uses the corrected code and harness.

## Source checks and remaining boundary

- Portable Rust policy/argument tests: 3/3 passed.
- Windows-target compilation and Clippy over all targets/fixture: passed with
  warnings denied.
- Windows GNU release cross-build with Rust 1.96.0 and cargo-zigbuild: passed;
  candidate executed successfully on the actual device.
- New PowerShell scripts: syntax parsed without executing installer bodies.
- Dedicated Windows CI added for build/lint/unit/S4U fixture acceptance. CI
  execution itself has not been observed in this change.

Not yet production-accepted: actual Runner/bridge workload under the Rust
supervisor, authenticated history and sending after adoption, full reboot,
logoff/login, RDP changes, app updates, long-running load and the 120-second
protocol-outage fault. These are not implied by the synthetic fault tests.

Production replacement requires a drained window because the current outer
kill-on-close job owns active Codex processes; this implementation does not
pretend to transfer their ownership live. The registration helper refuses a
running background task. No task switch, active-process termination, commit,
push or release was performed for this migration.

History-only lazy activation and removing the full-CLI MCP forwarding process
remain separate work. This candidate deliberately preserves the existing
`thread/resume` recovery behavior and does not claim to remove the resulting
tool allocations or the Runner/bridge's own JavaScript runtime cost.
