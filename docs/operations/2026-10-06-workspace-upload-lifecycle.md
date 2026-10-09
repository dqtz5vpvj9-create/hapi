# Workspace attachment lifecycle — 2026-10-06

The existing-session-list navigation release remains in place: mobile selection returns to the full session list; desktop selection uses the existing sidebar. Terminal work remains paused at the user's request.

Further user-flow testing found that an upload which finished after its workspace was hidden was uploaded a second time when the workspace reopened. The message was sent once, but two different server paths were allocated for the same attachment. The first path was left unused.

The frontend now shares pending uploads by API client, session and attachment identity. Completion updates the existing attachment draft, including IndexedDB, while its composer is absent. A returning composer joins the pending upload or restores its completed path. Explicit removal reaches the shared upload even when the runtime has replaced its adapter; a late result is deleted once. Settled task entries are released. Cross-session draft transfers still strip source-session upload paths.

## Verification

- Web typecheck, the production build and 97 focused tests passed. These cover adapters, draft persistence, composer hydration, session transfer and Scratchlist attachment flows.
- Four browser flows passed against a production-mode build of the real workspace fixture: completion in a hidden workspace, completion followed by a full reload, returning while upload is pending, and removing an upload after returning. The tests assert one upload, correct attachment ownership and send metadata, or one cleanup without restoring the removed file. The Hub boundary is simulated; no model requests were made.
- Additional selector checks passed for desktop sidebar search, the full list on a narrow desktop, and goal editing isolated to its originating pane with both message drafts preserved.
- The deployed HTTPS entry passed a fresh-browser check at 390 px: browser Back, list reload, returning without selection, and selecting the current session. The existing layout was preserved and showed all three panes at 1600 px. No JavaScript errors or workspace writes occurred in this read-only check.
- A 390×844 screenshot of the deployed list was captured with webshot through a temporary loopback read-only authentication proxy and visually inspected. Search, filters, folders and session rows were present; no quick-switch dialog was shown.

Two final development-server runs timed out at the existing five-second initial-session visibility assertion before any attachment interaction. A timing probe observed a 3.45-second main-thread gap, with both panes presented at about 8.6 seconds after navigation. One production-mode fixture sample presented both at about 4.4 seconds, with a 1.77-second main-thread gap; all four production-mode flows passed without increasing deadlines. This narrows the failure to initial rendering in those runs; it does not establish a complete performance diagnosis or close the workspace performance goal. The fixture's simple static server also returned 404 for the unrelated `/health` connectivity probe. An earlier development run interrupted by source hot reload is excluded from release evidence.

## Release and rollback

Web entry `/assets/index-kZoA3FXP.js` was published at 2026-10-06 07:04:20 UTC. Only frontend assets changed. Hub PID 3233230 and native bridge PID 3233231 were unchanged; no Windows services or native engines were restarted.

Candidate and root-file backup are under `/mnt/cache/build-cache/hapi-workspace-upload-lifecycle-20261005/{web,previous-web}`. Existing hashed assets were retained. Rollback restores the previous root files with `index.html` last; no database or backend change is required.

Private logs, timing samples and browser results are under `/mnt/cache/data-cache/hapi-tmux-implementation/upload-*` and `workspace-entry-*`; the cache is subject to seven-day cleanup. The full tmux-workspace goal remains open.
