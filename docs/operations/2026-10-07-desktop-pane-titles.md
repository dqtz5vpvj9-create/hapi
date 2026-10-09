# Desktop pane titles

The bottom pane strip was guarded by `mobile`, leaving desktop users with only
P＋ and the window tabs. Desktop now shows each pane's number, resource title,
and chat activity dot. Clicking a title focuses its editor; the strip remains
available when a pane is zoomed. Phone layouts keep compact P1/P2 labels.

Long titles truncate with their full title available on hover. The pane strip
scrolls independently, keeps the focused pane in view, and reserves room for
P＋ and the window tabs. Wheel input over the pane strip scrolls titles instead
of switching windows. Reader mounting and history loading are unchanged.

## Validation

- Release-source web typecheck and production build passed.
- Eight navigation browser cases passed: desktop focus and zoom, title overflow,
  desktop/phone transitions, immediate window creation, window switching, and
  shortcuts beside nonmodal feature tips.
- Three history cases passed: four long-code readers through resize/zoom/mobile,
  and repeated mobile pane returns with native and mixed message renderers.
  Warm returns retained reader/editor DOM and measured zero scroll drift.
- Desktop light/dark and phone screenshots were opened and visually checked.
- The candidate connected to the real HTTPS API and focused all three existing
  panes. No page errors or layout/message writes were observed.

Browser fixtures are isolated; these checks are not a claim of physical-phone
or sustained-frame-rate acceptance.

## Release

Built from the currently deployed document release snapshot, with only
`WorkspaceShell.tsx` and `workspace.css` changed in production source. The
backend now uses workspace protocol 2; the older protocol-1 navigation snapshot
was not used. The shared checkout retains other sessions' ongoing changes.

- Source/build: `/mnt/cache/build-cache/hapi-pane-titles-20261007`
- Published: 2026-10-07 13:13:18 UTC
- Entry: `/assets/index-BkmrZUH4.js`
- Previous entry: `/assets/index-HyM713op.js`
- Previous root assets: build directory's `previous-web`
- Evidence: `/mnt/cache/data-cache/hapi-tmux-implementation/pane-titles-*`
- Hub/native PIDs remained 4057369/4057372 across frontend publication.
- Post-publication HTTPS browser verification confirmed the new entry, all three
  desktop pane titles and distinct focus targets, and 390/320px mobile bounds;
  no page errors or layout/message writes were observed.

Old hashed assets remain available for existing clients. No backend restart or
workspace schema change was performed by this release.
