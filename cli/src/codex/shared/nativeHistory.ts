import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol';
import { MessagesQuerySchema, MessageOutlineQuerySchema, MessageContextQuerySchema, MessageDependenciesQuerySchema,
    type MessagesResponse, type MessageOutlineResponse, type MessageContextResponse, type MessageDependenciesResponse } from '@hapi/protocol/apiTypes';
import { extractConversationOutlineLabel } from '@hapi/protocol/conversationOutline';
import { extractMessageDependencyFacts } from '@hapi/protocol/messageDependencies';
import type { DecryptedMessage } from '@hapi/protocol/types';
import type { ApiSessionClient } from '@/api/apiSession';
import type { CodexAppServerClient } from '../codexAppServerClient';
import { SharedCodexProjection } from './projection';
import { record, string } from './gateway';
import { NativeIndexedHistory, freshNativeHistoryEpoch } from './nativeHistoryIndexed';

type Position = { at: number; seq: number };
type NativeCursor = string | { type: 'item'; itemId: string };
type Item = { turnId: string; item: Record<string, unknown>; startedAtMs?: number | null; completedAtMs?: number | null };
type Origin = { threadId: string; turnId: string; itemId: string; rank: number; at: number; parent?: string };
const ITEMS_PER_PAGE = 32;
const ITEM_BODY_CACHE_LIMIT = 512;
const freshEpoch = freshNativeHistoryEpoch;
const position = (m: DecryptedMessage): Position => ({ at: m.createdAt, seq: m.seq! });
const compare = (a: Position, b: Position) => a.at - b.at || a.seq - b.seq;

/** Bounded native item pages. Bodies are a disposable LRU; cursors/labels are
 * sparse metadata. Nothing here emits to the session socket or writes history. */
