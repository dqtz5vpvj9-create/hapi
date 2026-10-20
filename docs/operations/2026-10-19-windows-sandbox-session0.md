# Windows sandbox recovery, 2026-10-19

The affected Windows training session could read history but could not execute
commands: `timed out after 15000ms connecting runner pipe-in`. Windows recorded
USER32 initialization failures (`0xc0000142`) for the sandbox runner. The host
and Codex engines were still running. The failure reproduced without switching
between the local desktop and RDP.

The deployment remains a limited S4U Scheduled Task owned by `lixinrui`, with
the supervisor and engines in Session 0. It does not require an interactive
login. No production engine or desktop application was restarted for this fix.

## Cause and repair

There were two startup barriers:

1. HAPI's private bootstrap station and desktop admitted only the owner and
   SYSTEM. Codex's separate sandbox accounts could not initialize USER32 there.
   `sandboxBootstrapGroupSid` now grants the existing CodexSandboxUsers group
   participant rights on those two objects only: station `0x2006e`, desktop
   `0x200cf`. It does not grant WRITE_DAC, WRITE_OWNER, access to WinSta0, or
   access to HAPI's pipe/job/token objects.
2. The matching Codex runner created/opened a policy-specific private desktop,
   but selected it as `WinSta0\<name>` when launching the command. The patch
   obtains the current station name with GetProcessWindowStation and
   GetUserObjectInformationW. Private desktop creation, its ACL, restricted
   tokens and filesystem/network policy are unchanged.

The same combination is described in
[OpenAI Codex issue 37722](https://github.com/openai/codex/issues/37722).

## Reproducible runner build

Source is the official `rust-v0.162.0-alpha.17.2` tag, commit
`740e5af33c71225640e0c1c1555c514c2c93ab74`.
Apply [the patch](../../scripts/windows/patches/codex-0.162.0-alpha.17.2-session0.patch)
at that source root. This rebuilds only `codex-command-runner.exe`, not the
main Codex executable or the desktop application.

```sh
RUSTUP_TOOLCHAIN=1.96.0 uvx --from cargo-zigbuild cargo-zigbuild zigbuild \
  --manifest-path codex-rs/Cargo.toml \
  --package codex-windows-sandbox --bin codex-command-runner \
  --target x86_64-pc-windows-gnu --release --locked
```

The tag's lockfile still recorded its local workspace packages as `0.0.0`.
The first offline Cargo invocation refreshed those local package versions to
the tag version; no external dependency versions changed. Subsequent builds
used `--locked`. The build tree is
`/mnt/cache/build-cache/codex-sandbox-repair-20261019`.

The original installed runner, bootstrap ACL snapshot, task XML and host
configuration are backed up under `D:\hapi\backups\sandbox-20261019`.
The live private desktop received the scoped ACL update, and the matching
installed command runner was replaced. `HAPI-background` now points to
`D:\hapi\bin\hapi-windows-host-20261019.exe` for its next start; its existing
S4U principal, triggers and running process tree were retained. The canonical
`D:\hapi\config\windows-host.json` records the sandbox group SID.
The patch is version-specific: a later Codex upgrade needs its own sandbox
execution check; do not copy this helper into another engine version.

## Acceptance

- The original production engine (PID 26904) executed read-only `whoami` inside
  the offline sandbox account.
- PowerShell wrote a diagnostic file within the configured workspace and was
  denied a write outside it. For legacy `command/exec`, the policy root is the
  app-server working directory, not the request's command working directory.
  The negative check used a path outside that actual root.
- The affected session's own runtime (PID 283088) returned its existing thread
  through `thread/read`, then successfully executed sandboxed `whoami`.
- A separate S4U task booted the new host with a real Codex engine on a private
  test socket. The new station/desktop had exactly the configured participant
  masks, the supervisor ran in Session 0, and sandboxed `whoami` succeeded.
  The test task and its process tree were then removed.
- Four native host unit tests passed. The Windows fixture passed 21 checks,
  including restricted Session 0 tokens, 32 pipe clients, role fault recovery,
  child ownership/cleanup and unchanged production process generations.
  An initial fixture run hit a transient access-denied error during Runner
  restart; the old deployed host and a repeated candidate run both passed.

Full interactive logout and RDP switching were not performed on the user's
desktop. Session 0/S4U startup and sandbox execution are tested separately
from that remaining interactive acceptance scenario.
