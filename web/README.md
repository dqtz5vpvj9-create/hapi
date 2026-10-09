# hapi-web

React Mini App / PWA for monitoring and controlling hapi sessions.

## What it does

- Session list with status, pending approvals, todos, and summaries.
- Chat view with streaming updates and message sending.
- Permission approval and denial workflows.
- Codex `request_user_input` choices honor `isOther`: **None of the above**
  focuses optional notes, supports empty notes, and preserves the canonical
  wire value across languages. Recorded other answers and notes remain visible
  in live and historical cards; Pi/MCP forms without the flag are unchanged.
- Permission mode and model selection.
- Machine list and remote session spawn.
- File browser and git status/diff views.
- PWA install prompt and offline banner.
- Optional unread-session count on the Windows taskbar when installed as an Edge/Chrome PWA (toggleable in Display settings; off by default).

## Runtime behavior

- When opened inside Telegram, auth uses Telegram WebApp init data.
- When opened in a normal browser, you can log in with `CLI_API_TOKEN:<namespace>` (or `CLI_API_TOKEN` for the default namespace).
- The login screen includes a top-right hub picker; if unset, the app uses the same origin it was loaded from.
- Live updates come from the hub via SSE.
- Session `@` suggestions require conversation content, including untitled conversations. Names and directory labels affect display/search, not eligibility; empty stubs stay excluded.

## Routes

See `src/router.tsx` for route definitions.

- `/` - Redirect to /sessions.
- `/sessions` - Session list.
- `/sessions/$sessionId` - Chat interface.
- `/sessions/new` - Create new session.
- `/sessions/$sessionId/files` - File browser with git status.
- `/sessions/$sessionId/file` - File viewer with diff support.
- `/sessions/$sessionId/terminal` - Terminal interface.
- `/browse` - Workspace browser, enabled by the runner's configured workspace roots.
- `/share` - Share-target landing (Web Share Target POST → `?id=`, or native `/share#url=&text=&title=`).
- `/settings` - Settings category hub (mobile) and responsive master-detail shell.
- `/settings/general` - Language preferences.
- `/settings/display` - Appearance, typography, colors, and session list preferences.
- `/settings/chat` - Message input, tool card, and conversation color preferences.
- `/settings/voice` - Everyday voice assistant preferences.
- `/settings/voice/voices` - Full-page voice picker.
- `/settings/voice/advanced` - Voice persona, tuning, and diagnostics.
- `/settings/machines` - Machine management and runner status.
- `/settings/storage` - SQLite storage sizes for the hub owner.
- `/settings/usage` - Cache-aware token usage dashboard for the hub owner.
- `/settings/about` - Application links and version information.

## Features

### Session list (`src/components/SessionList.tsx`)

- Quick session switcher: Ctrl/Cmd+K or **Switch** in the list toolbar; search
  titles, paths, machines, agents, and IDs, then use arrow keys and Enter to open.
- Active/inactive status indicator.
- Session title from name, summary, or path.
- Todo progress display.
- Pending permission request count.
- Agent name and model display.

### Chat interface (`src/components/SessionChat.tsx`)

Desktop session lists use one 34px row per conversation across themes. Device
and path details are available on hover, and the subagent disclosure arrow sits
beside the parent title. Child conversations use the same single-line layout.
Touch layouts retain their existing row sizes.

Each desktop row reserves a fixed status slot: `!` for permission, `?` for user
input, a spinner for working, an open circle for background tasks, and a dot for
unread activity. Pending requests remain visible when selected or thinking.
Unread activity is not labelled as successful completion. Recent-list ordering
stays chronological so a status update does not independently move a row.
The adjacent machine icon is randomly assigned once by the Hub, avoiding icons
already used in that namespace, and persisted in machine metadata. Reconnects,
Runner metadata updates, and renames preserve it. Filters show the same icon
with the machine name; browsers cache the identity for offline machine rows.

