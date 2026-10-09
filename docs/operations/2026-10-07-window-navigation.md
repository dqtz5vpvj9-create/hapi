# Window navigation and immediate creation

Published 2026-10-07 at 09:49 UTC. Entry: `/assets/index-DrF419oM.js`.

The user confirmed that Ctrl-b c should create a tmux-style window and immediately
choose a conversation, without a naming dialog. The local tmux binding is
`bind-key -T prefix c new-window`.

## Interaction

- UI actions now say **window / 窗口** for each collection of panes. Workspace
  remains the overall view mode and the internal document/API name; no extra
  hierarchy or data migration was introduced.
- Ctrl-b c and New window create immediately. Desktop focuses the existing
  sidebar search; mobile returns to the existing session list. Rename remains
  available by double-clicking a tab or through Window actions.
- P＋ still adds a pane to the active window. Moving a pane to a new window also
  no longer prompts for a name.
- Tabs show only their names; the unexplained pane count was removed. Existing
  saved names are preserved. Pane counts remain in the switcher, with distinct
  title, close-button and list-row spacing.
- The creation dialog was removed, including its untranslated `common.cancel`.
  The conflict-notice close action now uses the existing `button.close` key.
- A real-account check exposed a second shortcut issue: an unacknowledged FUE
  tip uses `role=dialog`, causing the previous blanket dialog check to suppress
  Ctrl-b. Nonmodal tips outside keyboard focus no longer block navigation;
  visible modal dialogs and keyboard focus inside any dialog still do.

## Validation

The source tree's initial workspace store tests passed (5), as did the web
package typecheck once concurrently-created document dependencies were present.
An initial browser regression run passed 30 workspace/history/lifecycle cases;
4 isolated-Hub cases failed because that test server permits origin 5188 while
this preview used 5200. The release tests use its supported origin. Their
remaining stale translated selectors and old create-and-name assumption were
updated to exercise immediate creation and separate renaming.

The final release snapshot passed its full web typecheck and 11 browser cases:
5 navigation/localization/FUE cases, 4 real in-memory Hub synchronization cases,
and 2 native/mixed-history warm mobile pane cases. Sync checks include remote
close with a local draft, offline creation plus remote rename, and recovery
when a create acknowledgement is lost. Warm pane checks delay history requests
and inspect retained readers/composers and reading positions on successive
frames; no opening skeleton or position drift occurred. This is Chromium at
phone viewport sizes, not a new physical-phone acceptance run.

`webshot` screenshots were inspected at 390×700 light and 1440×900 dark.
The actual candidate was also tested against production's read-only API at
1440, 390 and 320 pixels: existing layout/chat read, Ctrl-b w, action-menu
labels, switcher bounds and absence of page errors. That check performed no
conversation or layout writes. The postpublish check passed against the served `/assets/index-DrF419oM.js`
entry at all three widths, with no page errors or conversation/layout writes.

## Release isolation

Another ongoing document-editing task changed the working tree's shared layout
protocol from 1 to 2 while this task ran. Production still serves protocol 1.
Publishing the live checkout directly would therefore be inappropriate.

The build uses the captured source at
`/mnt/cache/build-cache/hapi-window-navigation-20261007/source`, before document
editor routing was connected. In this build copy only, shared/workspace snapshot
version declarations and the isolated fixtures/Hub use protocol 1. The unconnected,
incomplete `DocumentSurface.tsx` was omitted from the snapshot; the production
entry does not reference it. The development checkout retains protocol 2 and all
other document changes. This release does not upgrade the Hub or CLI.

The production build is outside the served root. Existing root assets are backed
up under `previous-web`; new assets are copied before atomically replacing root
files with index last. Hub PID 3233230 and native bridge PID 2502589 remained
active and unchanged. A prepublish API check confirms protocol 1 before installing
this candidate. A later document-feature release must coordinate its own frontend
and backend protocol upgrade rather than rebuild this protocol-1 snapshot.

Artifacts are under `/mnt/cache/data-cache/hapi-tmux-implementation`:
`window-release-final.log`, `window-warm-final.log`,
`window-release-typecheck-final.log`, `window-candidate-live.json`,
`window-published.json`, `window-published-live.json`,
`window-switcher-mobile.png`, and `window-switcher-desktop.png`.
