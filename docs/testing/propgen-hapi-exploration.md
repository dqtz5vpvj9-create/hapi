# Property-guided HAPI UI exploration

Date: 2026-10-09. Baseline: `51178180bb3079bc43e37a8271be25628f0570f0`.

## Method and scope

Adapted the exploration loop from [From Exploration to Specification: LLM-Based Property Generation for Mobile App Testing](https://arxiv.org/abs/2604.13463): ground a functionality hypothesis in visible controls; exercise it; record precondition, action, and observed result; turn useful expectations into executable properties; distinguish application failures from incorrect test assumptions. This is a manual adaptation to HAPI's web UI, not an execution of the paper's prototype or a reproduction of its evaluation.

Exploration uses real HAPI React components in local fixtures with simulated sessions/API responses, Chromium at 320, 390, 768, and 1280 pixels, and direct interactive desktop inspection. No real agent, provider inference, external account mutation, or paid model call is needed. Backend execution, live reconnect behavior, actual native-phone keyboards, and other browser engines remain outside this pass.

Visual density and touch geometry are reviewed separately: the paper does not by itself establish aesthetic quality. Compact desktop styling is preserved.

## Findings and fixes

### Cancelling a numeric preference accidentally saved it

- Precondition: Display settings, saved Sessions Before Folding value 8.
- Action: type 17 and press Escape.
- Expected: restore 8, keep it after navigating away or reloading.
- Observed: 17 remained and persisted. Reproduced interactively on desktop and in a failing browser assertion.
- Cause: Escape queued React state restoration, then synchronous blur committed the old draft before the state update.
- Fix: explicitly suppress the cancellation blur; Enter commits once through blur; composing input does not trigger shortcut submission.
- Regression: unit cancellation followed by a normal edit; exactly one clamped Enter commit; browser cancellation and reload on narrow and desktop viewports.

### Mobile workspace chrome was difficult to tap

- Precondition: split workspace in a 320/390px viewport.
- Observed: bottom navigation was 35px tall, nested pane menu 28px square, and composer controls approximately 22–27px tall. Later CSS overrode an earlier 44px mobile rule.
- Fix: 44px navigation height, 40px composer control height, minimum 32px widths, including the nested pane menu. This is a deliberate compact compromise, not a claim that every target meets a 44×44 standard.
- Regression: inspect actual visible control bounds and document overflow at four viewport widths; exercise suggestions and menus after resizing.

### Shell launcher noise in command summaries (user-reported)

- Precondition: a PowerShell command stored as a string or argument array.
- Observed: executable path and `-Command` consumed the one-line summary.
- Fix: unwrap recognized PowerShell command forms for display, keeping the original tool input and output in details; leave unknown/encoded/file invocation forms intact.
- Regression: parsing cases plus narrow/desktop rendered summary and expanded-detail checks.

## Explored properties and negative findings

| UI hypothesis | Exercise | Outcome |
| --- | --- | --- |
| Rename accepts Enter | Rename a window to Review window and press Enter | Passed; no change needed |
| Rename cancels Escape | Type another title and cancel | Original title retained |
| Window switching is discoverable | Open Switch window | Current window and pane count visible |
| Settings preserve tmux context | Open Settings and return | Workspace restored |
| Pane menu exposes its actions | Open pane menu | Split, maximize, move, close and conversation actions available |
| Maximize is reversible | Maximize then restore | Split panes return |
| Expanded composer preserves draft | Type Chinese draft, expand, Done | Draft retained |
| Closing a window offers recovery | New window, close, Restore closed window | Window restored |
| Narrow layouts avoid page overflow | Inspect 320/390/768/1280px | Baseline no page-level horizontal overflow |

The reusable browser property also combines editor collapse, window creation, close, draft recovery, and restore. Existing regression suites cover fork/steering, scratch list, workspace mode persistence, pane/window navigation, and autocomplete.

## Test refinement, not product bugs

- Mobile Settings categories include their current-value summary in the accessible name. An exact `Display` locator missed the control. Changed the property to accept the actual label; this was a test precondition failure, not a second application defect.
- Window actions use a dialog, whereas pane actions use a menu. A menu-only inspection timeout did not indicate a broken window action.
- Touch assertions originally missed a nested pane-menu CSS override; measured bounds exposed it and the override was fixed.

- Mobile creation of an empty window intentionally opens the session picker. The round-trip property uses the visible Back to workspace control before checking its empty window, rather than assuming desktop presentation.

## Running the regression

Use the repository's normal Playwright setup, then:

```sh
bun run --cwd web test src/routes/settings/index.test.tsx src/lib/codex-command-label.test.ts
bun run --cwd web typecheck
bunx playwright test e2e/propgen-exploration.spec.ts e2e/codex-command-presentation.spec.ts
```

Machine-local browser executable paths and local runner configurations are intentionally not part of the change.
