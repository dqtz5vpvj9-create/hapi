# Mobile session workspace destinations

When choosing a conversation in workspace mode, the existing phone session list now shows its current workspace name and pane number, for example `Workspace 1 · P2`. This replaces the flavor/project/machine text within the existing metadata line for conversations already open in a workspace. Execution state and the subagent toggle remain available. Unopened conversations keep their original metadata; desktop rows retain their compact presentation.

The destination comes from the workspace store and uses the same tree traversal as the mobile P buttons and existing-session selection. Rename, close and layout updates therefore refresh the displayed destination. A long workspace name truncates while the pane number remains visible. Selecting the conversation keeps the existing behavior: focus its current pane instead of creating another view.

## Verification

Web typecheck, production build, 14 relevant component tests and five workspace selection browser flows passed. The new browser flow creates and renames a second workspace, checks both workspaces' destinations, selects an existing P2, closes P1, and checks the resulting P1 label after refresh. The other flows cover mobile cancellation with draft and reading preservation, replacing only the focused pane, desktop sidebar focus, and selection when a narrow desktop hides the sidebar.

The production HTTPS browser check matched the deployed entry, validated visible labels against the actual saved layout, checked pane-number width and horizontal overflow, and exercised browser Back, list refresh, return without selection and existing-session selection. The two-pane desktop layout was preserved. No JavaScript errors or workspace writes occurred. A 390×844 production screenshot was captured with webshot and visually inspected: the running `HAPI Tmux` row displayed `Workspace 1 · P2` alongside its subagent toggle. These are browser checks at phone dimensions, not physical-phone acceptance.

## Release

Published **2026-10-06 08:14:07 UTC**, entry **`/assets/index-Culwselw.js`**. Only frontend assets were updated. Hub PID 3233230 and native bridge PID 3233231 were unchanged; no native engine or Windows service was restarted.

Build and previous root files are under `/mnt/cache/build-cache/hapi-workspace-location-20261006/{web,previous-web}`. Existing hashed assets were retained and `index.html` published last. Private logs, browser results and the inspected screenshot are under `/mnt/cache/data-cache/hapi-tmux-implementation/location-*`; these temporary artifacts are subject to cache cleanup.

The larger workspace goal remains open. Terminal development remains paused at the user's request.
