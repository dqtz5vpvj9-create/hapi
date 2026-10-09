# Desktop session context menu

Published the frontend at 2026-10-08 10:16:22 UTC. The HTTPS entry is `/assets/index-CUKeSvtD.js`.

## Behavior and cause

Right-clicking a session row opens its action menu without selecting the session. The first three actions open the session in the current pane, in a new pane to the right, or in a new pane below. Escape or an outside click dismisses the menu without navigation. Shift+F10 and the ContextMenu key also open the menu.

The shared `useLongPress` hook previously treated every mouse release as a possible selection. When the right-button mouseup arrived before contextmenu, it selected the session before showing the menu. The hook now permits selection only for the primary mouse button.

Split actions also work from the ordinary single-conversation view: it enters the workspace while retaining the current chat. A session that already has a pane is focused rather than duplicated, preserving the existing workspace rule. Existing rename, copy IDs, unread, pin, export, archive and delete actions remain available.

## Verification

- 47 related unit tests passed, covering both right-click event orders, ordinary left-click, middle-click, keyboard access, touch handling and existing session actions.
- The frozen release source passed the web typecheck and production build.
- Eight browser tests passed: four context-menu cases, three pane-navigation cases, and the long-code reading-position case across resize, zoom, mobile projection and reopening. Split tests checked layout geometry, preserved chat DOM and drafts, refresh restoration, and focusing an already-open session.
- The desktop menu screenshot was opened and visually inspected: `/mnt/cache/data-cache/hapi-tmux-implementation/session-context-menu-desktop.png`.
- Read-only browser checks passed against both the candidate and the published HTTPS entry. Right-click left the focused pane and visible pane count unchanged; all three menu actions appeared. Desktop pane titles and the window switcher were also checked at 1440, 390 and 320 pixel widths. No browser errors or workspace mutations were recorded.

Browser acceptance used local Playwright Chromium. Physical Windows desktop and phone input were not tested in this change.

## Release scope

The release was built at `/mnt/cache/build-cache/hapi-session-context-menu-20261008` from the latest document release snapshot, with the scoped menu changes and desktop pane navigation changes applied. It retains the document release's authenticated Range loading, Codex file citations and hidden PDF layer fix.

The served assets are at `/mnt/cache/build-cache/hapi-document-release-20261007/published-web`. Previous root assets were saved in `/mnt/cache/build-cache/hapi-session-context-menu-20261008/previous-web`; existing hashed assets were retained during publication. Workspace protocol remains version 2. Hub and native engine stayed active with unchanged PIDs, 1578191 and 1578194. No backend restart, commit or push was performed.

Publication and live acceptance evidence:

- `/mnt/cache/data-cache/hapi-tmux-implementation/session-context-menu-published.json`
- `/mnt/cache/data-cache/hapi-tmux-implementation/session-context-menu-candidate-live.json`
- `/mnt/cache/data-cache/hapi-tmux-implementation/session-context-menu-live.json`