The Codex theme has a desktop layout at the existing 920px split breakpoint.
Navigation occupies a quiet sidebar with text tabs, a machine picker and a
floating new-task input. The conversation and composer fill the right pane,
sharing responsive side gutters with the header. The three header surfaces
place back/title on the left and actions on the right. The default sidebar width is 320px;
previously saved user widths remain in effect and can still be dragged.
The glass title surface shows only the session name and device identity. Model
and reasoning controls stay in the composer; the classic header and shared-turn
metadata continue to use the configurable metadata preferences.

The layout follows Apple's [Liquid Glass material guidance](https://developer.apple.com/design/human-interface-guidelines/materials)
and [navigation-layer principles](https://developer.apple.com/videos/play/wwdc2025/219/):
controls carry the material treatment and message content remains visually quiet.
`src/themes/codex-desktop.css` contains the desktop rules. It retains the existing
scroll owner, virtual rows, and measured header/composer insets; width changes
are handled by the existing measurement and reading-anchor machinery. This is
a web adaptation of the design principles, not Apple's native renderer.

- Message thread with infinite scroll.
- Composer for sending messages.
- Permission mode and model selection for supported agents.
  Cursor Auto uses CLI Auto for new/resumed sessions configured with Auto. When ACP does not advertise a literal Auto option, the session picker warns that switching back from a concrete model requires a restart; HAPI does not automatically restart an active session.
- Session abort and handoff controls.
- Codex **Continue planning** hides the current proposal's action menu locally
  and focuses the composer without sending a message or replacing its draft.
  The plan document remains readable; recycled cards stay dismissed and new
  proposals get fresh action menus.
- Context size display.
- Per-session scratchlist (`src/components/AssistantChat/ScratchlistPanel.tsx`)
  - Workbench panel for held notes/drafts; **distinct from the queue**.
  - Add/delete/reorder entries; promote to composer (copy) or queue (send).
  - Entries and attachments saved on the hub and synced across devices.
  - Reordering affects only the current view and resets when entries refresh.
  - Keyboard shortcut: Ctrl/Cmd+Shift+S to focus the add-input.

### File browser (`src/routes/sessions/files.tsx`)

- Git status view (staged/unstaged files).
- File search with ripgrep.
- Navigate to file viewer.

### File viewer (`src/routes/sessions/file.tsx`)

- File content display with syntax highlighting.
- Staged/unstaged diff view.

### Terminal (`src/routes/sessions/terminal.tsx`)

- Remote terminal via xterm.js and Socket.IO `/terminal`.
- Mobile interaction adapted from [TermBeam](https://github.com/dorlugasigal/TermBeam):
  collapsible touch bar, held navigation keys, editable shortcuts, momentum
  scroll, pinch font sizing, and selectable scrollback for copy.
- Keys are saved in the current browser. Whole-command editing remains optional.
- Source revision, adaptation notes, and MIT license are retained in
  [`src/components/Terminal/termbeam/`](src/components/Terminal/termbeam/UPSTREAM.md).

### Voice assistant

- ElevenLabs (@elevenlabs/react), Gemini Live, and Qwen Realtime backends
- Real-time voice control
- Standard and realtime composer dictation with provider capability selection

### New session (`src/components/NewSession/`)

Modular session creation:

- Machine selector
- Directory input with recent paths
- Agent type selector
- Model selector
- Per-agent permission, effort, and collaboration controls when supported

### First-User-Experience (FUE)

For a new, non-essential feature whose affordance would otherwise be hard to
discover, consider the existing FUE primitive rather than a permanent UI block.
Optional, not a requirement for every feature or a reason to expand a bug fix.

- `src/lib/use-fue.ts`: `useFue(featureId)` returns `{ status, engage, dismiss }`; acknowledgement is isolated per feature in `hapi.fue.v1.<featureId>` localStorage keys.
- `src/components/Fue.tsx`: `FueDot` marks the affordance; `FueCallout` explains it while `status === 'engaging'`.
- Dismissal requires an affirmative user action ("Got it"), never an auto-timeout.
- The FUE dot and feature-specific badges/counters are mutually exclusive; onboarding wins until acknowledged.
- Opt in per feature; skip the wrapper if an upstream component already supplies onboarding.
- Working example: `ScratchlistToggleButton` in `src/components/AssistantChat/ComposerButtons.tsx`. Use the source rather than maintaining a copied example here.

## Authentication

See `src/hooks/useAuth.ts` and `src/hooks/useAuthSource.ts`.

- Telegram Mini App: Uses initData from WebApp SDK.
- Browser: Uses CLI_API_TOKEN from login prompt.
- JWT tokens with auto-refresh.

## Data fetching

See `src/hooks/queries/` for query hooks and `src/hooks/mutations/` for mutations.

- Sessions, messages, machines via TanStack Query.
- Git status and file operations.
- Optimistic updates for message sending.

## Real-time updates

See `src/hooks/useSSE.ts`.

- SSE connection to `/api/events`.
- Session/message/machine update events.
- Automatic cache invalidation on events.

## Stack

React 19 + Vite + TanStack Router/Query + Tailwind + @assistant-ui/react + xterm.js + @elevenlabs/react + socket.io-client + workbox + shiki.

## Source structure

- `src/router.tsx` - Route definitions.
- `src/components/` - UI components.
- `src/hooks/` - Data fetching and state hooks.
- `src/api/client.ts` - API client.
- `src/types/api.ts` - Type definitions.

## Development

From the repo root:

```bash
bun install
bun run dev:web
```


If testing in Telegram, set:

- `HAPI_PUBLIC_URL` to the public HTTPS URL of the dev server.
- `CORS_ORIGINS` to include the dev server origin.

## Tests

Unit tests run under vitest + jsdom:

```bash
bun run test:web
```

End-to-end browser tests for the scratchlist component (real Chromium, real
`inert` focus blocking, real localStorage round-trips) live at the repo root
under `e2e/`:

```bash
bun run test:e2e          # headless
bun run test:e2e:ui       # Playwright UI mode (debug)
```

The spec drives a Vite-served fixture page (`web/e2e-fixtures/scratchlist-fixture.html`)
that mounts the production `ScratchlistPanel` in isolation, so no hub /
auth / socket setup is required.

## Recent session switching

Native Codex keeps the presentation of the five most recently opened sessions
in memory: prepared message nodes, disclosure state and measured row heights.
Switching back opens its latest cached content. The existing global SSE feed
keeps recent sessions warm in the background: change notifications are
coalesced into one bounded read at a time, with no idle polling. Foreground
loads take priority. Preloading pauses while hidden, offline, on 2G or in data
saver mode, and slows on 3G. Reloading the current page and returning from its
file/terminal view keep the existing bookmark behavior.

The cache follows the API client's authentication
lifetime; a history epoch change clears disclosure and geometry for that
session. This presentation cache retains no hidden chat DOM and writes no
additional transcript. The workspace view separately keeps a bounded set of
mounted readers and editors so returning need not reconstruct them.
Evicted sessions use the existing loading paths.
Browser coverage is in [the captured-history runner](../scripts/testing/tester-army/README.md).

## Workspace view

The session sidebar's view-mode button opens the tmux-style workspace. This
is independent of the selected visual theme. Its tabs are called **windows**
in the UI, matching tmux: each window holds chat and terminal panes, with
drag-to-split, resize, directional focus and temporary maximize. The store and
API continue to call these workspace documents; this is not an extra hierarchy.
The bottom bar switches windows and returns to a single chat.
Selecting an already open chat focuses its existing pane. On narrow screens,
P1 / P2 controls project one pane without changing the saved desktop layout.
The bottom bar's persistent `P＋` opens a new pane through the existing session
list (or desktop sidebar). It reuses a focused empty pane when selection was
cancelled. **New window**, available in Window actions or with Ctrl-b c,
creates a window immediately and opens the existing session chooser (on desktop,
it focuses the sidebar search). It does not ask for a name first; rename a tab
later by double-clicking it or using Window actions. Existing saved names remain
unchanged. The tab shows only the name; pane counts belong in the window switcher.
Directional splits remain in Pane actions and the existing shortcuts.

The keyboard prefix is Ctrl-b: `%` splits right, `"` splits below, arrows move
focus, `o` cycles panes, `z` toggles maximize, `x` closes a view, `c` creates a
window, and `n` / `p` or `1`–`9` switch windows. Press Ctrl-b twice to
send the second one to a terminal.

Workspace structure is synchronized through the Hub, scoped to the authenticated
namespace. The browser keeps a local snapshot and a serialized pending-operation
outbox for offline use; reconnect reconciles revisions instead of overwriting
another device's layout. Focus, active window and zoom remain device-local.
Layouts store references, not chat transcripts. Visible chats share the existing global event stream and retain
their presentation caches. The active workspace and up to four inactive pane
views stay mounted, keeping five single-pane workspaces or three two-pane
workspaces ready. The immediate previous workspace is always retained even if
it alone exceeds that inactive budget, preserving alternation between two large
layouts. Other views are evicted in least-recently-used order; their drafts and
semantic reading bookmarks survive. The budget reserves all panes in each
retained layout, including on mobile and while maximized. A phone pane loads
on its first visit, then keeps its reader and editor mounted when switching
P1/P2. Hidden panes preserve their own last visible dimensions, so FlexLayout's
maximization does not collapse or resize their virtual readers. Hidden panes
and stages are inert and cannot claim focus or mark a conversation read.
Message synchronization on return runs behind the retained view. This bounds
mounted readers, not total browser memory or cold-load latency.
The workspace composer places its attachment picker directly to the left of
the input. The status row keeps a separate `@` action for session references;
the ordinary single-chat composer retains its existing Add menu.
Closing a pane does not issue a stop request. Terminal panes reattach using
stable IDs, but still inherit the existing session terminal's idle and process
lifetime limits. Shared layouts use the Hub workspace API and SSE invalidation. A durable
machine-level terminal host remains a separate stage; see
[implementation status](../docs/plans/tmux-workspace-stage-one.md).

`e2e/workspace.spec.ts` drives the production App and chat components through
`web/e2e-fixtures/workspace-fixture.html`, using simulated Hub responses and
events without model calls. Run it with `bun run test:e2e e2e/workspace.spec.ts`.

## Chat media and documents

Codex chat preserves the order of text, images and audio in user messages and
tool results. Generated images and MCP resources also appear in restored
history. Images support zoom; audio and video use browser playback controls.
PDF files have page navigation, and Markdown, CSV, JSON and text files have
inline previews. Other files remain downloadable.

The hub stores resource references, while the agent reads bytes when a preview
is opened. Uploaded files retain their existing upload lifecycle. If the agent
is offline, the original file was deleted, or a resource exceeds the 25 MiB
limit, the card explains why the preview is unavailable and offers retry.

HTML and HTM documents open in Preview mode in the existing document pane;
Source uses the existing editor and version-checked save flow. Mixed line
endings prevent source writes, but do not prevent HTML preview. HTML exceeding
the 4 MiB editing limit remains previewable within the 64 MiB file read limit.

The preview keeps the report's styles and local JavaScript in an opaque-origin
iframe. Relative CSS (including imports), scripts, fonts and images use the
original session's authorized file reader. Images and responsive image
candidates load when they approach the viewport. Windows file URLs, UNC paths,
extended-length paths and percent-encoded filenames resolve on the original
machine; file links open beside the document in the same workspace. Same-page
anchors stay inside the preview. Parent-page access, network requests, nested
frames, form submission and MCP app callbacks remain unavailable. This is a
local report preview, not a development server for networked SPAs or module
import graphs. Browser codec support determines playable media formats.

Pane and workspace switches, and Preview/Source switches without edits, retain
the iframe. After a remount or explicit reload of unchanged HTML, the bridge
restores scroll, details and ordinary form fields; password and file inputs
are excluded. Arbitrary application-internal JavaScript state is retained only
while the iframe remains mounted. Each document's resource cache is bounded to
32 MiB and participates in the existing document registry budget. Reload reads
resources again without replacing a dirty source draft.

Rendered HTML selections carry their quote, DOM endpoints and original file
revision into the originating conversation's draft. DOM positions describe the
rendered document, not source line offsets. Referencing a selection never sends
a message automatically. The host checks the originating iframe, current
preview generation and message schema before accepting bridge messages.

`e2e/html-document.spec.ts` covers isolated report rendering, Windows file links,
local resources, pane state, source editing, mixed endings and selected-text
references at desktop and phone widths. The fixture simulates the Hub boundary;
it does not assert real Windows or phone-device acceptance.

The media browser test mounts the production preview components in a local
fixture, without creating a hub session:

```bash
cd web
node node_modules/@playwright/test/cli.js test -c playwright.config.ts e2e/artifacts.spec.ts
```

## Build

```bash
bun run build:web
```

The built assets land in `web/dist` and are served by hapi-hub. The single executable can embed these assets.

## Standalone hosting

You can host `web/dist` on a static host (GitHub Pages, Cloudflare Pages) and point it at any hapi hub:

1. Build the web app. If your static host uses a subpath, set the Vite base:

```bash
bun run build:web -- --base /<repo>/
```

2. Deploy `web/dist` to your static host.
3. Set hub CORS to allow the static origin (`HAPI_PUBLIC_URL` or `CORS_ORIGINS`).
4. Open the static site, click the top-right Hub button on the login screen, and enter the hapi hub origin.

Clear the hub override in the same dialog to return to same-origin behavior.

The mobile keyboard layout and configuration follow [Haven](src/components/Terminal/termbeam/HAVEN.md), including content-sized 32px keys, paired navigation columns, row placement, macros and JSON editing.

Session-list recency is captured when the list opens. Live activity updates the row's status and timestamp without reordering existing rows; newly discovered sessions join by their initial activity time. Selecting a list view or explicitly refreshing updates the ordering snapshot. Search relevance and explicit pinned/state sections still apply. This prevents concurrent streaming sessions from repeatedly moving under the pointer. Regression coverage exercises repeated updates on the mounted `SessionList`, not only static status glyphs.

### Loading budget and regression checks

Settings, file, terminal and new-session screens use route-level lazy loading.
`bun run check:bundle` checks the built JavaScript entry against a 2.6 MB raw /
780 KB gzip ceiling. The check also runs as part of the Web production build.
It measures the entry, not total cold-load transfer, execution time or all PWA
precache assets. Preserve offline support when changing the precache strategy.

Machines settings can include previously connected offline machines; launch
pickers remain online-only. The no-machine state offers contextual runner setup
without starting an agent. Login has a bounded timeout and localized errors;
ordinary read requests are bounded, while mutations are never automatically
replayed because of a timeout.

### Exceptional workflow recovery

- Fork confirmations block duplicate clicks and dismissals while running. If
  creating the child succeeds but navigation fails, retrying in the same
  mounted session opens that child instead of creating another one. A lost
  create response is not retried automatically; this is not a server-side
  exactly-once guarantee across reloads.
- Steering reconciles against an authoritative message read as well as SSE.
  Actions remain locked during reconciliation; transport errors do not claim
  that the message definitely stayed queued, and never trigger an automatic
  resend.
- The scratchlist distinguishes loading, failed refresh and an empty list.
  Failed mutations keep notes and display recovery guidance. Queue acceptance
  and deleting the saved note are separate steps: failed cleanup is retried
  without resending. An identifier-only tab-session journal preserves this
  distinction when the drawer closes/reopens or the same tab reloads; it is
  not a cross-device transaction or a server-side exactly-once guarantee.
  If sessionStorage is unavailable, the in-memory guard lasts until reload.
- Copying into the composer keeps the original note. Attachment-copy errors
  stay visible in the session shell after the drawer closes. Mobile scratchlist
  controls have larger touch targets and move below the note text.

Regression coverage: `e2e/exceptional-workflows.spec.ts` mounts production
controls, the real message store and fork recovery helper with deterministic
transport failures. It covers desktop/mobile cleanup, fork cancellation and
navigation retry, steering without SSE, and steering network failure. These
fixtures do not launch a real agent or use paid model credentials.
