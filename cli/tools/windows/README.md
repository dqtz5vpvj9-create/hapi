# Windows process generation probe

`process-markers-v5.exe` reads live process creation times with `OpenProcess`,
`GetProcessTimes` and a zero-timeout `WaitForSingleObject`. It never sends a
signal, changes a process, or starts PowerShell/WMI. Unreadable processes fail
the query; exited or absent PIDs are omitted. Output retains CIM's UTC
microsecond precision and .NET round-trip representation so saved HAPI runtime
markers continue to protect against PID reuse.

The Windows executable is embedded in HAPI's standalone binary through the
existing runtime asset mechanism. Source and binary carry HAPI's AGPL license.
Rebuild from the repository root with Zig 0.16.0:

```sh
zig cc -target x86_64-windows-gnu -Os -s -Wall -Wextra -Werror \
  cli/tools/windows/process-markers.c -o cli/tools/windows/process-markers-v5.exe
```

The Windows integration test compares live markers with OS creation times,
checks an exited PID while retaining its handle, and measures the full helper
invocation, including startup. It also denies access to a test-owned child,
verifies a live unreadable PID fails, then verifies the exited PID is omitted.
Run this test under the same restricted token as Runner: a scheduled S4U task
with `RunLevel Limited` can still retain administrator access on this host.
No creation-time result is cached.

Runner starts the helper with `--stdio` once during initialization. Each line of
decimal PIDs produces one JSON response. The child exits on pipe EOF; idle pipes
are unreferenced so a short-lived CLI can also exit normally. Each request emits
one complete JSON array or error object. An OS query error rejects that request
without terminating the worker or discarding other pending requests; a transport
failure closes the worker. Cold startup and warm latency are measured separately.

An exited process object can remain alive while another process retains a
handle. Under Runner's restricted token, opening that stale object can report
access denied instead of process-not-found. On access denied, `EnumProcesses`
checks current PID presence once per request. Only absent PIDs are skipped;
live unreadable processes still fail the query. Both generation handles and the
PID enumeration are fresh for every request.
