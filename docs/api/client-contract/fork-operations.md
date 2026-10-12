# Durable shared-Codex fork operations

Source of truth: `shared/src/forkOperations.ts`, `hub/src/sync/forkOperations.ts`,
`hub/src/store/forkOperationStore.ts`, `cli/src/codex/shared/forkOperations.ts`,
and `web/src/lib/fork-operation.ts`.

## Scope and guarantee

Shared Codex sessions (`metadata.flavor === 'codex'` and
`metadata.capabilities.concurrentClients === true`) use a durable operation for
current-state and historical forks. One accepted operation is dispatched to the
native fork service at most once. A timeout, connection loss, or native error
after dispatch does not prove that no child was created.

This is not native exactly-once creation. Codex 0.162 has no client operation key
for `thread/fork`, and some native errors occur after child creation. If the
original reply is lost, HAPI may be unable to identify that child. It retains an
indeterminate receipt and source fence. A separate explicit user-confirmed
duplicate-risk request can authorize a new operation, while preserving the old
receipt. Ordinary checks and retries never create a replacement child.
Names, timestamps, matching lineage, and a unique discovery candidate are never
used to identify the result of an operation.

## Client workflow

1. Read `GET /api/sessions/:id/fork-operations`. The response is
   `{revision, operation?}`. Inspect an unresolved operation rather than starting
   another one.
2. Persist a random UUID, the observed `revision`, and the immutable requested
   boundary before the first POST.
3. Submit `POST /api/sessions/:id/fork` with
   `{operationId, expectedForkRevision, messageLocalId? | nativeBoundary?}`.
   Omit both boundary fields for a current-state fork. The native historical
   selector remains `{threadId, turnId, itemId}` from the loaded user message.
4. On a network error or expired client wait, query
   `GET /api/sessions/:id/fork-operations/:operationId`. Do not automatically
   submit another fork or replace the UUID.
5. For a known child whose HAPI binding is pending or blocked, call
   `POST /api/sessions/:id/fork-operations/:operationId/reconcile`. This recovers
   only the exact recorded child; it never performs another native fork.
6. Navigate to `childSessionId` only when the receipt is `created` with
   `binding: 'ready'`. A late result must not redirect a tab or pane that has
   since navigated, canceled, or started a different action.

The source revision is a monotonic active-head/CAS version, not a transcript
version. Every head change advances it, including restoration of an earlier
operation after a new request is proved undispatched. A receipt
`sourceRevision` remains its original admission version; it can be lower than
the current source-state revision. Only authoritative source-state responses
choose the active head; stale operation replies and browser storage events
must not replace it. Same-ID
replays are checked before revision freshness. A different operation from a
stale tab conflicts even if the first fork has already finished. Never silently
refresh the revision and resubmit. After reviewing a terminal operation, a new
explicit user action may use the refreshed revision and a new UUID.

Receipt state evidence is ordered independently of wall-clock timestamps on
the Hub and CLI. An executor clock behind the Hub cannot suppress a proven
no-dispatch rejection, an indeterminate result, or an exact known child.

## Receipts and HTTP responses

All receipts contain `operationId`, `sourceSessionId`, `childSessionId`,
`sourceRevision`, `message`, `updatedAt`, an optional diagnostic `code`, and
optional immutable `duplicateRiskOf` ancestry.

- `running`: admitted work has not reached a conclusive observation.
- `indeterminate`: a child may exist. Normal fork requests stay fenced until
  conclusive evidence resolves it or the user explicitly authorizes a separate
  duplicate-risk operation. The old receipt remains indeterminate afterward.
- `created`: requires the exact `nativeThreadId`; `binding` is `pending`,
  `blocked`, or `ready`. Binding failures never undo creation.
- `rejected`: requires `rejectionProof: 'not_dispatched'`. The request failed
  before a native fork could be sent. Fix the cause and make a new explicit
  request.

Modern POST and operation read/reconcile responses contain `{operation,
sessionId?}`. Pending, indeterminate, and unbound creation use HTTP 202; terminal
known results use HTTP 200. Admission conflicts use HTTP 409 with
`{error, code, revision, operation?}`. Cross-namespace source conflicts redact the
other namespace's receipt. Every route authenticates the namespace and source;
knowing an operation UUID grants no access.

## Compatibility and recovery limits

