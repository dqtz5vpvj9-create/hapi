# Workspace session selection — 2026-10-05

The later [attachment lifecycle release](2026-10-06-workspace-upload-lifecycle.md) preserves this navigation behavior and supersedes the frontend entry recorded below.

The user asked to stop terminal development and first make workspace selection usable on a phone. The workspace now reuses the existing session list, including its search, machine filters and folder groups.

On a narrow viewport, the bottom back button, the pane's open-conversation action and split selection navigate to `/sessions?view=list`. Selecting an already-open chat focuses its pane; selecting another chat replaces the focused pane. The list also offers a return-to-workspace action without changing any pane. On desktop, opening a conversation or filling a split focuses the existing sidebar search instead of opening a separate quick-switch dialog. The ordinary single-conversation flow is unchanged.

Opening a workspace URL directly also activates the local workspace mode. Production verification exposed that a fresh browser could display a workspace while retaining the default single-view mode; this would make list selection return to a single conversation. The route now uses the same entry operation as the existing mode button, including waiting for shared-layout initialization before creating a default layout.

## Verification

- Web typecheck and production build passed.
- Thirteen workspace browser flows passed, covering mobile list return, replacement, existing-pane focus, split selection, unsent drafts, reading anchors, single/workspace switching, drag, resize and zoom. The first cold Vite run hit an outdated optimized dependency; its affected flow passed after optimization completed. After fixing direct entry, four affected flows were rerun and passed, including a fixture with a saved single-view preference.
- The final HTTPS production check used a fresh browser: browser Back, refreshing the list, returning without selection and selecting the current session all passed. The original layout remained unchanged; switching back to desktop showed all three existing panes. There were no JavaScript errors or workspace mutations in this read-only check.
- A 390×844 screenshot of the deployed list was captured with webshot through a temporary loopback read-only authentication proxy and visually inspected. Direct HTTPS navigation was verified separately.

## Release

Published Web entry: `/assets/index-DjQWbxn7.js`, at 2026-10-06 06:25 UTC. Only frontend files were published. Hub PID 3233230 and native bridge PID 3233231 remained unchanged; no Windows service or native engine was restarted. No terminal-host development was included in this release.

Build and rollback root files: `/mnt/cache/build-cache/hapi-workspace-list-navigation-20261005/{web,previous-web}`. The existing hashed assets remain available for open clients. Rollback restores the backed-up root files with `index.html` last; it requires no database or backend change.

Logs, read-only live results and screenshots: `/mnt/cache/data-cache/hapi-tmux-implementation/list-navigation-*`. This cache evidence is subject to the host's seven-day cleanup policy. The complete tmux-workspace goal remains unfinished; this record covers the session-list interaction only.
