# DSH tool presentation adaptations

Reference: https://github.com/deepseek-ai/deepseek-harness

Revision: `687f282e8625c6b8d11ff58211a90524be2e4317` (`0.2.1-rc.2`, inspected 2026-10-18).

- `packages/client/ui-primitives/src/head-tail-cap.ts` and `TerminalBlock.tsx`:
  the command summary retains its first and newest output lines, with an explicit
  hidden-middle marker. HAPI keeps its two output-line budget, failure diagnostic
  priority, ANSI handling, Unicode-safe character cap and full original clipboard
  source. Its scan retains line offsets instead of allocating every log line.
- `packages/client/ui-deliverables/src/client/FileDiff.tsx`, `hunkRows` and
  `renderedHunks`: retain separate file/hunk ranges and number each side from its
  source offset. HAPI adds no-newline annotation rows and keeps an original-data
  fallback; it uses its existing `diff` dependency for patch parsing. The rendered
  comparison is capped at 5000 rows, while the full source remains copyable.
- `packages/client/ui-primitives/src/SearchBlock.tsx` and
  `packages/client/ui-tool/src/client/tool/models/search-card-model.ts`: grouped
  file matches, line numbers, explicit upstream truncation counts, folded groups,
  full-result copying, and a restored owning file header at the tail of a capped
  list. HAPI adapts these concepts to its existing Grep/Glob registry. Plain-text
  adapters only accept the known path-list and `path:line:text` forms; unknown,
  count, error and contextual formats retain the original renderer. Inline
  previews stay noninteractive; the full tool dialog owns folding/copy controls.

The adapted hunk-row and search head/tail algorithms are covered by the MIT
license retained in this directory. The UI and lifecycle adapters use HAPI's
existing components, localization, dependency hydration and scoped tool identity.

## Codex input contract

The active native path is `item/started` / `item/completed` →
`AppServerEventConverter` → `SharedCodexProjection` → `CodexPatch`. Completion
retains authoritative changes even when no local start was observed. Stable
tool/message IDs deduplicate repeated completions and reconnect history.

Source definitions were checked at official `openai/codex` revision
`8c076942cb70fba8e5c4732c23f1faabc4aed484`:

- `codex-rs/app-server-protocol/schema/typescript/v2/FileUpdateChange.ts`:
  `{ path, kind, diff }`.
- `codex-rs/app-server-protocol/schema/typescript/v2/PatchChangeKind.ts`:
  add/delete/update, with optional `move_path` on update.
- `codex-rs/protocol/src/protocol.rs`: legacy `FileChange` add/delete content,
  update unified_diff, and `PatchApplyEndEvent.changes`.
- `codex-rs/app-server-protocol/src/protocol/item_builders.rs`,
  `build_file_change_end_item`, `convert_patch_changes`, `format_file_change_diff`:
  completion supplies the final changes; add/delete `diff` is literal file
  content, while update is a unified diff followed by the exact optional
  `\n\nMoved to: <path>` display annotation.
- `codex-rs/tui/src/app_server_approval_conversions.rs`,
  `file_update_changes_to_display`: confirms that annotation is stripped only
  when the advertised move target matches.

Unrecognized values are shown as original text/JSON. The shared hunk reader also
replaces the old `CodexDiff` display algorithm; that legacy constructor's native
runtime reachability was not established, so it is not treated as a live-path bug.

## Focused verification

- `commandPresentation.test.ts` and `CommandCard.test.tsx`: bounded head/tail,
  appended streaming output, error priority, full copy, hydration and modal state.
- `patchPresentation.test.ts`, `views/CodexPatchView.test.tsx`: two files sharing a
  basename, separated/non-line-one hunks, legacy/v2 add/delete/update formats,
  move annotations, no-newline markers, authoritative empty snapshots, unknown
  values and bounded rendering.
- CLI `appServerFileChanges.test.ts` and shared `fileChanges.test.ts`: authoritative
  completed payloads, completed-only attachment, final error status and stable
  repeated/reconnect projection in root and child traces.
- `searchPresentation.test.tsx`: file grouping, duplicate matches, truncation and
  recovery text, raw fallback, exact head/tail row budget, folding and full copy.

These are local source/fixture and component tests. They do not claim an external
Codex/DSH service was called or a new performance benchmark was established.
