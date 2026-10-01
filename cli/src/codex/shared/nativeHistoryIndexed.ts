import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol';
import { MessagesQuerySchema, MessageContextQuerySchema, MessageOutlineQuerySchema, MessageDependenciesQuerySchema,
    type MessagesResponse, type MessageContextResponse, type MessageOutlineResponse, type MessageDependenciesResponse } from '@hapi/protocol/apiTypes';
import type { DecryptedMessage } from '@hapi/protocol/types';
import { extractConversationOutlineLabel } from '@hapi/protocol/conversationOutline';
import type { ApiSessionClient } from '@/api/apiSession';
import type { CodexAppServerClient } from '../codexAppServerClient';
import { SharedCodexProjection } from './projection';
import { record, string } from './gateway';
import { NativeHistoryMetadata, NativeMetadataUnavailable, openNativeMetadata, nativeMetadataGenerations,
    type NativeTurnMetadata, type NativeItemMetadata } from './nativeHistoryMetadata';

type Position = { at: number; seq: number };
type Source = { kind: 'item'; ordinal: number; item: NativeItemMetadata } | { kind: 'turn'; ordinal: number; turn: NativeTurnMetadata };
const PAGE_SOURCES = 31; // One extra metadata row distinguishes a full page from exhaustion.
const SCALE = 10_000;
let nextEpoch = Date.now();
export const freshNativeHistoryEpoch = () => nextEpoch = Math.max(Date.now(), nextEpoch + 1);
const position = (message: DecryptedMessage): Position => ({ at: message.invokedAt!, seq: message.seq! });
const stopId = (thread: string, turn: string) => `native-turn-status:${thread}:${turn}:turn_aborted`;

