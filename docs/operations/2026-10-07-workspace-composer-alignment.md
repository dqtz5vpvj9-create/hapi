# Workspace input alignment

The mobile empty state used a 16 px placeholder with no top padding over a
14 px editor with 3 px padding. The paperclip was centered in a 44 px target;
the placeholder's line center was 3 px above it. Typing therefore changed both
font size and position. Multiline input also moved the controls toward the
middle of the entire text block.

Workspace-only CSS now gives placeholder and editor the same typography and
padding. Both input-row buttons have matching boxes and icon sizes, aligned
with the first text line. Mobile targets remain 40 × 44 px; the empty input row
remains 44 px high. Long placeholders truncate rather than shrink the font.
The selectors address the editor itself instead of also styling mention chips.
Single-chat styling, upload handling and message/history logic are unchanged.

Compiled Chromium checks at 320, 390 and 1280 px covered empty, single-line and
multiline text, plus expansion and collapse with the draft preserved. Both
icon centers matched the first line-box center, and placeholder/editor font
sizes matched. Empty and multiline screenshots were opened and inspected.
Direct file selection, upload, sending to the correct pane and session-reference
insertion passed at all three widths. Three existing workspace flows passed,
covering reading/drafts across switches and refresh, compact mobile controls,
and the new-pane selection/cancellation path. No unit tests were added for this
CSS-only change. These are browser viewport checks, not physical-phone tests.

Published 2026-10-07T04:50:27.270Z with entry `/assets/index-CJIWM_Ae.js`.
Build and root-file rollback copies are under
`/mnt/cache/build-cache/hapi-workspace-alignment-20261007`.
Hub/native bridge PIDs stayed 3233230/2502589; neither service was restarted.
Candidate geometry was also checked against the real HTTPS Hub at 320, 390
and 1600 px, without modifying user workspaces or sending messages.
The same read-only checks passed on the published HTTPS entry, with zero
line-center offset, page errors or application writes; see
`alignment-published-live.json`.
Evidence is under `/mnt/cache/data-cache/hapi-tmux-implementation`:
`composer-alignment-browser.json`, `alignment-regression.log`,
`alignment-attachment.log` and the `alignment-*.png` screenshots.
