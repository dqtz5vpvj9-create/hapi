# Workspace attachment entry

The workspace composer now opens the existing file picker directly from a
paperclip at the left of the input row. The lower Add menu is replaced by a
direct session-reference action, preserving selection when inserting `@`.
Single-chat layouts retain their existing Add menu. Upload ownership, scheduling
exclusion, Goal-mode exclusion and disabled-state checks use the existing
composer and attachment adapter.

On mobile the attachment target is 40 × 44 CSS pixels. At 320 and 390 px widths,
the input row does not overflow. Browser checks at both widths and at 1280 px
verified one-click file selection, upload, submission to the originating pane
and the separate reference action. The final 390 × 844 screenshot was opened
and visually inspected. These are Chromium viewport checks, not a physical
phone or operating-system file-picker acceptance test.

This candidate also contains the resume handoff correction started before the
button request. The browser fixture reproduced attachment loss after a resume
returned a different session ID; an early supersession notification also lost
the submitted text. Resume now carries the captured file drafts with the text,
and automatic following waits until local resolution and transfer finish.
The completed source handoff is not copied over the hydrated destination again.
Both notification orders passed with the neighboring Goal draft and focus
unchanged, and the attachment re-uploaded and sent under the new session ID.

## Validation and release

Web typecheck, 92 focused tests and 45 compiled browser flows passed. The
browser suite includes attachments, resume ID handoff, Goal isolation, mobile
projection, resizing, history paging, bookmark restoration and two/five warm
workspace returns with history responses held. The first regression launch used a fixture
build without the history HTML entry; its missing-page failures are retained
in `attachment-position-regression.log`. The complete fixture build is used
for the replacement run in `attachment-position-full-regression.log`.

The production-only candidate was also exercised against the real HTTPS Hub
without chat sends, uploads or workspace writes. The user's current layout has
one workspace, so this live run cannot establish two-workspace switch latency.
The mobile attachment control appeared in the input row and opened the picker
in one click; the picker was cancelled before uploading anything.

Builds are under `/mnt/cache/build-cache/hapi-workspace-attachment-20261007`.
Logs, browser observations and the inspected screenshot are under
`/mnt/cache/data-cache/hapi-tmux-implementation`, prefixed `attachment-position`.
The production-only `web` directory excludes the test fixture pages.

Published at 2026-10-07T04:13:40.691Z with entry
`/assets/index-OXCOhRYp.js`. Root-file rollback copies are in `previous-web`
beside the build; old hashed assets remain available. Hub/native bridge PIDs
stayed 3233230/2502589. No backend restart, commit or push was performed.
The published HTTPS entry was then verified in a fresh Chromium context:
the mobile paperclip remained at the input's left edge and opened the file
picker directly, with no page errors or application writes. The picker was
cancelled. See `attachment-position-published-live.json`.