export class NativeCodexHistory {
    private epoch = freshEpoch();
    private revision = 0;
    private readonly messages = new Map<string, DecryptedMessage>();
    private readonly origins = new Map<string, Origin>();
    private readonly items = new Map<string, Origin>();
    private readonly labels = new Map<string, { messageId: string; label: string; at: number; seq: number; createdAt: number }>();
    private readonly pageCursors = new Map<string, { cursor?: NativeCursor; turnId?: string; direction: 'asc' | 'desc'; threadId: string; forward?: string | null; older?: string | null }>();
    private head: Position | null = null;
    private latestIds = new Set<string>();
    private scanBefore: Position | null = null;
    private scanAfter: Position | null = null;
    private childFrontier = 0;
    private readonly childCursors = new Map<string, string | null>();
    private olderCursor?: string | null;
    private initialized = false;
    private dirty = false;
    private oldestRank = 1_000_000_000;
    private newestRank = 1_000_000_000;
    private work: Promise<unknown> = Promise.resolve();
    private readonly indexed?: NativeIndexedHistory;
    constructor(private readonly threadId: string, private readonly client: Pick<CodexAppServerClient, 'request'>, home?: string) {
        if (home !== undefined) this.indexed = new NativeIndexedHistory(threadId, client, home);
    }
    terminal(turn: Record<string, unknown>) { this.indexed?.terminal(turn); }
    invalidate(reset = true): void {
        this.indexed?.invalidate(reset);
        this.revision++; this.dirty = true; this.childCursors.clear();
        if (reset) {
            this.epoch = freshEpoch(); this.messages.clear(); this.origins.clear(); this.items.clear();
            this.labels.clear(); this.pageCursors.clear(); this.latestIds.clear(); this.head = null; this.scanBefore = this.scanAfter = null;
            this.olderCursor = undefined; this.initialized = false;
            this.oldestRank = this.newestRank = 1_000_000_000;
        }
    }
    read(raw: unknown): Promise<unknown> {
        const pending = this.work.catch(() => {}).then(async () => {
            if (!this.indexed) return this.readNow(raw);
            if (record(raw).operation !== 'dependencies') return this.indexed.read(raw);
            const seeds = MessageDependenciesQuerySchema.parse(raw).seeds;
            const result = seeds.length ? await this.readNow({ ...record(raw), seeds: seeds.join(',') }) as MessageDependenciesResponse : {
                messages: [], issues: [], pendingMessageIds: [], complete: true
            };
            return this.indexed.dependencies(raw, result, this.origins);
        });
        this.work = pending; return pending;
    }
    private key(threadId: string, itemId: string) { return `${threadId}:${itemId}`; }
    private ordered(includeChildren = false) { return [...this.messages.values()].filter(m => includeChildren || this.origins.get(m.id)?.threadId === this.threadId).sort((a, b) => compare(position(a), position(b))); }
    private async fetch(cursor?: NativeCursor, direction: 'asc' | 'desc' = 'desc', threadId = this.threadId, parent?: string, turnId?: string): Promise<{ next?: string; backwards?: string; data: Item[] }> {
        const revision = this.revision;
        const page = record(await this.client.request('thread/items/list', { threadId, turnId, cursor, sortDirection: direction, limit: ITEMS_PER_PAGE }));
        if (revision !== this.revision) return this.fetch(cursor, direction, threadId, parent, turnId);
        if (!Array.isArray(page.data)) throw new Error('Invalid native Codex item page');
        const data = (direction === 'desc' ? [...page.data].reverse() : page.data).map(value => record(value) as unknown as Item);
        const rootOlder = threadId === this.threadId && direction === 'desc' && cursor !== undefined;
        const knownIndex = data.findIndex(entry => this.items.has(this.key(threadId, String(entry.item.id))));
        const rank = knownIndex >= 0
            ? this.items.get(this.key(threadId, String(data[knownIndex].item.id)))!.rank - knownIndex
            : rootOlder || (threadId === this.threadId && direction === 'asc' && cursor !== undefined)
                ? this.oldestRank - data.length : this.newestRank + 1;
        for (const [index, entry] of data.entries()) {
            const itemId = string(entry.item?.id);
            if (!itemId || !entry.turnId) throw new Error('Native Codex item has no identity');
            const key = this.key(threadId, itemId);
            const previous = this.items.get(key);
            const at = entry.startedAtMs ?? entry.completedAtMs ?? (Number.parseInt(entry.turnId.replaceAll('-', '').slice(0, 12), 16) || 0);
            const origin: Origin = previous ?? { threadId, turnId: entry.turnId, itemId, rank: rank + index, at, parent };
            this.oldestRank = Math.min(this.oldestRank, origin.rank); this.newestRank = Math.max(this.newestRank, origin.rank);
            this.items.set(key, origin); this.pageCursors.set(key, { cursor, direction, threadId, turnId,
                forward: string(direction === 'asc' ? page.nextCursor : page.backwardsCursor) ?? null,
                older: string(direction === 'desc' ? page.nextCursor : page.backwardsCursor) ?? null });
            await this.project(entry, origin, origin.parent);
        }
        while (this.messages.size > ITEM_BODY_CACHE_LIMIT) this.messages.delete(this.messages.keys().next().value!);
        if (threadId === this.threadId && direction === 'desc' && (!this.initialized || cursor !== undefined)) {
            this.olderCursor = string(page.nextCursor) ?? null;
        }
        if (threadId === this.threadId && data.length) {
            const first = this.items.get(this.key(threadId, String(data[0].item.id)))!;
            const last = this.items.get(this.key(threadId, String(data.at(-1)!.item.id)))!;
            this.scanBefore = { at: first.at, seq: first.rank * 10_000 };
            this.scanAfter = { at: last.at, seq: last.rank * 10_000 + 9999 };
            if (!this.ordered().some(message => this.origins.get(message.id)?.itemId === last.itemId)
                && (!this.head || compare(this.scanAfter, this.head) > 0)) this.head = this.scanAfter;
        }
        const fetchedHead = this.ordered().at(-1);
        if (threadId === this.threadId && fetchedHead && (!this.head || compare(position(fetchedHead), this.head) > 0)) this.head = position(fetchedHead);
        if (threadId === this.threadId && direction === 'desc' && cursor === undefined) {
            const keys = new Set(data.map(entry => String(entry.item.id)));
            this.latestIds = new Set([...this.messages.keys()].filter(id => {
                const origin = this.origins.get(id)!;
                return origin.threadId === this.threadId && keys.has(origin.itemId);
            }));
        }
        this.initialized = true; this.dirty = false;
        return { next: string(page.nextCursor), backwards: string(page.backwardsCursor), data };
    }
    private async project(entry: Item, origin: Origin, parent?: string) {
        const existing = new Map([...this.messages].filter(([id]) => {
            const source = this.origins.get(id);
            return source?.threadId === origin.threadId && source.itemId === origin.itemId;
        }));
        for (const [id] of existing) { this.messages.delete(id); this.labels.delete(id); }
        let ordinal = 0;
        const emitted = new Map<string, number>();
        const append = (content: unknown, stableId: string) => {
            // Reuse projection identities across item lifecycle and page overlap.
            const id = `native:${origin.threadId}:${origin.turnId}:${origin.itemId}:${encodeURIComponent(stableId)}`;
            const eventOrdinal = emitted.get(id) ?? ++ordinal; emitted.set(id, eventOrdinal);
            const message: DecryptedMessage = { id, localId: stableId, seq: origin.rank * 10_000 + eventOrdinal,
                createdAt: origin.at, invokedAt: origin.at, scheduledAt: null, content };
            this.messages.delete(id); this.messages.set(id, message); this.origins.set(id, origin);
            const label = extractConversationOutlineLabel(content);
            if (label && !parent) this.labels.set(id, { messageId: id, label, at: origin.at, seq: message.seq!, createdAt: origin.at });
        };
        const sink = { getMetadata: () => null, updateMetadata: () => {},
            sendUserMessage: (text: string, _meta: unknown, id: string) => append({ role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } }, id),
            sendAgentMessage: (body: unknown) => append({ role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: body }, meta: { sentFrom: 'cli' } }, string(record(body).id)!),
            sendSessionEvent: (event: unknown, id: string) => append({ role: 'agent', content: { type: 'event', data: event, id } }, id)
        } as unknown as ApiSessionClient;
        await new SharedCodexProjection(sink, origin.threadId, async () => {}, parent, true).history({ turns: [{
            id: origin.turnId, status: entry.item.status === 'inProgress' ? 'inProgress' : 'completed', items: [entry.item]
        }] });
        // A native item is a mutable snapshot. The epoch makes Web replace its
        // previous rows when an answer changes or an item loses projected events.
        if (existing.size && (existing.size !== emitted.size || [...existing].some(([id, previous]) =>
            JSON.stringify(previous.content) !== JSON.stringify(this.messages.get(id)?.content)))) this.epoch = freshEpoch();
    }
    private async ensureLatest() { if (!this.initialized || this.dirty) await this.fetch(); }
    private async restore(id: string) {
        if (this.messages.has(id)) return;
        const origin = this.origins.get(id);
        if (origin) {
            const page = this.pageCursors.get(this.key(origin.threadId, origin.itemId))!;
            await this.fetch(page.cursor, page.direction, page.threadId, origin.parent, page.turnId); return;
        }
        const parts = id.split(':');
        if (parts[0] !== 'native' || parts[1] !== this.threadId || !parts[2] || !parts[3]) throw new Error('Native message not found');
        const previous = record(await this.client.request('thread/items/list', { threadId: this.threadId, turnId: parts[2],
            cursor: { type: 'item', itemId: parts[3] }, sortDirection: 'desc', limit: 1 }));
        const reverse = string(previous.backwardsCursor);
        if (reverse) await this.fetch(reverse, 'asc');
        else {
            // The exclusive anchor before the first item has no reverse cursor.
            // Read that turn's first item, then use its opaque global boundary.
            const first = record(await this.client.request('thread/items/list', {
                threadId: this.threadId, turnId: parts[2], sortDirection: 'asc', limit: 1
            }));
            const boundary = string(first.backwardsCursor);
            if (!boundary) throw new Error('Native message not found');
            await this.fetch(boundary, 'desc');
            const origin = this.origins.get(id);
            const forward = origin && this.pageCursors.get(this.key(origin.threadId, origin.itemId))?.forward;
            if (forward) await this.fetch(forward, 'asc');
        }
    }
    private async readNow(raw: unknown): Promise<unknown> {
        const request = record(raw);
        await this.ensureLatest();
        if (request.operation === 'outline') return this.outline(request);
        if (request.operation === 'context') return this.context(request);
        if (request.operation === 'dependencies') return this.dependencies(request);
        return this.page(request);
    }
    private async page(raw: unknown): Promise<MessagesResponse> {
        const input = record(raw);
        const q = MessagesQuerySchema.parse({ ...input, ...(typeof input.bounded === 'boolean' ? { bounded: String(input.bounded) } : {}) }); const limit = q.limit ?? 50;
        const reset = q.epoch !== undefined && q.epoch !== this.epoch;
        const before = !reset && q.beforeAt !== undefined ? { at: q.beforeAt, seq: q.beforeSeq! } : null;
        const after = !reset && q.afterAt !== undefined ? { at: q.afterAt, seq: q.afterSeq! } : null;
        if (!before && !after && [...this.latestIds].some(id => !this.messages.has(id))) await this.fetch();
        const eligible = () => this.ordered().filter(m => (!before || compare(position(m), before) < 0)
            && (!after || compare(position(m), after) > 0) && (q.untilAt === undefined || compare(position(m), { at: q.untilAt, seq: q.untilSeq! }) <= 0));
        if (before && eligible().length < limit) {
            const origin = [...this.items.values()].find(value => value.threadId === this.threadId && value.at === before.at && Math.floor(before.seq / 10_000) === value.rank);
            const page = origin && this.pageCursors.get(this.key(origin.threadId, origin.itemId));
            if (page && before.seq % 10_000 !== 0 && !this.ordered().some(message => compare(position(message), before) === 0))
                await this.fetch(page.cursor, page.direction, page.threadId, undefined, page.turnId);
            const older = page?.older ?? this.olderCursor;
            if (eligible().length < limit && older) await this.fetch(older);
        }
        // Refetch the bounded head for forward readers; identity merge handles native reversal overlap.
        let forwardMore = false;
        if (after) {
            const origin = [...this.items.values()].find(value => value.threadId === this.threadId && value.at === after.at && Math.floor(after.seq / 10_000) === value.rank);
            if (origin) {
                const cursor = this.pageCursors.get(this.key(origin.threadId, origin.itemId))?.forward;
                if (cursor) {
                    const page = await this.fetch(cursor, 'asc');
                    forwardMore = Boolean(page.next);
                }
            } else await this.fetch();
        }
        const all = eligible(); const selected = after ? all.slice(0, limit) : all.slice(-limit);
        const first = selected[0]; const last = selected.at(-1);
        return { messages: selected, page: { direction: after ? 'after' : before ? 'before' : 'latest', limit, epoch: this.epoch, reset,
            nextBeforeSeq: first?.seq ?? this.scanBefore?.seq ?? before?.seq ?? null, nextBeforeAt: first?.createdAt ?? this.scanBefore?.at ?? before?.at ?? null,
            nextAfterSeq: last?.seq ?? this.scanAfter?.seq ?? after?.seq ?? null, nextAfterAt: last?.createdAt ?? this.scanAfter?.at ?? after?.at ?? null,
            snapshotHeadSeq: this.head?.seq ?? null, snapshotHeadAt: this.head?.at ?? null,
            hasMore: all.length > selected.length || (after ? forwardMore && (q.untilAt === undefined || !last || compare(position(last), { at: q.untilAt, seq: q.untilSeq! }) < 0) : this.olderCursor !== null) } };
    }
    private async outline(raw: unknown): Promise<MessageOutlineResponse> {
        const q = MessageOutlineQuerySchema.parse(raw);
        const reset = q.epoch !== undefined && q.epoch !== this.epoch;
        const before = !reset && q.beforeAt !== undefined ? { at: q.beforeAt, seq: q.beforeSeq! } : null;
        const eligible = () => [...this.labels.values()].filter(e => !before || compare({ at: e.at, seq: e.seq }, before) < 0)
            .sort((a, b) => compare({ at: a.at, seq: a.seq }, { at: b.at, seq: b.seq }));
        if (eligible().length < q.limit && this.olderCursor) await this.fetch(this.olderCursor);
        const entries = eligible().slice(-q.limit); const first = entries[0];
        return { entries, page: { epoch: this.epoch, reset,
            hasMore: eligible().length > entries.length || this.olderCursor !== null,
            beforeCursor: first ? { at: first.at, seq: first.seq } : this.scanBefore ?? before,
            scannedThrough: this.head?.seq ?? 0, headSeq: this.head?.seq ?? 0, complete: this.olderCursor === null, unreadable: false, indexing: false } };
    }
    private async context(raw: Record<string, unknown>): Promise<MessageContextResponse> {
        const q = MessageContextQuerySchema.parse(raw); const id = String(raw.messageId);
        await this.restore(id); const anchor = this.messages.get(id);
        if (!anchor) throw new Error('Native message not found');
        const ordered = this.ordered(); const index = ordered.findIndex(m => m.id === id);
        const messages = ordered.slice(Math.max(0, index - q.radius), index + q.radius + 1);
        const first = messages[0]; const last = messages.at(-1)!;
        return { anchor: { messageId: id, position: position(anchor) }, messages, page: { epoch: this.epoch,
            reset: q.epoch !== undefined && q.epoch !== this.epoch, beforeCursor: position(first), afterCursor: position(last),
            hasMoreBefore: index > q.radius || this.olderCursor !== null, hasMoreAfter: index + q.radius < ordered.length - 1,
            snapshotHead: this.head! } };
    }
    private async dependencies(raw: Record<string, unknown>): Promise<MessageDependenciesResponse> {
        const q = MessageDependenciesQuerySchema.parse(raw); const seeds = q.seeds;
        for (const seed of seeds) await this.restore(seed);
        const children = new Set<string>();
        const parents = new Map<string, string>();
        for (const seed of seeds) {
            const message = this.messages.get(seed); if (!message) continue;
            const origin = this.origins.get(seed)!;
            for (const fact of extractMessageDependencyFacts(seed, message.content).facts) if (fact.kind === 'agent_run_agent') {
                children.add(fact.key);
                // A trace's agent identity refers to its own thread, whereas
                // a spawn/update names a child of the source thread.
                parents.set(fact.key, fact.key === origin.threadId && origin.parent ? origin.parent : origin.threadId);
            }
        }
        const pending = new Set<string>();
        const unreadable = new Set<string>();
        // Fetch one bounded page per descendant. Nested calls retain their
        // native parent identity; a dependency request has a finite thread budget.
        let requests = 0;
        const original = [...children];
        const start = original.length ? this.childFrontier % original.length : 0;
        const frontier = [...original.slice(start), ...original.slice(0, start)];
        for (let index = 0; index < frontier.length; index++) {
            const child = frontier[index];
            try {
                if (!this.childCursors.has(child) || this.childCursors.get(child)) {
                    if (requests >= 8) { for (const seed of seeds) pending.add(seed); continue; }
                    requests++;
                    this.childFrontier = original.length ? (original.indexOf(child) + 1) % original.length : 0;
                    const page = await this.fetch(this.childCursors.get(child) ?? undefined, 'desc', child, parents.get(child));
                    this.childCursors.set(child, page.next ?? null);
                    if (page.next) for (const seed of seeds) pending.add(seed);
                }
                for (const message of this.messages.values()) {
                    if (this.origins.get(message.id)?.threadId !== child) continue;
                    for (const fact of extractMessageDependencyFacts(message.id, message.content).facts) {
                        if (fact.kind === 'agent_run_agent' && fact.key !== child && !children.has(fact.key)) {
                            children.add(fact.key); frontier.push(fact.key); parents.set(fact.key, child);
                        }
                    }
                }
            } catch { for (const seed of seeds) unreadable.add(seed); }
        }
        const facts = new Map([...this.messages.values()].map(m => [m.id, extractMessageDependencyFacts(m.id, m.content).facts]));
        const included = new Set([...seeds, ...[...this.messages.values()].filter(message => children.has(this.origins.get(message.id)!.threadId)).map(message => message.id)]); let changed = true;
        while (changed) {
            changed = false;
            for (const id of [...included]) for (const fact of facts.get(id) ?? []) {
                const kinds = fact.kind === 'tool_call' || fact.kind === 'tool_result' ? ['tool_call', 'tool_result'] : [fact.kind];
                for (const [other, otherFacts] of facts) if (!included.has(other) && otherFacts.some(f => kinds.includes(f.kind) && f.key === fact.key)) {
                    included.add(other); changed = true;
                }
            }
        }
        return { epoch: this.epoch, reset: q.epoch !== this.epoch, indexReady: true, indexScanned: true, seedMessageIds: seeds,
            messages: this.ordered(true).filter(m => included.has(m.id) && !seeds.includes(m.id)), complete: pending.size === 0 && unreadable.size === 0,
            issues: [...[...pending].map(messageId => ({ messageId, reason: 'budget' as const })), ...[...unreadable].map(messageId => ({ messageId, reason: 'unreadable' as const }))], pendingMessageIds: [...new Set([...pending, ...unreadable])] };
    }
}
