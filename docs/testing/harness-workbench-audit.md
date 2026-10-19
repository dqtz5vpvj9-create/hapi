# Harness and file workbench audit

Inspected and implemented on 2026-10-18, starting from HAPI
`138469f4056137ede2f16eb1c149daf8396bb95c`.

## Sources and implementation scope

The reference revisions are pinned so the comparison is reproducible:

- [DeepSeek Harness `687f282`](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317), version `0.2.1-rc.2`.
- [DSH better sidebar `83faf70`](https://github.com/omdsh-dev/DSH-better-sidebar/tree/83faf70940160e5cd4c5332f5400aa8f4dbbb6d6), version `0.28.0`.

The implementation uses HAPI's existing authenticated HTTP/RPC boundaries,
document identity, IndexedDB drafts, compare-and-swap writes, tool registry and
localization. Source mappings and retained MIT licenses are in
`web/src/components/SessionFiles/UPSTREAM.md` and
`web/src/components/ToolCard/dsh/UPSTREAM.md`.

| Area | Implemented behavior | Primary checks |
| --- | --- | --- |
| File navigation | Lazy tree, persisted expansion, search without unmounting the tree, hidden/exclusion filters, name/time/size sorting, current-file reveal, touch menus and range selection | `DirectoryTree.test.tsx`, files route tests, real file-workbench browser spec |
| File management | Inspect source revision; create, rename, move, copy, delete, binary download, file/folder upload and dropped-folder traversal | Shared schemas, actual CLI filesystem tests, authenticated Hub route tests, independent browser filesystem fixture |
| File workspace | Session tabs, full path display/copy, return to the exact expanded tree row, resizable side-by-side layout and phone tree/editor switching | Store/ownership tests and desktop/390px browser acceptance |
| Draft ownership | One physical-file owner across conversations; safe subtree relocation, inactive tab reconciliation, independent editor views, local draft retention and revision conflicts | Document session tests, actual CodeMirror tests and shared-files browser cases |
| DSH lifecycle | Advertised resume/close and HTTP MCP capabilities, exact resume identity, cancellation barrier and next-prompt configuration; official launcher/discovery corrected in the [DSH follow-up](./dsh-agent-discovery.md) | ACP transport, launcher, config, resume and Hub namespace tests |
| DSH model controls | Only advertised model/reasoning values; grouped options, provider default and next-message explanation | Actual composer/picker tests and config contract tests |
| Background tasks | Task-ID state transitions recorded with real agent ingress; durable terminal states, explicit detach and restart recovery | SQLite reopen/transaction tests, socket ingress and session status tests |
| Commands | Bounded first/last output lines, error priority, expandable complete details and original copy text | Command presentation and actual card interaction tests |
| File changes | Authoritative completed changes, completed-only attachment, per-file/per-hunk ranges, correct line numbers, move/no-newline annotations and raw fallback | Native converter/projection and actual ToolCard registry tests |
| Search | Structured file groups, match line numbers, explicit server truncation, expandable bounded results and complete copying | Grep/Glob model and component tests |
| Native child agents | Read-only lineage-scoped transcript, structured calls/results, Markdown, reasoning summaries, byte-cursor paging and foreground incremental refresh | Actual native SQLite/rollout tests, CLI RPC, Hub HTTP, controller and real dialog tests |
| Chat updates | Publish only changed/removed native message sources; preserve reentrant updates | Publication spies, unchanged source identity and reentrant/removal tests |
| Engineering checks | Staged build smoke, actual Hub/SSE reconnect cohorts and strict finite model replay | `test:realtime-cohort`, native full-stack fixture and CI integration |

## Bugs found and fixed

### Files and editing

An open file previously exposed its path mainly through a title/tooltip. The
document now has a selectable full-path row, clipboard action, visible copy
feedback and a return-to-tree action. Returning expands the containing folders,
selects the row and scrolls it into view while retaining an unsaved draft. The
same target can be revealed repeatedly, including through a workspace pane.

Filesystem success and UI success are separate. A recursive delete may remove
some entries before a concurrent change prevents the rest. A move may commit
before its metadata refresh fails. The API reports verified `deletedPaths` or
the committed move; the browser reconciles those exact changes before displaying
the failure. It never presents a partial operation as a complete success.

Cross-review reproduced and fixed these additional browser failures:

- Deleting a previously opened clean file and creating the same path displayed
  the old cached bytes/hash. The cache now invalidates its disk identity and
  reads the new bytes. A deliberately retained draft survives and is compared
  with the new file before a save.
- A successful operation after leaving conversation A could navigate the user
  away from B. Settlement now updates the original document/tab references
  without allowing an inactive or unmounted view to change the current route.
  The operation keeps its guards until settlement.
- Tabs retained in an inactive conversation could keep a moved/deleted path.
  Reconciliation includes validated layouts under the same browser account
  scope and matches the physical machine and path components.
- Reopening and closing a workbench again before an old rename settled could
  let that old instance overwrite newer tabs, selection and tree width. The
  operation now transforms the latest persisted layout and updates every
  mounted reader's references without each reader replacing that layout.
  Empty or explicitly removed layouts do not resurrect old tabs. DOM tab IDs
  are also scoped to their workbench instance so keyboard focus stays in the
  initiating pane when a session appears more than once.
- Two mounted CodeMirror views could keep different text for one shared file,
  allowing a later keystroke to replace the other pane's draft. Views now apply
  the originating changes, without republishing synchronized changes or adding
  another pane's edits to local undo history. Retained editor state calls the
  current view's save handler.
- Opening A's cached physical file in B inherited A's reference destination and
  RPC route. The workbench now uses the initiating conversation for selection
  references, reads, saves, reloads and metadata checks while sharing file bytes.

POSIX filenames containing a literal backslash remain distinct from Windows
path separators. Filename operations cannot overwrite an existing destination;
directory moves cannot target their own subtree. Symlink targets are never
traversed by file management.

### Native execution and history

Completed Codex file-change events can contain changes absent from the start
event, including when HAPI attaches after the start. The converter now preserves
the final payload, and the Web presentation uses it even when it is an empty
change set. Separate file and hunk ranges are retained instead of reconstructing
a fictitious dense file from excerpts.

Native child transcript paging initially confused a gap before the first
displayable record with locally trimmed history. A metadata-only earlier page
could therefore be requested repeatedly. Only actual removal from the head of
the retained window now changes the server's earlier cursor. Regression tests
cover an empty first page, a non-display gap and tail trimming during older-page
navigation.

The actual native full-stack run found a fork creation bug: an operation had a
fixed child ID but no preallocated Hub session row. Treating that ID as a machine
spawn stub sent `adopt:true` and failed with HTTP 404. Fork creation now uses a
distinct internal `newSessionId` path with UUID/identity validation. Machine
spawn continues to require its existing reserved stub. Namespace, tag and
existing-row conflict checks remain enforced by the actual Hub create route.

Background counts no longer increment/decrement from repeated text markers.
The schema-33 task table records task identity and terminal tombstones in the
agent-message transaction. Completion-before-start, duplicate starts and
terminal replay are idempotent. A temporary disconnect hides the active count
without claiming completion; an explicit session end records `detached`.
Imported/forked historical messages do not acquire ownership of old processes.

## Test assumptions corrected with evidence

No test suite was removed to make this work pass. In particular, the legacy
CodexDiff wrap/preview interaction test was retained and its controls restored.
Updating the workspace navigation fixture supplies the real locale/context and
its ResizeObserver boundary; its route and repeated-reveal assertions remain.

Two assumptions in the native full-stack fixture were demonstrably too broad:

1. A newly attached alternate-screen terminal paints its current viewport. The
   test now checks the latest restored interaction there and separately checks
   that the earlier shared input remains in authoritative native history.
2. An unpaginated `/messages` request is the latest page, not all history. In the
   successful Codex 0.163.0 run, two reads of `snapshotHeadSeq=78` returned:

   | Request | Returned range | Count | `hasMore` | Plan cards |
   | --- | --- | ---: | --- | --- |
   | Default `limit=50` | seq 29–78 | 50 | true | Newer plan only |
   | Full bounded read | seq 1–78 | 78 | false | Both original IDs, once each |

The fixture follows real cursors with a finite ten-page ceiling and rejects
missing/repeated cursors or an epoch reset. It does not deduplicate rows or
weaken the exactly-once assertions. Its model boundary consumes exactly 21
scripted interactions; one separately validated title request does not consume
a conversation step. The final successful native receipt has
`consumed=21`, `expected=21`, `auxiliaryTitles=1`, `failures=[]`.

## Verification and practical limits

Run the complete repository gate with `bun typecheck && bun run test`. Run
`bun run gen:fixtures` for any generated fixture changes; none were hand edited.
The file browser spec and existing dependency UI lane run together via
`bun run test:dependency-ui file-workbench.spec.ts`.

Build the final sources with `bun run build:hub`, then run
`bun run test:realtime-cohort` and `bun run check:bundle`. The artifact runner
launches a staged compiled Hub/Web copy outside the source tree. It verifies
login, actual JS/MIME, deep links and persisted settings before exercising real
SSE disconnect/replay and gap recovery. See
[artifact-checks.md](../../scripts/testing/artifact-checks.md) for receipts and reproduction.

The native process gate is opt-in:

```sh
cd cli
HAPI_RUN_SHARED_CODEX_TESTS=1 bunx vitest run src/codex/shared/frontend.integration.test.ts
```

Use a POSIX host with Python 3 and an installed real Codex CLI on `PATH`. This
audit ran official Codex `0.163.0` with an isolated home, a local scripted
Responses server, actual Runner/MCP/Hub sockets and the native terminal. It does
not require model credentials; this terminal test skips Windows.

### Recorded validation

The full repository gate completed successfully on Linux with Bun `1.4.3` and
Node `24.19.0`. The repository's `packageManager` and CI pin remain `bun@1.4.0`;
the local receipt reports the actual tool version rather than claiming that pin
was exercised locally.

| Gate | Passing tests | Skipped tests |
| --- | ---: | ---: |
| Mobile packaging/update scripts | 36 | 0 |
| CLI | 3,064 | 12 |
| Hub | 1,607 | 3 |
| Web | 4,714 | 0 |
| Shared | 363 | 0 |
| Relay | 118 | 0 |
| Cross-package integration | 62 | 0 |
| Browser harness unit tests | 32 | 0 |
| Combined dependency UI and file workbench Chromium acceptance | 59 | 0 |

The final layout-settlement follow-up added seven regression cases. After that
fix and the instance-scoped DOM IDs, the complete Web suite was rerun:
**4,721 passed across 428 files**, with no skips or failures. Web typechecking
also passed, and the complete **11/11 file-workbench browser lane** passed again,
including the strengthened A-to-B-to-A rename case. The other packages' sources
did not change after the successful full gate above.

The 15 default-gate skips are existing opt-in/environment/platform gates, not
new skipped failures. The real shared Codex frontend gate was enabled and passed
separately, consuming all 21 scripted interactions. Cursor's credentialed legacy
migration and other unavailable external/platform lanes remain unverified.

All four typechecks passed. Fixture regeneration produced no drift. The built
Hub/Web smoke and real reconnect cohort passed with Chromium `156.0.8078.4`:
buffered replay returned `ok`, overflow returned `gap`, each final stream retained
one canonical row, and cross-namespace REST/SSE returned 403 with zero leaked
events. The explicit notify subscription received events with zero message
bodies. The existing global full subscription still carries bodies, as its
contract requires. The bundle budget passed without a dependency or lock update.

The remaining bounds are explicit:

- File transfer is limited to 64 MiB per file and recursive management snapshots
  to 20,000 entries. File tabs are limited to 16 per conversation; at most five
  reader DOMs remain mounted in each workbench.
- No-clobber move/rename is implemented for Linux and Windows. macOS and
  cross-device moves return an explicit unsupported error. Windows native
  behavior was not exercised on a Windows host in this Linux audit.
- Folder pickers cannot provide empty directory entries. This work does not add
  directory watch sockets, archive jobs, external native editors or the separate
  plugins listed by the sidebar project.
- Native child details are read-only, bounded to 400 messages and 2,097,152
  serialized UTF-16 code units in the Web window, with per-field truncation
  notices and older/latest navigation. They
  do not start or resume a child engine. Older runners retain their compatible
  tail-reading behavior until upgraded.
- File-change details cover start/final completion payloads; they do not claim
  to display every intermediate `patchUpdated` event.
- DSH capability/configuration behavior was checked against official source and
  protocol fixtures, not a paid live DSH model account. macOS/iOS/Android device
  builds were not run. Existing native-update UI and packaging tests remain in
  the regression gate; this change adds no native plugin dependency.
- Dirty-source publication reduces subscriber work; projection construction
  still scans its bounded input window. Cohort timings are single-run recovery
  observations, not a before/after speedup or a physical-phone benchmark.
