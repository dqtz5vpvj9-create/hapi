# Persistent New pane entry

The bottom bar now keeps `P＋` beside the pane selector. On mobile it creates
an empty pane and opens the existing session list; on desktop it focuses the
existing sidebar search. A focused empty pane is reused when reopening the
selector after cancelling. Explicit right/below splits remain in Pane actions.
New workspace moves to Workspace actions; Ctrl-b c still creates a workspace.

Web typecheck and both fixture and production builds passed. Four existing
compiled browser flows passed: selection and cancellation from the new button,
compact mobile controls, reading/draft restoration through switch/zoom/reload,
and workspace move/close/undo. Additional checks at 320, 390 and 1280 px
confirmed `P＋` stays visible with four panes, opens the existing selector,
and the relocated New workspace action creates a workspace. The initial
temporary probe wrongly expected a search input on mobile, where the list
shows a search button; the corrected probe checks the list and desktop focus.
Screenshots at 320/390 px and four panes at 320 px were opened and inspected.
These are Chromium viewport checks, not physical-phone acceptance.

The production candidate passed read-only checks against the real HTTPS Hub
at 320, 390 and 1600 px, including the attachment control and workspace menu.
No live pane was created and no shared layout was changed by verification.

Published 2026-10-07T04:20:03.794Z, entry `/assets/index-O4DbGE5K.js`.
Build and root-file rollback copies are under
`/mnt/cache/build-cache/hapi-workspace-new-pane-20261007`.
Old hashed assets are retained. Hub/native bridge PIDs remained
3233230/2502589. No backend restart, commit or push was performed.
The published HTTPS entry was checked in a fresh Chromium context at all three
widths: the new button and existing attachment control were visible, the
workspace menu remained available, and no page errors or application writes
were recorded (`new-pane-published-live.json`).
Logs and browser observations are under
`/mnt/cache/data-cache/hapi-tmux-implementation/new-pane-*`.
