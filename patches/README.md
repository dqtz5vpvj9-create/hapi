# Dependency patches

`@assistant-ui/react@0.15.21` needs to validate the animator's current text
when smoothing becomes enabled. HAPI displays hydrated messages without an
animation, then enables animation when their text starts changing. In that
transition, the animator can retain the old full text while its target is
empty. An equal-length replacement then clears the rendered paragraph but
never commits another animation frame; a shorter replacement keeps scheduling
frames without displaying text.

The patch resets that discontinuous cursor using the existing reset path. It
applies to both the TypeScript source and the JavaScript shipped by the package.
Bun applies it through the root `patchedDependencies` entry.

When upgrading this dependency, run `e2e/typing-replay.spec.ts`, including the
hydrated-response replacement cases, before removing or adapting the patch.
Those cases must begin with complete text in a running session and then update
the same message; mounting an already-streaming message does not expose this bug.

`@tanstack/router-core@1.171.6` retains scrolled DOM elements in a strong map
until route navigation. HAPI workspaces replace chat panes on the same route,
so this retains every previously scrolled pane. The patch removes disconnected
targets when a new scroll target is registered. Connected elements keep their
positions, and an existing target's scroll events do not scan the map.

This is applied to TypeScript and both shipped JavaScript entry points. When
upgrading Router, run the DOM collection case in
`e2e/workspace-lifecycle.spec.ts`, the working-set benchmark, and list/history
navigation regression before removing the patch. Heap retaining paths and the
measured comparison are recorded in
`docs/operations/2026-10-06-workspace-working-set.md`.
