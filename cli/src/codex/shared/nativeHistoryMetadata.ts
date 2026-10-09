import { createRequire } from 'node:module';
import { closeSync, globSync, openSync, readSync } from 'node:fs';
import { basename, join } from 'node:path';

export class NativeMetadataUnavailable extends Error {
    readonly retryable = true;
    constructor() { super('Native Codex history metadata is unavailable or not yet synchronized; retry the history read'); }
}
export type NativeTurnMetadata = {
    turn_id: string; status: string; started_at: number | null; completed_at: number | null;
    rollout_ordinal: number; rollout_end_ordinal: number | null;
};
export type NativeItemMetadata = {
    turn_id: string; item_id: string; rollout_ordinal: number; created_at_ms: number;
    started_at_ms: number | null; completed_at_ms: number | null;
};
type Statement = { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
export type NativeMetadataDatabase = { query(sql: string): Statement; close(): void };
const require = createRequire(import.meta.url);

/** Read only the native sparse index. Never select item_json or replay rollouts. */
export function openNativeMetadata(home: string): NativeMetadataDatabase {
    const path = join(home, 'thread_history_1.sqlite');
    if (typeof Bun !== 'undefined') {
        const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
        return new Database(path, { readonly: true }) as unknown as NativeMetadataDatabase;
    }
    // Vitest runs on Node; both adapters execute the same SQLite queries/files.
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const database = new DatabaseSync(path, { readOnly: true });
    return { query: sql => database.prepare(sql) as unknown as Statement, close: () => database.close() };
}
const TURN_COLUMNS = 'turn_id, status, started_at, completed_at, rollout_ordinal, rollout_end_ordinal';
const ITEM_COLUMNS = 'turn_id, item_id, rollout_ordinal, created_at_ms, started_at_ms, completed_at_ms';

/** Native execution replacement retains the public thread ID but stores the
 * current rollout projection under the execution suffix in its official path. */
export function nativeMetadataThreadId(threadId: string, rolloutPath?: string): string {
    const suffix = rolloutPath && basename(rolloutPath).match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    return suffix ? suffix[1] : threadId;
}

type NativeSessionHeader = { ordinal: number; payload: { id: string; forked_from_id?: string; forked_from_ordinal_exclusive?: number } };
function sessionHeader(path: string, threadId: string): NativeSessionHeader {
    const fd = openSync(path, 'r');
    const chunks: Buffer[] = [];
    try {
        const chunk = Buffer.alloc(4096);
        while (true) {
            const bytes = readSync(fd, chunk, 0, chunk.length, null);
            if (!bytes) break;
            const newline = chunk.subarray(0, bytes).indexOf(10);
            chunks.push(Buffer.from(chunk.subarray(0, newline < 0 ? bytes : newline)));
            if (newline >= 0) break;
        }
    } finally { closeSync(fd); }
    const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (metadata.type !== 'session_meta' || metadata.payload?.id !== threadId || !Number.isSafeInteger(metadata.ordinal)) throw new NativeMetadataUnavailable();
    return metadata;
}

/** Session headers define replacement cutovers and inherited fork ranges.
 * Read only these headers, never transcript lines or SQLite item bodies. */
export function nativeMetadataGenerations(home: string, threadId: string): { ids: string[]; cutovers: ReadonlyMap<string, number> } {
    const ids: string[] = [];
    const cutovers = new Map<string, number>();
    const ancestry = new Set<string>();
    const visit = (id: string, inheritedCutoff?: number) => {
        if (ancestry.has(id)) throw new NativeMetadataUnavailable();
        ancestry.add(id);
        const paths = globSync(join(home, 'sessions', '*', '*', '*', `rollout-*-${id}*.jsonl`)).sort();
        const headers = paths.map(path => ({ id: nativeMetadataThreadId(id, path), header: sessionHeader(path, id) }));
        const parent = headers[0]?.header.payload;
        // Older forks copied their inherited history into the child's rollout.
        // Only sparse forks with an explicit cutoff read the parent index; a
        // legacy fork must use its own index to avoid adding the parent's later branch.
        if (parent?.forked_from_id && parent.forked_from_ordinal_exclusive != null) {
            if (!Number.isSafeInteger(parent.forked_from_ordinal_exclusive)) throw new NativeMetadataUnavailable();
            visit(parent.forked_from_id, inheritedCutoff === undefined ? parent.forked_from_ordinal_exclusive : Math.min(parent.forked_from_ordinal_exclusive!, inheritedCutoff));
        }
        const generations = [{ id, ordinal: 0 }, ...headers.filter(value => value.id !== id).map(value => ({ id: value.id, ordinal: value.header.ordinal }))];
        for (const [index, generation] of generations.entries()) {
            if (inheritedCutoff !== undefined && generation.ordinal >= inheritedCutoff) break;
            const next = generations[index + 1]?.ordinal;
            const cutoff = next === undefined ? inheritedCutoff : inheritedCutoff === undefined ? next : Math.min(next, inheritedCutoff);
            ids.push(generation.id);
            if (cutoff !== undefined) cutovers.set(generation.id, cutoff);
        }
        ancestry.delete(id);
    };
    visit(threadId);
    return { ids, cutovers };
}
export function nativeMetadataThreadIds(home: string, threadId: string): string[] {
    return nativeMetadataGenerations(home, threadId).ids;
}
export function nativeMetadataCutovers(home: string, threadId: string): ReadonlyMap<string, number> {
    return nativeMetadataGenerations(home, threadId).cutovers;
}

export class NativeHistoryMetadata {
    private readonly generations: Array<{ id: string; offset: number; cutoff?: number }> = [];
    private interruptedWithoutEnd: ReadonlySet<string> = new Set();
    /** The native API marks stale open turns interrupted without writing an end
     * event. Preserve that status without inventing a timestamp or ordinal. */
    setInterruptedWithoutEnd(turnIds: ReadonlySet<string>): void { this.interruptedWithoutEnd = turnIds; }
    get coordinates(): string { return this.generations.map(generation => `${generation.id}:${generation.offset}:${generation.cutoff ?? 'head'}`).join('|'); }
    constructor(private readonly database: NativeMetadataDatabase, readonly threadId: string, aliases: string[] = [threadId], cutovers: ReadonlyMap<string, number> = new Map()) {
        let offset = 0;
        for (const id of aliases) {
            this.generations.push({ id, offset, cutoff: cutovers.get(id) });
            const max = database.query(`SELECT MAX(value) AS ordinal FROM (
                SELECT MAX(rollout_ordinal) AS value FROM thread_items WHERE thread_id = ?
                UNION ALL SELECT MAX(rollout_end_ordinal) FROM thread_turns WHERE thread_id = ?
                UNION ALL SELECT MAX(rollout_ordinal) FROM thread_turns WHERE thread_id = ?)`)
                .get(id, id, id) as { ordinal: number | null };
            offset += (max.ordinal ?? 0) + 1;
        }
    }
    private latest(table: 'thread_items' | 'thread_turns', key: string, values: unknown[]) {
        for (const generation of [...this.generations].reverse()) {
            const row = this.database.query(`SELECT ${table === 'thread_items' ? ITEM_COLUMNS : TURN_COLUMNS}
                FROM ${table} WHERE thread_id = ? AND ${key} ${generation.cutoff === undefined ? '' : `AND rollout_ordinal < ${generation.cutoff}`}`).get(generation.id, ...values) as NativeItemMetadata | NativeTurnMetadata | undefined;
            if (row) return this.shift(row, generation.offset);
        }
        return undefined;
    }
    private shift<T extends NativeItemMetadata | NativeTurnMetadata>(row: T, offset: number): T {
        return { ...row, rollout_ordinal: row.rollout_ordinal + offset,
            ...('rollout_end_ordinal' in row ? { rollout_end_ordinal: row.rollout_end_ordinal == null ? null : row.rollout_end_ordinal + offset } : {}) };
    }
    positionAt(ordinal: number): number {
        for (const generation of [...this.generations].reverse()) {
            if (ordinal < generation.offset) continue;
            const row = this.database.query(`SELECT started_at, completed_at FROM thread_turns WHERE thread_id = ?
                AND rollout_ordinal <= ? ${generation.cutoff === undefined ? '' : `AND rollout_ordinal < ${generation.cutoff}`} ORDER BY rollout_ordinal DESC LIMIT 1`).get(generation.id, ordinal - generation.offset) as Pick<NativeTurnMetadata, 'started_at' | 'completed_at'> | undefined;
            if (row && (row.started_at != null || row.completed_at != null)) return (row.started_at ?? row.completed_at)! * 1000;
        }
        throw new NativeMetadataUnavailable();
    }
    turn(turnId: string): NativeTurnMetadata {
        const row = this.latest('thread_turns', 'turn_id = ?', [turnId]) as NativeTurnMetadata | undefined;
        if (!row || !['inProgress', 'completed', 'interrupted', 'failed'].includes(row.status)
            || (row.started_at == null && row.completed_at == null) || !Number.isSafeInteger(row.rollout_ordinal)
            || (row.status !== 'inProgress' && !Number.isSafeInteger(row.rollout_end_ordinal))) throw new NativeMetadataUnavailable();
        return this.interruptedWithoutEnd.has(turnId) && row.status === 'inProgress'
            && row.completed_at === null && row.rollout_end_ordinal === null
            ? { ...row, status: 'interrupted' } : row;
    }
    /** Error metadata is read only for the failed turn currently being paged. */
    failure(turnId: string): unknown {
        for (const generation of [...this.generations].reverse()) {
            const row = this.database.query(`SELECT error_json FROM thread_turns WHERE thread_id = ? AND turn_id = ?
                ${generation.cutoff === undefined ? '' : `AND rollout_ordinal < ${generation.cutoff}`}`)
                .get(generation.id, turnId) as { error_json: string | null } | undefined;
            if (row) return row.error_json == null ? null : JSON.parse(row.error_json);
        }
        throw new NativeMetadataUnavailable();
    }
    item(turnId: string, itemId: string): NativeItemMetadata {
        const row = this.latest('thread_items', 'turn_id = ? AND item_id = ?', [turnId, itemId]) as NativeItemMetadata | undefined;
        if (!row || !Number.isSafeInteger(row.rollout_ordinal)) throw new NativeMetadataUnavailable();
        return row;
    }
    predecessor(item: NativeItemMetadata): NativeItemMetadata | undefined {
        // Scope to the selected execution; an old projection must not anchor a
        // body read into a different execution's duplicate item.
        const generation = [...this.generations].reverse().find(g => item.rollout_ordinal >= g.offset)!;
        const row = this.database.query(`SELECT ${ITEM_COLUMNS} FROM thread_items WHERE thread_id = ? AND turn_id = ?
            AND rollout_ordinal < ? ${generation.cutoff === undefined ? '' : `AND rollout_ordinal < ${generation.cutoff}`} ORDER BY rollout_ordinal DESC LIMIT 1`).get(generation.id, item.turn_id, item.rollout_ordinal - generation.offset) as NativeItemMetadata | undefined;
        return row && this.shift(row, generation.offset);
    }
    private page(table: 'thread_items' | 'thread_turns', boundary: number, direction: 'asc' | 'desc', limit: number, userOnly = false) {
        const column = table === 'thread_items' ? 'rollout_ordinal' : 'rollout_end_ordinal';
        const rows: Array<NativeItemMetadata | NativeTurnMetadata> = [];
        for (const [generationIndex, generation] of this.generations.entries()) {
            const newer = this.generations.slice(generationIndex + 1);
            const shadow = newer.length ? `AND NOT EXISTS (SELECT 1 FROM ${table} newer WHERE (${newer.map(value => `(newer.thread_id = ? ${value.cutoff === undefined ? '' : `AND newer.${column} < ${value.cutoff}`})`).join(' OR ')}) AND newer.turn_id = ${table}.turn_id ${table === 'thread_items' ? `AND newer.item_id = ${table}.item_id` : ''})` : '';
            const local = boundary - generation.offset;
            if (direction === 'desc' && local < 0) continue;
            const candidates = this.database.query(`SELECT ${table === 'thread_items' ? ITEM_COLUMNS : TURN_COLUMNS}
                FROM ${table} WHERE thread_id = ? AND ${column} ${direction === 'asc' ? '>=' : '<='} ?
                ${generation.cutoff === undefined ? '' : `AND ${column} < ${generation.cutoff}`} ${shadow} ${userOnly ? "AND item_type = 'userMessage'" : ''} ORDER BY ${column} ${direction} LIMIT ?`)
                .all(generation.id, local, ...newer.map(value => value.id), limit) as Array<NativeItemMetadata | NativeTurnMetadata>;
            for (const raw of candidates) {
                const row = this.shift(raw, generation.offset);
                rows.push(row);
            }
        }
        return rows.sort((a, b) => ((column === 'rollout_ordinal' ? a.rollout_ordinal : (a as NativeTurnMetadata).rollout_end_ordinal!) - (column === 'rollout_ordinal' ? b.rollout_ordinal : (b as NativeTurnMetadata).rollout_end_ordinal!)) * (direction === 'asc' ? 1 : -1)).slice(0, limit);
    }
    items(boundary: number, direction: 'asc' | 'desc', limit = 33, userOnly = false): NativeItemMetadata[] {
        return this.page('thread_items', boundary, direction, limit, userOnly) as NativeItemMetadata[];
    }
    turns(boundary: number, direction: 'asc' | 'desc', limit = 33): NativeTurnMetadata[] {
        return this.page('thread_turns', boundary, direction, limit) as NativeTurnMetadata[];
    }
}
