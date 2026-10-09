# DeepSeek Harness chat core

Reference: `deepseek-ai/deepseek-harness@5badb15009ae1756c3afe0ae0cef1faafc290ccc`.
Copyright and MIT terms are retained in [LICENSE](./LICENSE). The pinned source,
not the locally installed Harness application, defines the behavior below.

## Source and adaptation map

Paths in the reference are relative to `packages/client/ui-chat/src/client/`.

| Reference | HAPI implementation | Adaptation |
| --- | --- | --- |
| `chat/use-scroll-follow.ts` | Same-named file here | Reduced imports; original follow/attribution rules retained. |
| `chat/use-chat-reading.ts` | Same-named file here | Persistent HAPI character/code bookmarks retain reader intent while an estimated virtual floor is measured. Asynchronous restoration initializes only after a completed landing; intermediate programmatic scrolls do not become reader bookmarks. Their landing remains pinned through later layout commits. |
| `chat/use-chat-navigation.ts` | Same-named file here | A loaded destination can await virtual mounting. Metadata-only outline resolution belongs to the same cancellable navigation task. End targets use end alignment. |
| `chat/use-chat-viewport.ts` | Same-named file here, extended by `../nativeViewport.ts` | HAPI provides `contains/reveal/pinReading`, source-based code restoration and sparse normal-flow rows. The adapter distinguishes unloaded DOM from missing data. |
| `chat/use-chat-scroll.ts` | Same-named file here | Open once after the first usable window (including empty success); revalidate bookmarks only on history-epoch change. Scroll attribution reaches the paging adapter before Reading samples it. |
| `conversation-nodes/chat-snapshot-builder.ts` | `../nativeProjection.ts`, `NodeSource` | Retain `order` plus keyed subscriptions, using existing bounded HAPI blocks instead of the DSH plugin runtime. |
| `conversation-nodes/process-groups.ts`, `TurnGroups.rebuild/extendedGroup` | `process-groups.ts` | Codex item classifications replace Step inputs; replies, independent nodes and order gaps close groups. Complete existing groups retain identity when extended. |
| `presentation-policy.ts`, Standard presentation and conversation node seats | `process-groups.ts`, `../nativeProjection.ts`, `NativeCodexThread.tsx` | Real Codex phase and lifecycle authorize completed-turn folding. Unknown boundaries, missing answers, stopped/failed turns and interleaved user input retain their flat content. HAPI approvals, questions, artifacts and subagent controls remain reachable. |

The original sampling interval (500 ms) and follow threshold (24 px) are intact.
No additional delayed scroll-to-bottom loop is installed. React 19 nullable refs
and small local view types replace the reference's plugin contracts.

Visible-turn discovery uses DSH's mounted outer-node geometry rather than
recapturing a HAPI character bookmark. The virtual list and business context
retain stable React identities during reading-state updates. These adaptations
reduce redundant rendering without changing DSH sampling or follow rules.

## HAPI ownership boundaries

- `NativeChatViewport` connects existing persistent character/code bookmarks and
  bounded history context loading to the migrated coordinator. Browser anchoring
  is disabled only while following the tail; virtual spacers are not candidates.
- `NativeCodexThread` retains HAPI's continuous prefetch and page triggers. Before
  a page is published, the coordinator captures the latest reader position.
  A React pre-mutation snapshot refreshes that position after render work, only
  for an actual page commit; it must not replace an in-flight code bookmark.
  Keyboard End first mounts the actual last loaded content part; it never samples
  a blank estimated tail before applying an immediately cached forward page.
- `WindowedMessageList` measures and mounts normal-flow rows and sparse spacers.
  It does not independently compensate scroll position or follow appended rows.
  Its optional pre/post mutation callbacks let the same viewport owner preserve
  the visible seat when newly mounted rows replace estimates. This also covers
  range changes without a network page: physical Chrome exhibited excess native
  anchoring during these measurements, despite stable page-publication anchors.
  A focused question seat remains pinned while surrounding process content folds;
  this preserves the same input DOM and draft through virtual remeasurement.
- Native text keys use thread/turn/item identity. Tool keys retain the existing
  native tool-call ID, which is already shared by permission-first placeholders
  and later history records. Receiving richer metadata must not remount a question.
- Display expansion state and keyed sources are pruned when their owning data
  leaves the bounded window. No second transcript database is created.
- `../sessionPresentation.ts` is a HAPI adaptation for switching between chats:
  the five most recent native sessions retain normalized/reconciled content,
  their projection and disclosure state within the API authorization lifetime.
  History-epoch replacement invalidates view state. The virtualizer can reuse
  measured sizes at the same width, while DSH still owns position restoration.
  `NativeCodexThread` saves the bookmark on the router's `onBeforeNavigate`
  event; teardown must not overwrite it after ancestor geometry has changed.
  Workspace synchronization may capture panes before first presentation. Those
  panes retain their existing bookmark until restoration has initialized them.
  Repeated layout publications share the same asynchronous CodeMirror placement
  by bookmark identity, independently of the scroll adapter's wrapper objects.
  No inactive chat DOM, scroll listeners or follow tasks are retained.
- `recent-session-warmup.ts` consumes the existing global SSE feed for the
  five recent sessions. Bounded background tail reads are serialized and
  network-aware. Explicit session switching selects the latest cached tail
  before the next chat mounts; this is separate from restoring a bookmark
  after reloading a page or returning from its file view. Background warming
  never moves an active history reader or fetches every earlier page.
- Process disclosures have their own stable presentation keys, separate from
  the first tool's message-runtime key. A prepended tool must not replace the
  visible group header. A turn first seen without its start remains in that
  presentation for its current window residency when older pages arrive.
- The base viewport checks the adapter's `preserving` property when dispatching
  scroll events. Native browser anchoring is layout movement; a change in
  scrollTop with an unchanged anchor document coordinate releases preservation
  for real reader motion, including inertia. Short initial pages retain their
  unused tail space during prepend; retiring it must not clamp the reader backward.
- Closed native groups do not mount tool bodies or create hidden assistant-ui
  message/composer runtimes. The complete bounded block source still drives
  execution and navigation; expansion subscribes the presentation runtime to
  the newly visible blocks.
- `SessionChat` preserves the existing runtime, composer, message confirmation,
  permission APIs and business controls. Other agents use the legacy renderer.

Native Codex now defaults to the DSH presentation. Set localStorage
`hapi:native-chat-presentation=legacy` and reopen the conversation to roll back
the presentation without changing native history. Other agents stay on the legacy path.
The user authorized release with the measured CPU overhead still under investigation.
See `docs/chat-experience-contract.md` for evidence and release status. Original
DSH test success, HAPI replay success and actual device acceptance are recorded
separately; none implies the others.
