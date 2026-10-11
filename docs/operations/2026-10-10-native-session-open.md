# Opening saved native Codex sessions

The reported CHRIS session `9a553f21-b705-43a6-8772-54668f16bf35` returned HTTP 503 because its per-session `readCodexHistory` handler was absent. Its machine and native bridge were online. The bridge discovers currently loaded native threads; this older saved thread was not attached. The Hub previously read history without reconnecting and explicitly rejected native resume. The offline banner therefore incorrectly implied that the machine bridge had to be repaired manually.

`SyncEngine.readCodexHistory` now catches only `RpcTargetMissingError`, reconnects the original native thread through its own machine Runner, and retries the original read once. Messages, outline, context and explicit resume share one in-flight connection per HAPI session. Machine namespace and online status are checked; the reply must confirm the original HAPI and native IDs. Ordinary history failures do not trigger reconnect. Failed attempts release the in-flight entry so a later open can retry. This uses the existing connection protocol and creates neither a replacement session nor a new model turn.

## Verification

- Hub tests: 1481 passed, 3 skipped; Hub typecheck and diff whitespace check passed.
- Seven new regression cases cover cold history, concurrent reads, resume, unavailable/other-namespace machines, ordinary RPC errors and unexpected binding/retry.
- Before deployment, the reported original session was restored through the existing connection API in approximately 248 ms, then returned 20 messages.
- On the deployed patch, another previously inactive native test session (`8bc3a07a-ad85-47e7-b6f1-74a69fc8693d`) opened using only a history GET: HTTP 200, four messages, inactive to active, approximately 632 ms. No manual connect request preceded this check. This is a single measured sample, not a latency guarantee.
- The reported session returned 20 messages in approximately 93 ms after deployment.
- Public HTTPS browser checks at 1440 and 390 CSS pixels rendered 13 chat nodes and the composer, with no native-offline banner or JavaScript error. These are automated Chromium checks, not physical-device or screenshot acceptance.
- Both original machine IDs reconnected. All 16 recorded local Codex app-server process generations and native bridge PID 595441 remained unchanged.

## Deployment and rollback

Release directory: `/mnt/cache/build-cache/hapi-native-open-20261010`. It copies the frozen `1beac515` release and changes only Hub `syncEngine.ts`; the regression test is also included. Existing Web and CLI artifacts are retained. Windows startup optimization and other dirty working-tree edits are not included.

Hub is selected by `/home/chris/.config/systemd/user/hapi-hub.service.d/zz-native-open.conf`. An initial override named `90-native-open.conf` was overridden by the existing `history-reader.conf`; the live ExecStart check caught this and the file was renamed before final verification. No native service or engine was restarted during either Hub cycle.

For code rollback, remove exactly the new `zz-native-open.conf` override, daemon-reload and restart only `hapi-hub.service`; the original release override remains intact. Keep the native service's existing Wants dependency, which isolates it from Hub restarts. No history or schema migration occurred.

A genuinely offline machine or unavailable native bridge still cannot serve its local history. The fix covers automatic opening through an available machine and bridge; it does not claim offline history replication.
