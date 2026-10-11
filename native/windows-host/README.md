# Native Windows runtime host

This crate replaces the six resident PowerShell hosts in the host-specific
`scripts/windows` deployment with two native processes:

```text
Task Scheduler (S4U)
  hapi-windows-host bootstrap
    hapi-windows-host supervise (restricted, medium integrity)
      Codex app-server
      HAPI Runner
      HAPI native bridge
```

The supervisor hosts the named-pipe/AF_UNIX relay and native WebSocket probe
in-process. Rust is compiled to machine code; there is no .NET, JavaScript or
language VM in these two host processes. Tokio supplies a single-thread async
I/O executor, not a virtual machine. Runner, bridge and Codex retain their
existing implementations and costs.

## Build and checks

On Windows with the Rust MSVC toolchain:

```powershell
cargo build --manifest-path native/windows-host/Cargo.toml --release --locked
cargo test --manifest-path native/windows-host/Cargo.toml --locked
cargo clippy --manifest-path native/windows-host/Cargo.toml --all-targets --features test-fixture --locked -- -D warnings
```

For a Linux cross-build, install the `x86_64-pc-windows-gnu` Rust target and use
`cargo-zigbuild` with Zig's MinGW support. The verified candidate was built with:

```sh
uvx --from cargo-zigbuild cargo-zigbuild zigbuild \
  --manifest-path native/windows-host/Cargo.toml \
  --target x86_64-pc-windows-gnu --release --locked
```

The lockfile belongs to this standalone crate. Its build does not change Bun
workspaces or the HAPI wire protocol.

## Ownership and security

The bootstrap preserves `TaskHost.cs`'s restricted LUA token, disabled
privileges, medium integrity, private non-interactive station/desktop and
suspended-before-job-assignment launch. Only the bootstrap keeps the original
S4U token. The supervisor refuses an administrative or high-integrity token.
Child stdout/stderr are inherited through an explicit handle allowlist; job,
token and desktop handles are not inherited.

The outer job owns the complete backend tree and kills it if the bootstrap
exits. Engine and bridge have nested kill-on-close jobs. Runner's nested job
deliberately does not kill descendants, so detached sessions survive a Runner
replacement. Runner adoption checks the state PID, configured executable and
membership in this bootstrap's ownership job without launching WMI/PowerShell.

The pipe retains the existing endpoint and protocol. Its DACL permits the
current user and SYSTEM, has a medium integrity label, rejects remote clients
and exposes no TCP listener. First-instance binding happens before role startup;
an existing deployment's pipe cannot be replaced by accidentally running a
second host. A named mutex also prevents duplicate supervisors in one session.
The relay supports 64 connected clients plus a listening instance; 32 simultaneous
WebSocket RPC clients are exercised in the Windows fixture test.

## Configuration and operation

`configure-rust-host.ps1` writes `config/windows-host.json` without changing
tasks or running processes. Review its executable paths and workspace roots
against the deployed installation. Credentials stay in the existing restricted
`connection.json`; the host reads them only into Runner/bridge environments.
Role arguments are passed directly to `CreateProcessW`, with Windows argument
quoting, Unicode environment and current directories. No resident shell is used.

`@codex` resolves the newest installed desktop executable at each launch, like
`resolve-codex.ps1`. PATH prefixes, executable paths and workspace roots are
configuration data, not baked into the executable.

The supervisor preserves:

- 1/2/4/.../32-second bounded restart backoff, reset after a 60-second run;
- native RPC readiness before the initial bridge launch;
- the 120-second native-protocol outage threshold, independent of Hub health;
- root-ID snapshots and persisted, non-archived, non-child restoration;
- no replay of model turns, tools, queued inputs or uncertain submissions;
- atomic `supervisor.json`/root-snapshot replacement and 4 MiB event-log rotation;
- continued operation when an observational file is temporarily locked.

Transport reconnection and protocol probing are asynchronous; they do not stop
the one-second role/heartbeat loop. Relay failures retry within the supervisor
without immediately stopping live roles. `roles.pipe.inProcess` is true and its
PID is the supervisor PID. Role PIDs now identify actual executables, not shell
wrappers. Legacy fault scripts that assume `pwsh/start-role.ps1` must not be used
against this runtime.

Creating `state/stop-requested` requests a whole-backend stop. Remove it before
starting the runtime again. Like the previous whole-host stop, this terminates
managed sessions through the outer job; it is not a way to restart only Runner.

## Isolated Windows acceptance

Build fixtures only for testing:

```powershell
cargo build --manifest-path native/windows-host/Cargo.toml --release --locked --features test-fixture --bins
```

Invoke `tests/windows-smoke.ps1` with absolute `HostExecutable` and
`FixtureExecutable` paths. It creates a uniquely named S4U Scheduled Task,
private state, fake installed Codex executable, AF_UNIX socket and named pipe
under `TemporaryRoot`. It never uses real Codex history, Hub credentials or model
requests. Its own mock processes are intentionally terminated for fault tests;
the production task and active engines are not stopped. Task registration is
cleaned in `finally`; reports stay in the trial directory for inspection.

The test covers actual restricted Session 0 execution, pipe/WebSocket traffic,
restoration filters, direct argument boundaries, repeated dispatch, Runner
handoff and child survival, engine/bridge cleanup and restart, locked status
files, two-host memory samples and complete tree cleanup after supervisor death.
It separately checks that production role generations remain unchanged.

## Deployment boundary

This is a source migration and candidate, not an in-place ownership transfer.
Windows cannot move the current PowerShell-owned engine and active sessions
out of their existing kill-on-close Job Objects. Replacing that tree requires a
drained maintenance window. Do not stop an active Codex application or engine to
demonstrate lower memory.

Before switching, save the old task XML/configuration, complete device/native
and Hub connectivity checks, drain active sessions, disable and explicitly stop
the old background task, and confirm its tree is gone. Then register the native
host using `register-rust-background.ps1 -Executable <candidate> -Config <file>
-Start`. The installer refuses to replace a currently running background task.
It preserves boot/logon/one-minute triggers and IgnoreNew/RestartOnFailure.

Verify the same machine ID, authenticated history, native transport, new
execution and official desktop attachment after switching. Rollback restores
the previous task action/launcher after draining the candidate. No history or
machine-identity migration is involved. Reboot, real logoff/login, RDP switching,
app updates and prolonged load remain separate device acceptance scenarios.

History-only lazy activation and removal of the full-CLI MCP forwarder are
separate optimizations. This host migration preserves the previous restore
policy, including `thread/resume` potentially allocating configured MCP tools.
Do not describe its savings as solving those additional costs.