/** Metadata keyset paging + official bounded item RPCs. No transcript persists in Hub. */
export class NativeIndexedHistory {
    private epoch = freshNativeHistoryEpoch();
    private revision = 0;
    private dirty = true;
    private readonly expected = new Map<string, string>();
    private readonly cached = new Map<string, DecryptedMessage>();
    private readonly metadataCoordinates = new Map<string, string>();
    constructor(private readonly threadId: string, private readonly client: Pick<CodexAppServerClient, 'request'>,
        private readonly home: string) {}
    invalidate(reset = true) {
        this.revision++; this.dirty = true;
        if (reset) { this.cached.clear(); this.expected.clear(); this.epoch = freshNativeHistoryEpoch(); }
    }
    terminal(turn: Record<string, unknown>) {
        const id = string(turn.id); const status = string(turn.status);
        if (id && status) { this.expected.set(id, status); this.dirty = true; }
        // Retain notification expectations until the native index confirms them.
    }
    private reconcileCoordinates(indices: Iterable<NativeHistoryMetadata>) {
        let changed = false;
        for (const index of indices) {
            const previous = this.metadataCoordinates.get(index.threadId);
            if (previous !== undefined && previous !== index.coordinates) changed = true;
            this.metadataCoordinates.set(index.threadId, index.coordinates);
        }
        // One response uses one epoch, including authorized descendant positions.
        // Clear old root projections before a later page/context compares them.
        if (changed) { this.epoch = freshNativeHistoryEpoch(); this.cached.clear(); }
    }
    private async synchronize(index: NativeHistoryMetadata) {
        if (!this.dirty) return;
        const page = record(await this.client.request('thread/turns/list', {
            threadId: this.threadId, limit: 32, sortDirection: 'desc', itemsView: 'notLoaded'
        }));
        if (!Array.isArray(page.data)) throw new NativeMetadataUnavailable();
        for (const raw of page.data) {
            const turn = record(raw); const native = index.turn(String(turn.id));
            if (!Array.isArray(turn.items) || turn.items.length || native.status !== turn.status
                || native.started_at !== turn.startedAt || native.completed_at !== turn.completedAt) throw new NativeMetadataUnavailable();
        }
        let confirmed = 0;
        for (const [id, status] of this.expected) {
            if (confirmed++ === 32) break;
            if (index.turn(id).status !== status) throw new NativeMetadataUnavailable();
            this.expected.delete(id);
        }
        // A burst is drained in bounded reads, never silently forgotten or
        // turned into an unbounded query pass over the native history.
        if (this.expected.size) throw new NativeMetadataUnavailable();
        this.dirty = false;
    }
    private sources(index: NativeHistoryMetadata, ordinal: number, direction: 'asc' | 'desc', userOnly = false) {
        const items: Source[] = index.items(ordinal, direction, 32, userOnly).map(item => ({ kind: 'item', ordinal: item.rollout_ordinal, item }));
        const turns: Source[] = userOnly ? [] : index.turns(ordinal, direction, 32).map(turn => ({ kind: 'turn', ordinal: turn.rollout_end_ordinal!, turn }));
        const sources = [...items, ...turns].sort((a, b) => (a.ordinal - b.ordinal) * (direction === 'asc' ? 1 : -1));
        return { sources: sources.slice(0, PAGE_SOURCES), more: sources.length > PAGE_SOURCES };
    }
    private async bodies(index: NativeHistoryMetadata, items: NativeItemMetadata[]): Promise<Map<string, Record<string, unknown>>> {
        if (!items.length) return new Map();
        const first = [...items].sort((a, b) => a.rollout_ordinal - b.rollout_ordinal)[0];
        // A real preceding item in this turn provides an exclusive anchor for
        // exactly this item. The first item in a turn needs no anchor.
        const predecessor = index.predecessor(first);
        const start = record(await this.client.request('thread/items/list', {
            threadId: this.threadId, turnId: first.turn_id,
            ...(predecessor ? { cursor: { type: 'item', itemId: predecessor.item_id } } : {}),
            sortDirection: 'asc', limit: 1
        }));
        if (!Array.isArray(start.data) || start.data.length !== 1
            || record(start.data[0]).turnId !== first.turn_id || record(record(start.data[0]).item).id !== first.item_id)
            throw new NativeMetadataUnavailable();
        if (items.length === 1) return new Map([[`${first.turn_id}:${first.item_id}`, record(start.data[0])]]);
        const boundary = string(start.backwardsCursor);
        if (!boundary) throw new NativeMetadataUnavailable();
        // Reverse with the server-issued opaque cursor, then reverse again to
        // start a global contiguous page at the inclusive first item.
        const inclusive = record(await this.client.request('thread/items/list', {
            threadId: this.threadId, cursor: boundary, sortDirection: 'desc', limit: 1
        }));
        const cursor = string(inclusive.backwardsCursor);
        if (!cursor) throw new NativeMetadataUnavailable();
        const page = record(await this.client.request('thread/items/list', {
            threadId: this.threadId, cursor, sortDirection: 'asc', limit: items.length
        }));
        if (!Array.isArray(page.data)) throw new NativeMetadataUnavailable();
        const result = new Map(page.data.map(raw => {
            const entry = record(raw); return [`${entry.turnId}:${record(entry.item).id}`, entry] as const;
        }));
        if (items.some(item => !result.has(`${item.turn_id}:${item.item_id}`))) throw new NativeMetadataUnavailable();
        return result;
    }
    private async materialize(index: NativeHistoryMetadata, sources: Source[]): Promise<DecryptedMessage[]> {
        const bodies = await this.bodies(index, sources.flatMap(source => source.kind === 'item' ? [source.item] : []));
        const output = new Map<string, DecryptedMessage>();
        for (const source of sources) {
            const turn = source.kind === 'turn' ? index.turn(source.turn.turn_id) : index.turn(source.item.turn_id);
            const at = index.positionAt(source.ordinal);
            const append = (id: string, localId: string, content: unknown, ordinal: number, createdAt: number) => {
                const message: DecryptedMessage = { id, localId, content, seq: source.ordinal * SCALE + ordinal,
                    createdAt, invokedAt: at, scheduledAt: null };
                const previous = this.cached.get(id);
                if (previous && (previous.invokedAt !== at || previous.seq !== message.seq
                    || JSON.stringify(previous.content) !== JSON.stringify(content))) this.epoch = freshNativeHistoryEpoch();
                this.cached.delete(id); this.cached.set(id, message); output.set(id, message);
            };
            if (source.kind === 'turn') {
                if (turn.status !== source.turn.status || turn.rollout_end_ordinal !== source.ordinal) throw new NativeMetadataUnavailable();
                const id = stopId(this.threadId, turn.turn_id);
                if (turn.status === 'interrupted') {
                    const localId = `codex:${this.threadId}:${turn.turn_id}:turn_aborted`;
                    // Reuse the durable stop event wire/render path, with a separate turn origin.
                    append(id, localId, { role: 'agent', content: { type: 'event', data: { type: 'message', message: 'Aborted by user' }, id: localId } },
                        9999, (turn.completed_at ?? turn.started_at!) * 1000);
                } else if (this.cached.delete(id)) this.epoch = freshNativeHistoryEpoch();
                continue;
            }
            const entry = bodies.get(`${source.item.turn_id}:${source.item.item_id}`)!;
            const prefix = `native:${this.threadId}:${turn.turn_id}:${source.item.item_id}:`;
            const previousIds = [...this.cached.keys()].filter(id => id.startsWith(prefix));
            let ordinal = 0;
            const emitted = new Map<string, number>();
            const write = (content: unknown, stableId: string) => {
                const id = `native:${this.threadId}:${turn.turn_id}:${source.item.item_id}:${encodeURIComponent(stableId)}`;
                const order = emitted.get(id) ?? ++ordinal; emitted.set(id, order);
                append(id, stableId, content, order, source.item.started_at_ms ?? source.item.created_at_ms);
            };
            const sink = { getMetadata: () => null, updateMetadata: () => {},
                sendUserMessage: (text: string, _meta: unknown, id: string) => write({ role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'cli' } }, id),
                sendAgentMessage: (body: unknown) => write({ role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: body }, meta: { sentFrom: 'cli' } }, string(record(body).id)!),
                sendSessionEvent: (event: unknown, id: string) => write({ role: 'agent', content: { type: 'event', data: event, id } }, id)
            } as unknown as ApiSessionClient;
            // Terminal status is projected exactly once by its own metadata row.
            await new SharedCodexProjection(sink, this.threadId, async () => {}, undefined, true).history({ turns: [{ id: turn.turn_id,
                status: 'completed', items: [entry.item] }] });
            for (const id of previousIds) if (!emitted.has(id)) { this.cached.delete(id); this.epoch = freshNativeHistoryEpoch(); }
        }
        while (this.cached.size > 512) this.cached.delete(this.cached.keys().next().value!);
        const ordered = [...output.values()].sort((a, b) => a.seq! - b.seq!);
        if (ordered.some((message, i) => i > 0 && message.invokedAt! < ordered[i - 1].invokedAt!))
            throw new NativeMetadataUnavailable();
        return ordered;
    }
    private frontier(index: NativeHistoryMetadata, source: Source, direction: 'asc' | 'desc'): Position {
        return { at: index.positionAt(source.ordinal), seq: source.ordinal * SCALE + (direction === 'asc' ? 9999 : 0) };
    }
    private head(index: NativeHistoryMetadata): Position | null {
        const item = index.items(Number.MAX_SAFE_INTEGER, 'desc', 1)[0];
        const turn = index.turns(Number.MAX_SAFE_INTEGER, 'desc', 1)[0];
        const latest: Source | undefined = turn && (!item || turn.rollout_end_ordinal! > item.rollout_ordinal)
            ? { kind: 'turn', ordinal: turn.rollout_end_ordinal!, turn }
            : item ? { kind: 'item', ordinal: item.rollout_ordinal, item } : undefined;
        return latest ? this.frontier(index, latest, 'asc') : null;
    }
    private anchor(index: NativeHistoryMetadata, id: string): Source {
        const parts = id.split(':');
        if (parts[0] === 'native-turn-status' && parts[1] === this.threadId && parts[3] === 'turn_aborted') {
            const turn = index.turn(parts[2]);
            if (turn.status !== 'interrupted') throw new NativeMetadataUnavailable();
            return { kind: 'turn', ordinal: turn.rollout_end_ordinal!, turn };
        }
        if (parts[0] !== 'native' || parts[1] !== this.threadId || !parts[2] || !parts[3]) throw new Error('Native message not found');
        const item = index.item(parts[2], parts[3]);
        return { kind: 'item', ordinal: item.rollout_ordinal, item };
    }
    async read(raw: unknown): Promise<MessagesResponse | MessageContextResponse | MessageOutlineResponse> {
        const revision = this.revision;
        let database: ReturnType<typeof openNativeMetadata> | undefined;
        try {
            if (!this.home) throw new NativeMetadataUnavailable();
            database = openNativeMetadata(this.home);
            const generations = nativeMetadataGenerations(this.home, this.threadId);
            // One read transaction keeps source boundaries and snapshotHead on
            // the same native metadata snapshot while bounded body RPCs await.
            database.query('BEGIN').get();
            const index = new NativeHistoryMetadata(database, this.threadId, generations.ids, generations.cutovers);
            await this.synchronize(index);
            // Earlier projections can still receive late metadata updates.
            // A changed generation span invalidates old coordinates before
            // applying any cursor; stable message IDs remain context anchors.
            this.reconcileCoordinates([index]);
            const request = record(raw);
            const epochBeforeRead = this.epoch;
            let result: MessagesResponse | MessageContextResponse | MessageOutlineResponse;
            if (request.operation === 'context') result = await this.context(index, request);
            else if (request.operation === 'outline') result = await this.outline(index, request);
            else result = await this.page(index, request);
            if (revision !== this.revision) throw new NativeMetadataUnavailable();
            if (this.epoch !== epochBeforeRead && request.operation !== 'context' && request.operation !== 'outline')
                result = await this.page(index, { ...request, beforeAt: undefined, beforeSeq: undefined, afterAt: undefined, afterSeq: undefined });
            result.page.reset = request.epoch !== undefined && request.epoch !== this.epoch;
            if (revision !== this.revision) throw new NativeMetadataUnavailable();
            return result;
        } catch (error) {
            this.dirty = true;
            if (error instanceof NativeMetadataUnavailable) throw error;
            // SQLite errors can contain private paths. Expose a retryable product error.
            throw new NativeMetadataUnavailable();
        } finally { database?.close(); }
    }
    dependencies(raw: unknown, result: Pick<MessageDependenciesResponse, 'messages' | 'issues' | 'pendingMessageIds' | 'complete'>,
        origins: ReadonlyMap<string, { threadId: string; turnId: string; itemId: string }>): MessageDependenciesResponse {
        const request = MessageDependenciesQuerySchema.parse(raw); const seeds = request.seeds;
        let database: ReturnType<typeof openNativeMetadata> | undefined;
        try {
            if (!this.home) throw new NativeMetadataUnavailable();
            const metadataDatabase = openNativeMetadata(this.home);
            database = metadataDatabase;
            metadataDatabase.query('BEGIN').get();
            const indices = new Map<string, NativeHistoryMetadata>();
            const indexFor = (threadId: string) => {
                let index = indices.get(threadId);
                if (!index) {
                    const generations = nativeMetadataGenerations(this.home, threadId);
                    index = new NativeHistoryMetadata(metadataDatabase, threadId, generations.ids, generations.cutovers);
                    indices.set(threadId, index);
                }
                return index;
            };
            // Reconcile root coordinates even for descendant-only or empty seeds.
            indexFor(this.threadId);
            // The outer reader only records descendants reached through native
            // agent-call facts. Never authorize a thread by parsing a client ID.
            const source = (id: string) => {
                const origin = origins.get(id);
                if (!origin || !id.startsWith(`native:${origin.threadId}:${origin.turnId}:${origin.itemId}:`))
                    throw new NativeMetadataUnavailable();
                const index = indexFor(origin.threadId);
                return { item: index.item(origin.turnId, origin.itemId), index };
            };
            for (const id of seeds) source(id);
            const messages = result.messages.map(message => {
                const { item, index } = source(message.id);
                return { ...message, seq: item.rollout_ordinal * SCALE + message.seq! % SCALE, invokedAt: index.positionAt(item.rollout_ordinal) };
            });
            this.reconcileCoordinates(indices.values());
            return { ...result, messages, epoch: this.epoch, reset: request.epoch !== this.epoch,
                seedMessageIds: seeds, indexReady: true, indexScanned: true };
        } catch { throw new NativeMetadataUnavailable(); } finally { database?.close(); }
    }
    private async page(index: NativeHistoryMetadata, raw: Record<string, unknown>): Promise<MessagesResponse> {
        const q = MessagesQuerySchema.parse({ ...raw, ...(typeof raw.bounded === 'boolean' ? { bounded: String(raw.bounded) } : {}) });
        const reset = q.epoch !== undefined && q.epoch !== this.epoch;
        const before = reset ? undefined : q.beforeSeq; const after = reset ? undefined : q.afterSeq;
        const direction = after !== undefined ? 'asc' : 'desc';
        const boundary = Math.floor((before ?? after ?? Number.MAX_SAFE_INTEGER) / SCALE);
        const page = this.sources(index, before === undefined && after === undefined ? Number.MAX_SAFE_INTEGER : boundary, direction);
        const all = (await this.materialize(index, page.sources)).filter(m => (before === undefined || m.seq! < before)
            && (after === undefined || m.seq! > after) && (q.untilSeq === undefined || m.seq! <= q.untilSeq));
        if (all.some(message => before !== undefined && message.invokedAt! > q.beforeAt!
            || after !== undefined && message.invokedAt! < q.afterAt!)) throw new NativeMetadataUnavailable();
        const limit = q.limit ?? 50;
        const selected = after !== undefined ? all.slice(0, limit) : all.slice(-limit);
        const scanned = page.sources.at(-1) ? this.frontier(index, page.sources.at(-1)!, direction) : null;
        const first = selected[0] ? position(selected[0]) : scanned;
        const last = selected.at(-1) ? position(selected.at(-1)!) : scanned;
        const head = this.head(index);
        return { messages: selected, page: { direction: after !== undefined ? 'after' : before !== undefined ? 'before' : 'latest',
            limit, epoch: this.epoch, reset, nextBeforeAt: first?.at ?? null, nextBeforeSeq: first?.seq ?? null,
            nextAfterAt: last?.at ?? null, nextAfterSeq: last?.seq ?? null, snapshotHeadAt: head?.at ?? null, snapshotHeadSeq: head?.seq ?? null,
            hasMore: all.length > selected.length || page.more && (after === undefined || q.untilSeq === undefined || !scanned || scanned.seq < q.untilSeq) } };
    }
    private async context(index: NativeHistoryMetadata, raw: Record<string, unknown>): Promise<MessageContextResponse> {
        const q = MessageContextQuerySchema.parse(raw); const id = String(raw.messageId); const source = this.anchor(index, id);
        const before = this.sources(index, source.ordinal, 'desc'); const after = this.sources(index, source.ordinal, 'asc');
        const unique = new Map([...before.sources, ...after.sources].map(entry => [`${entry.kind}:${entry.ordinal}`, entry]));
        // Each direction is a separate bounded body window.
        const rows = new Map((await this.materialize(index, before.sources)).map(message => [message.id, message]));
        for (const message of await this.materialize(index, after.sources)) rows.set(message.id, message);
        // A dense window must always include its exact independent anchor.
        if (![...unique.values()].some(entry => entry.kind === source.kind && entry.ordinal === source.ordinal))
            for (const message of await this.materialize(index, [source])) rows.set(message.id, message);
        const ordered = [...rows.values()].sort((a, b) => a.seq! - b.seq!);
        const anchor = ordered.find(message => message.id === id);
        if (!anchor) throw new Error('Native message not found');
        const offset = ordered.indexOf(anchor); const messages = ordered.slice(Math.max(0, offset - q.radius), offset + q.radius + 1);
        return { anchor: { messageId: id, position: position(anchor) }, messages, page: { epoch: this.epoch,
            reset: q.epoch !== undefined && q.epoch !== this.epoch, beforeCursor: position(messages[0]), afterCursor: position(messages.at(-1)!),
            hasMoreBefore: before.more || offset > q.radius, hasMoreAfter: after.more || ordered.length - offset - 1 > q.radius,
            snapshotHead: this.head(index)! } };
    }
    private async outline(index: NativeHistoryMetadata, raw: Record<string, unknown>): Promise<MessageOutlineResponse> {
        const q = MessageOutlineQuerySchema.parse(raw); const reset = q.epoch !== undefined && q.epoch !== this.epoch;
        const seq = reset ? undefined : q.beforeSeq;
        const page = this.sources(index, seq === undefined ? Number.MAX_SAFE_INTEGER : Math.floor(seq / SCALE), 'desc', true);
        // User messages may be far apart: fetch each via a genuine item anchor.
        const rows: DecryptedMessage[] = [];
        for (let offset = 0; offset < page.sources.length; offset += 4) {
            const batch = await Promise.all(page.sources.slice(offset, offset + 4).map(source => this.materialize(index, [source])));
            for (const messages of batch) rows.push(...messages);
        }
        const labels = rows.flatMap(message => {
            const label = extractConversationOutlineLabel(message.content);
            return label && (seq === undefined || message.seq! < seq) ? [{ messageId: message.id, label, ...position(message), createdAt: message.createdAt }] : [];
        }).sort((a, b) => a.seq - b.seq);
        const entries = labels.slice(-q.limit); const scanned = page.sources.at(-1) && this.frontier(index, page.sources.at(-1)!, 'desc');
        const head = this.head(index);
        return { entries, page: { epoch: this.epoch, reset, hasMore: page.more || labels.length > entries.length,
            beforeCursor: entries[0] ? { at: entries[0].at, seq: entries[0].seq } : scanned ?? null,
            scannedThrough: head?.seq ?? 0, headSeq: head?.seq ?? 0, complete: !page.more, unreadable: false, indexing: false } };
    }
}