Existing clients can still send `{}`, `{messageLocalId}`, or `{nativeBoundary}`.
Non-shared agent providers retain their previous API. For shared Codex, the hub
adapts each received legacy request into a durable operation: success still
returns `{sessionId}`, while an unresolved result returns a readable conflict
with operation information. The durable source fence protects uncertain legacy
requests, but a legacy client without an operation ID/revision cannot obtain
modern replay or completion-after-success cross-tab CAS guarantees.

There is no fallback from a failed tracked RPC to the old untracked native fork.
Mixed hub/CLI versions must be upgraded together if the CLI does not support the
operation method. The updated web client does not auto-replay a fork POST after
reauthentication.

Hub and CLI receipts survive process restarts. Status reads do not launch a
runtime or reconnect an inactive source. To reconcile through an inactive CLI,
first explicitly reconnect the original source to its authorized runtime; an
unknown child remains unknown. A known child is rebound under its reserved HAPI
identity. This release does not automatically start a machine-level recovery
worker. An inactive source must reconnect before a duplicate-risk request can
pass the CLI’s independent authenticated-source checks.

Native terminal `/fork` requests through HAPI's gateway also receive a CLI
journal/source fence and diagnostic operation ID. These terminal-origin
operations are not automatically imported into the hub's REST receipt list in
this release, so their unknown outcomes do not have the complete web recovery
workflow above. Their source remains protected against another native fork.
Terminal requests must refer to a connected HAPI source root; ephemeral native
forks through this gateway are rejected explicitly. Direct calls to a daemon
outside HAPI cannot be fenced by HAPI.

Late native replies are observed only on their exact originating transport
within a finite recovery window. The native wait remains 20 seconds; observation
is capped at five minutes and 256 tracked requests per client. The runtime also caps live fork observers at 256 and detaches unidentified observer sockets after 320 seconds; their durable source fences remain. Expiry removes
only the live reply listener, never the durable receipt or uncertainty fence.

Operation lookups use exact receipt/source keys. They do not replay or copy
conversation history. Existing native creation and binding work may still be
history-dependent; this contract does not claim constant-time native forks.

If an intent was saved locally but its POST has no reported hub receipt, a client
may offer an explicit **Send original request** action after checking status.
That action must reuse the exact UUID, original revision, and original boundary.
A status 404 can race a still-in-flight first POST; it is never proof that no
request was sent. Do not clear the intent, mint a replacement UUID, or send it
automatically. Hub same-ID admission deduplicates the original and explicit
resubmission even when they arrive in the opposite order.

For multiple authorized HAPI aliases of the same physical native source, public
source status preserves the shared head/CAS revision. An unresolved operation
owned by another alias is represented by `blockingSourceSessionId` and `message`,
not by a receipt relabeled as belonging to the current alias. Open the original
source or refresh source status. Terminal operations on another alias do not
prevent a new deliberate fork after its revision has been observed.


## Explicit duplicate-risk fork

When the active operation is indeterminate, the client may offer a separate
**Create another fork anyway** action. A second confirmation must explain that
the original request may already have succeeded and another conversation may
be created. This action does not cancel the original native request.

Capture the current original operation ID and source-state revision for that
confirmation. Persist a fresh UUID before explicitly submitting:

```json
{
  "operationId": "new-uuid",
  "expectedForkRevision": 3,
  "duplicateRiskOf": "original-unknown-uuid"
}
```

Boundary fields are forbidden on this REST payload. The Hub copies the old
operation's immutable current/managed/native boundary, retaining the exact
historical target. Missing original request data rejects the action; it never
falls back to a current-state fork. The risk target must be the current
indeterminate head on the same authenticated HAPI source, namespace, machine,
and native store/thread. An alias directs the user to the original source.
A stale revision or changed target rejects; clients cannot silently refresh
and resubmit the confirmation against another operation.

The CLI independently checks the original durable receipt and inherited
boundary. Its transaction serializes recording an exact old child with
admitting the new risk operation. If the old child is known first, the new
operation gets its own `rejected/not_dispatched` receipt and the original result
is fetched separately. If risk admission wins first, the old late result only
updates its original receipt and never overwrites the newer source head or
causes navigation. The old ID can never dispatch another fork.

