# Built artifacts and reconnect checks

Use the repository's pinned Bun and installed Playwright. Build once for the
current sources before checking the artifact:

```sh
bun run build:hub
bunx playwright install chromium
bun run test:built-artifact
```

The runner copies the built `hub/dist` and its companion built `web/dist` to an
isolated temporary directory outside the checkout, then starts that copy with a temporary database, fresh authentication
token, and loopback listener. Its browser checks the actual login, compiled
JavaScript responses and MIME types, a settings deep link, and theme persistence
after reload. Vite and the original checkout cannot supply a missing staged
asset. The JavaScript Hub intentionally uses the companion web build; it is not
a single self-contained executable. A successful build alone does not satisfy this check.

For an already built executable, use the same runner:

```sh
bun run test:built-artifact --executable cli/dist-exe/bun-linux-x64-baseline/hapi
```

This checks the host executable's version and bundled Hub; it does not claim
that executables for other operating systems were launched. Release CI runs it
before packaging and publishing.

## Actual streaming and reconnect cohort

```sh
bun run test:realtime-cohort
```

This includes the artifact smoke above, then reuses the same real Hub. Three
session-scoped CLI Socket.IO clients send authored Codex-compatible message
snapshots. Two separately authenticated browser contexts read different
sessions; an owned transparent loopback forwarding link closes one browser's
actual sockets while all three streams keep updating. Chromium offline emulation
also blocks new requests during the outage. The small cohort must receive the server's `resume: ok` verdict. The
larger cohort must overflow the replay ring, receive `resume: gap`, and read
authoritative history through REST. CDP observes the browser's native
EventSource traffic; no EventSource implementation or Hub API is mocked.

Both cohorts check exact settled bytes, a single canonical row after streamed
snapshots and late/duplicate completion, session isolation, and visible browser
recovery. An additional real session in another namespace must be absent from
all streams, and explicit REST/SSE access to it must fail with 403. The existing
global `all:true` subscription intentionally carries full messages for workspace
and recent-history consumers; the receipt records its decoded JSON bytes and
body count (excluding SSE framing and compression). A
separately requested native EventSource with `messageMode=notify` must receive
actual notifications with no bodies. Reading must not send a chat message. These stored-message checks do not
exercise a native Codex Runner, native-history RPCs, a live model, or child
threads. Existing native full-stack and history tests remain responsible for
those contracts.

`e2e-output/built-artifact` contains JSON receipts, the redacted Hub log, and
screenshots. Cohort receipts record observed recovery time and browser long
tasks for this run. They include harness overhead and are not a before/after
performance improvement or physical-phone result. Failed/interrupted runs are
not passes. Use `--output` for a separate evidence directory or `--browser` for
an explicitly chosen executable; the receipt records its actual version.

The dependency UI lane builds the Hub once, runs this artifact/cohort check, then
retains the existing UI regression lane and the file-workbench acceptance spec
in one Playwright invocation. Their report cannot erase the artifact receipt.
It runs for dependency changes and production changes under `web/src`, `hub/src`
and `shared/src`, including document, workbench, router and filesystem entrypoints.
The file-workbench spec uses independent fixture filesystem bytes by default;
its explicit shared-machine cases use one physical byte store across sessions.
It checks current-conversation saves/references, concurrent editors and retained
drafts across file operations. Runtime filesystem tests remain authoritative for
path confinement, symlinks and revision races.

## Strict native model-response fixture

The existing `cli/src/codex/shared/frontend.integration.test.ts` uses
`ResponsesReplay` at its HTTP model boundary. Each interaction has an explicit
prompt and response, and tool continuations must match their originating call
and checked result. Missing, extra and out-of-order calls fail the final
consumption check even if an immediate handler error was caught. A separately
bounded structured-title request is permitted without consuming a conversation
step. The helper's offline tests check these failure modes; they do not replace
the original real-native-process full-stack test.
