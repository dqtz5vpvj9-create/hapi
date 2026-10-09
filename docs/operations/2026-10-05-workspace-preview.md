# Workspace preview release — 2026-10-05

The subsequent frontend-only session-list interaction update is recorded in [Workspace session selection](2026-10-05-workspace-session-list.md). Its published entry supersedes the original frontend entry below; the backend is unchanged.

The user requested a deployed preview of the latest working tree before the complete tmux workspace goal is finished. This release includes the current chat presentation and asynchronous question fixes together with workspace layout and synchronization. It is not acceptance of the remaining long-lived terminal design or every difference from the approved prototype.

## Published runtime

- Site: `https://hapi.tail.lixinrui000.cn/sessions/workspace`
- Web entry: `/assets/index-Bse4eyNY.js`; served directory: `/mnt/cache/src/hapi/web/dist`.
- Candidate: `/mnt/cache/build-cache/hapi-workspace-preview-20261005/{web,hub}`.
- Hub override: `hapi-hub.service.d/history-reader.conf`, running the candidate `hub/index.js` with the existing Bun binary and CLI working directory.
- SQLite migration: v28 → v29, adding workspace collections and operation identities. No conversation-body copy is added by this feature.

## Checks and observed behavior

All package typechecks passed. The initial root test run passed CLI and Hub, then encountered two Web timeouts at the existing five-second deadline. A complete Web rerun with four workers passed all 3,681 tests without changing code or deadlines. The remaining Shared, Relay and four history/index integration suites also passed. Fixture regeneration made no fixture changes, and `git diff --check` passed.

Workspace-specific evidence includes 11 existing browser flows, four real authenticated Hub/two-browser synchronization flows, six transport fault-injection scenarios, and nine authorized workspace API tests. A copy of the production database successfully migrated and started under the built Hub in isolation before deployment.

Before and after the Hub update, the Windows preflight ran as `LIS-IMAC\lixinrui` in Session 0. Fresh direct DNS, HTTPS, WebSocket, native named-pipe initialize/reconnect, and authenticated existing-session history passed. Both previously online machines returned with their original IDs. Three existing Linux/Windows sessions opened and reloaded in real HTTPS browsers at 390px and 1440px widths without HTTP or JavaScript errors.

The production workspace check opened Linux and Windows chats side by side, tested zoom/restore, an unsent draft across refresh, single/workspace switching, and shared layout in a second browser with mobile P1/P2 navigation. It sent no chat messages or model requests. The initial shared collection was empty; the resulting two-pane Workspace 1 remains available for the user's preview.

Desktop 1600×960 and mobile 390×844 screenshots were generated with `webshot` and visually inspected. Because webshot starts a fresh browser, a temporary loopback-only, read-only proxy inserted authentication in memory and forwarded the deployed HTML/assets/API. Direct HTTPS browser checks were performed separately. The screenshot contains an existing conversation image still showing its resource-loading placeholder; it is not evidence that every media resource loaded.

## Restart behavior discovered during release

Restarting `hapi-hub.service` also restarted the Linux native bridge because `hapi-native.service` has `Requires=hapi-hub.service`. Checking only the Hub's own dependencies missed that reverse dependency. Machine registration recovered before native history RPC registration, causing one immediate history check to return 503. Subsequent authenticated reads of all three sessions passed before the Web entry was published.

The existing native Codex daemon listening on the configured Unix socket remained PID 3103929, with an uptime of more than six days. The bridge restart did not restart that engine. No Windows engine, bridge or Runner restart was performed. Future backend releases must inspect reverse dependencies and wait for authenticated native history in addition to machine registration; an online machine alone is insufficient readiness.

## Evidence and rollback

Private evidence and the pre-migration SQLite backup are in `/mnt/cache/data-cache/hapi-workspace-preview-20261005`. This cache directory is subject to the host's seven-day cleanup policy. Root Web files are backed up in `/mnt/cache/build-cache/hapi-workspace-preview-20261005/previous-web`; old content-addressed assets were retained in the served assets directory for already-open clients. The previous Hub override is recorded as `previous-hub.conf` in the private evidence directory.

A frontend rollback restores the previous root files, writing `index.html` last, while retaining both sets of hashed assets. A backend rollback requires a controlled outage: stop the Hub and its dependent bridge, restore the prior override, lower `PRAGMA user_version` to 28 while retaining the additive workspace tables, reload systemd and start both services. Do not blindly replace the live database with the old backup, because that would discard messages received since release. This rollback procedure was prepared but not executed. Repeat the same two-machine/history checks after any rollback.

## Still pending

Machine-owned durable terminals, recovery across Runner/host restarts, the complete Linux/Windows fault matrix, remaining prototype details, real phone keyboard behavior and multi-pane performance acceptance remain part of the active full goal. This preview is for user review, not a claim that the whole goal is complete.

## Follow-up preview check

A subsequent read-only check confirmed that the deployed Web entry still matches the latest frontend source release; the newer work is the isolated TerminalHost implementation, which is not deployed. Both machine IDs remain online. All three sessions opened and reloaded at 390px. At 1440px, HAPI Main passed, but the first open of the o-debug session timed out waiting 30 seconds for `data-chat-presented=true`. A separate fresh-browser check of that same session then passed open and reload with six successful history responses and no JavaScript errors. The intermittent initial-presentation timeout remains unexplained; the successful retry does not close that issue.

The follow-up read-only workspace browser check used the current shared layout rather than restoring the release-time two-pane fixture. It passed at 1600px with three visible panes and at 390px with one projected pane, with no JavaScript errors and no workspace writes.