If the new operation is proved undispatched, its predecessor's current result
is restored only if the new operation still owns the head. The source revision
advances again. An original known child stays known and can recover binding;
an original ready child does not acquire a new unknown fence. Already-rejected
risk ancestors are followed by bounded exact-key reads to restore the first
non-rejected predecessor. Missing, cyclic, or excessively deep ancestry fails
closed with a diagnostic. A later successful fork ends that restoration chain.

An explicit risk operation can itself become indeterminate. A further user
confirmation can reference that current operation under a fresh source CAS.
Every old receipt stays accessible, and unidentified superseded native results
remain quarantined from automatic discovery. Unknown outcome and active source
blocking are separate concepts. Until every unidentified result in the same
native store is resolved, automatic adoption of previously unknown native roots
is conservatively paused; already connected sources and exact known children
remain usable.

Duplicate-risk confirmation is not a forced-release protocol. A Hub crash after
admission but before RPC delivery can leave an indeterminate Hub operation with
no matching CLI receipt. Close that exact unadmitted request explicitly using
the protocol below before reviewing its restored predecessor. This release does
not import native-terminal/legacy-origin unknowns into Hub or expose a Web
override for those receipts.

## Explicit closure before CLI admission

POST `/sessions/:id/fork-operations/:operationId/close-unadmitted` accepts only
`{ "expectedForkRevision": <captured source-head revision> }`. The confirmation
must say that this may prevent the original request still in transit from
starting and cannot cancel a request already accepted or dispatched. It does
not allocate a new operation ID or authorize a new native fork.

The response contains the exact target's `operation`, current authoritative
`sourceState`, and a separate `closure` result (plus optional `message`):

- `closed`: target is `rejected`, `rejectionProof: not_dispatched`, and code
  `fork_closed_unadmitted`. This exact rejection was committed durably before
  returning; delayed starts of the same UUID cannot dispatch.
- `already_admitted`: the runtime has already accepted that exact request.
  It was not closed. Known child recovery/opening remains a separate action.
- `already_resolved`: a different definitive rejection was already recorded.
- `unavailable`: runtime, store identity or journal evidence could not establish
  the result. Preserve the unknown operation; do not display cancellation.

Use the independent response schema; do not strip `sourceState` through the
ordinary fork-response parser. A source-head revision is not an operation's
immutable admission revision. A stale/nonhead target returns 409 without a
closure RPC. Exact saved terminal results can be replayed before CAS, so a lost
HTTP acknowledgement can be recovered without repeating a mutation.

The Hub sends only its original stored immutable request. The original canonical
store identity must be present and match the active native source; the older
managed-store fallback cannot establish absence in a possibly different store.
The CLI uses the same durable SQLite transaction authority as admission, queries
the exact UUID across all authenticated scopes, and refuses ambiguous, foreign
or mismatched identities without disclosure. A global UUID index and an insert
trigger also fence delayed writers using older scoped-key admission logic.
Only genuine absence with valid source authority creates the target's own
rejection tombstone; an already admitted request is preserved even if native
dispatch has not happened yet. Ordinary GET and binding reconciliation never
create tombstones. Closure does not change CLI source heads or blockers.

When Hub receives the proof, existing guarded restoration may restore A with a
new source revision. A late proof cannot replace a newer head. The client must
show the returned authoritative state and require a separate user confirmation
for any new risk operation against A. It cannot silently retarget an existing
confirmation for B. Reload, cancellation, offline/401, and a lost closure reply
never automatically repeat closure or create a new fork.

The browser persists the exact risk UUID, captured revision, and ancestor for
an ambiguous POST. **Send original request** resends that same risk payload only
on explicit action; it does not mint another UUID. **Check result**, **Recover
conversation binding**, reload, reconnect, and closing the page never authorize
duplicate risk.

The CLI operation journal uses one canonical native-home SQLite database with
verified EXTRA synchronization, bounded busy timeout, and synchronous immediate
transactions. Dispatch intent commits before the transport write, and exact
child identity commits before binding. Unreadable or corrupt journals fail
closed; changing formats does not silently abandon an existing operation fence.
Initialization syncs the marker file and supported POSIX directories; Windows
uses SQLite's native VFS without unsupported POSIX directory-handle syncing.
Hub fork-operation writes use local FULL transactions on the existing WAL
connection, then restore its previous synchronization setting. Other Hub writes
keep their existing setting. Process-reopen and adapter tests do not constitute
physical power-loss or real Windows execution validation.
These durability claims concern HAPI receipts, not native exactly-once delivery.
