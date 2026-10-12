import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeForkBoundary } from '@hapi/protocol/apiTypes';
import { NativeForkFixture, FORK_PARENT_ID, FORK_EXECUTION_ID, type ForkSegment } from '@/test/nativeForkFixture';
import { resolveNativeForkBoundary } from './nativeForkBoundary';

type Query = { sql: string; params: unknown[]; rows: number; plan: string[] };
const audit = vi.hoisted(() => ({
    queries: [] as Query[], bytes: 0, reads: 0, directoryReads: 0, opened: 0, closed: 0,
    directory: null as null | ((path: string) => unknown),
    beforeQuery: null as null | ((sql: string, params: unknown[]) => void),
}));

vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual,
        readSync: (...args: Parameters<typeof actual.readSync>) => {
            const bytes = actual.readSync(...args);
            audit.bytes += bytes; audit.reads++;
            return bytes;
        },
        opendirSync: (...args: Parameters<typeof actual.opendirSync>) => {
            const directory = audit.directory?.(String(args[0])) as ReturnType<typeof actual.opendirSync> | undefined;
            const result = directory ?? actual.opendirSync(...args);
            return { readSync: () => { audit.directoryReads++; return result.readSync(); }, closeSync: () => result.closeSync() };
        },
    };
});

// Only instrument the real read-only adapter. The fixture and every resolver
// WHERE/PK/range test still execute SQLite; no mocked row lookup is involved.
vi.mock('./nativeHistoryMetadata', async importOriginal => {
    const actual = await importOriginal<typeof import('./nativeHistoryMetadata')>();
    return { ...actual, openNativeMetadata: (home: string) => {
        const database = actual.openNativeMetadata(home);
        audit.opened++;
        return {
            query: (sql: string) => {
                if (/^\s*SELECT/i.test(sql) && /\b(?:item_json|item_type)\b|\*/i.test(sql)) {
                    throw new Error('Forbidden body or post-body column read');
                }
                const statement = database.query(sql);
                const call = (method: 'get' | 'all', params: unknown[]) => {
                    audit.beforeQuery?.(sql, params);
                    const plan = /^\s*SELECT/i.test(sql)
                        ? (database.query(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map(row => row.detail) : [];
                    const value = statement[method](...params);
                    audit.queries.push({ sql, params, rows: Array.isArray(value) ? value.length : value === undefined ? 0 : 1, plan });
                    return value;
                };
                return { get: (...params: unknown[]) => call('get', params), all: (...params: unknown[]) => call('all', params) };
            },
            close: () => { audit.closed++; database.close(); },
        };
    } };
});

const cleanups: Array<() => void> = [];
beforeEach(() => {
    audit.queries = []; audit.bytes = 0; audit.reads = 0; audit.directoryReads = 0;
    audit.opened = 0; audit.closed = 0; audit.directory = null; audit.beforeQuery = null;
});
afterEach(() => { audit.beforeQuery = null; audit.directory = null; for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
    const home = mkdtempSync(join(tmpdir(), 'native-fork-boundary-'));
    const source = new NativeForkFixture(home);
    cleanups.push(() => { source.close(); rmSync(home, { recursive: true, force: true }); });
    return source;
}
const selectQueries = () => audit.queries.filter(query => /^\s*SELECT/i.test(query.sql));
const inherited = (segment: ForkSegment, boundary: NativeForkBoundary) => ({ ...boundary, threadId: segment.thread.id });
const uuid = (index: number) => `0197ad6a-76ca-7000-8000-${index.toString().padStart(12, '0')}`;
function requireIndexedPointReads(count: number) {
    const queries = selectQueries();
    expect(queries).toHaveLength(count);
    for (const query of queries) {
        expect(query.rows).toBeLessThanOrEqual(1);
        expect(query.sql).not.toMatch(/\b(?:item_json|item_type)\b|\*/i);
        expect(query.plan.join(' ')).toMatch(/SEARCH .+ USING INDEX sqlite_autoindex_/i);
        expect(query.plan.join(' ')).not.toMatch(/SCAN|TEMP B-TREE/i);
    }
    expect(audit.closed).toBe(audit.opened);
}

describe('native fork boundary, real SQLite source-turn semantics', () => {
    it('accepts the first turn at ordinal 1 without needing a predecessor or item body', () => {
        const source = fixture(); const segment = source.addSegment(); const boundary = source.addTurn(segment);
        expect(segment.position(1).end_byte_offset).toBeGreaterThan(0);
        expect(resolveNativeForkBoundary(source.home, segment.thread, boundary)).toBe(boundary.turnId);
        requireIndexedPointReads(3);
        expect(audit.directoryReads).toBe(0);
    });

    it.each([null, 3])('accepts a persisted source start for an open/completed turn (end=%s)', endOrdinal => {
        const source = fixture(); const segment = source.addSegment(); const boundary = source.addTurn(segment, { endOrdinal });
        expect(resolveNativeForkBoundary(source.home, segment.thread, boundary)).toBe(boundary.turnId);
    });

    it('rejects an actual steered user item and a forged item ID, then accepts the authoritative first user', () => {
        const source = fixture(); const segment = source.addSegment(); const boundary = source.addTurn(segment);
        source.addItem(segment, boundary.turnId, 'steered-user', 4);
        for (const itemId of ['steered-user', 'forged-user']) {
            expect(() => resolveNativeForkBoundary(source.home, segment.thread, { ...boundary, itemId }))
                .toThrow('Cannot cut inside a steered native turn. Select its first message.');
        }
        expect(resolveNativeForkBoundary(source.home, segment.thread, boundary)).toBe(boundary.turnId);
    });

    it('binds all three selectors to the selected thread and physical item membership', () => {
        const source = fixture(); const selected = source.addSegment(); const boundary = source.addTurn(selected);
        const unrelated = source.addSegment({ threadId: FORK_PARENT_ID });
        source.addTurn(unrelated, { id: 'foreign-turn', itemId: 'foreign-user' });
        expect(() => resolveNativeForkBoundary(source.home, selected.thread, { ...boundary, threadId: FORK_PARENT_ID }))
            .toThrow('source thread mismatch');
        expect(() => resolveNativeForkBoundary(source.home, selected.thread, { ...boundary, turnId: 'foreign-turn', itemId: 'foreign-user' }))
            .toThrow('turn is not in the source history');
        source.database.query('DELETE FROM thread_items WHERE thread_id=? AND turn_id=? AND item_id=?')
            .run(selected.id, boundary.turnId, boundary.itemId);
        // A matching item in another physical thread does not rescue a missing
        // row in the selected one, even with the same native IDs.
        source.addTurn(unrelated, { id: boundary.turnId, itemId: boundary.itemId, ordinal: 5 });
        expect(() => resolveNativeForkBoundary(source.home, selected.thread, boundary)).toThrow('boundary metadata is missing');
    });

    it('follows physical history_base across parent and child, including archived ancestors', () => {
        const source = fixture(); const parent = source.addSegment({ threadId: FORK_PARENT_ID, archive: true });
        const parentBoundary = source.addTurn(parent);
        const child = source.addSegment({ base: parent.position(10) }); const childBoundary = source.addTurn(child, { id: 'child-turn' });
        expect(resolveNativeForkBoundary(source.home, child.thread, inherited(child, parentBoundary))).toBe(parentBoundary.turnId);
        expect(resolveNativeForkBoundary(source.home, child.thread, childBoundary)).toBe(childBoundary.turnId);
        expect(selectQueries().filter(query => /FROM thread_turns/.test(query.sql)).map(query => query.params[0]))
            .toEqual([parent.id, parent.id, child.id]);
    });

    it('excludes a parent turn or first item at and beyond the immutable fork cutoff despite later parent appends', () => {
        const source = fixture(); const parent = source.addSegment({ threadId: FORK_PARENT_ID });
        const before = source.addTurn(parent, { id: 'before', ordinal: 4 });
        const child = source.addSegment({ base: parent.position(10) });
        const at = source.addTurn(parent, { id: 'at-cutoff', ordinal: 10 });
        const after = source.addTurn(parent, { id: 'after-cutoff', ordinal: 15 });
        appendFileSync(parent.path, JSON.stringify({ ordinal: parent.nextOrdinal, type: 'event_msg', payload: { type: 'later_append' } }) + '\n');
        expect(resolveNativeForkBoundary(source.home, child.thread, inherited(child, before))).toBe(before.turnId);
        for (const boundary of [at, after]) {
            expect(() => resolveNativeForkBoundary(source.home, child.thread, inherited(child, boundary))).toThrow('turn is not in the source history');
        }
        source.database.query('UPDATE thread_items SET rollout_ordinal=10 WHERE thread_id=? AND item_id=?').run(parent.id, before.itemId);
        expect(() => resolveNativeForkBoundary(source.home, child.thread, inherited(child, before))).toThrow('outside visible history');
    });

    it('uses the earliest physical source for the same turn, not a newer replacement completion-only row', () => {
        const source = fixture(); const original = source.addSegment();
        const boundary = source.addTurn(original, { id: 'spanning-turn', ordinal: 4 });
        const replacement = source.addSegment({ physicalId: FORK_EXECUTION_ID, base: original.position(10) });
        source.addTurn(replacement, { id: boundary.turnId, itemId: 'newer-user-decoy', firstUserItemId: null,
            endOrdinal: replacement.start });
        source.database.query('DELETE FROM thread_items WHERE thread_id=?').run(replacement.id);
        expect(resolveNativeForkBoundary(source.home, replacement.thread, boundary)).toBe(boundary.turnId);
        requireIndexedPointReads(3);
        expect(selectQueries().every(query => query.params[0] === original.id)).toBe(true);
    });

    it('uses a replacement physical ID even when its public parent has a valid but unrelated decoy turn', () => {
        const source = fixture(); const original = source.addSegment({ threadId: FORK_PARENT_ID });
        source.addTurn(original, { id: 'not-in-lineage' });
        const previous = source.addSegment({ threadId: FORK_PARENT_ID, physicalId: FORK_EXECUTION_ID });
        const boundary = source.addTurn(previous, { id: 'physical-turn' });
        const child = source.addSegment({ base: previous.position(10) });
        expect(resolveNativeForkBoundary(source.home, child.thread, inherited(child, boundary))).toBe(boundary.turnId);
        expect(selectQueries()[0].params[0]).toBe(FORK_EXECUTION_ID);
        expect(() => resolveNativeForkBoundary(source.home, child.thread,
            { threadId: child.thread.id, turnId: 'not-in-lineage', itemId: 'not-in-lineage-user' })).toThrow('turn is not in the source history');
    });

    it('fails closed while ancestor projection is behind, and recovers only after both cutoff checkpoints catch up', () => {
        const source = fixture(); const parent = source.addSegment({ threadId: FORK_PARENT_ID });
        const cutoff = parent.position(10); const child = source.addSegment({ base: cutoff }); const boundary = source.addTurn(child);
        for (const checkpoint of [
            { ordinal: 9, byteOffset: cutoff.end_byte_offset },
            { ordinal: 10, byteOffset: cutoff.end_byte_offset - 1 },
        ]) {
            source.checkpoint(parent, checkpoint);
            expect(() => resolveNativeForkBoundary(source.home, child.thread, boundary)).toThrow('ancestor metadata is not synchronized');
        }
        source.checkpoint(parent, { ordinal: 10, byteOffset: cutoff.end_byte_offset });
        expect(resolveNativeForkBoundary(source.home, child.thread, boundary)).toBe(boundary.turnId);
    });

    it.each([
        ['missing checkpoint', 'DELETE FROM thread_history_projection_state', 'projection checkpoint is unavailable'],
        ['unprojected item', 'UPDATE thread_history_projection_state SET next_rollout_ordinal=2', 'boundary metadata is missing'],
        ['unprojected bytes', 'UPDATE thread_history_projection_state SET next_rollout_byte_offset=0', 'boundary metadata is missing'],
        ['checkpoint beyond EOF', 'UPDATE thread_history_projection_state SET next_rollout_byte_offset=999999', 'projection checkpoint is unavailable'],
        ['missing first user', 'UPDATE thread_turns SET first_user_item_id=NULL', 'first user metadata is not synchronized'],
        ['missing persisted start', 'UPDATE thread_turns SET rollout_byte_offset=NULL', 'turn has no persisted start boundary'],
        ['completion-only turn', 'UPDATE thread_turns SET rollout_end_ordinal=rollout_ordinal', 'turn has no persisted start boundary'],
        ['negative byte offset', 'UPDATE thread_turns SET rollout_byte_offset=-1', 'turn has no persisted start boundary'],
    ])('fails closed on %s and never falls back to a body/projection read', (_name, mutation, message) => {
        const source = fixture(); const segment = source.addSegment(); const boundary = source.addTurn(segment);
        source.database.exec(mutation);
        expect(() => resolveNativeForkBoundary(source.home, segment.thread, boundary)).toThrow(message);
        expect(audit.closed).toBe(1);
        expect(selectQueries().every(query => query.rows <= 1)).toBe(true);
    });

    it.each(['thread_turns', 'thread_items', 'thread_history_projection_state'])('requires the official %s primary key', table => {
        const source = fixture(); const segment = source.addSegment(); const boundary = source.addTurn(segment);
        source.database.exec(`ALTER TABLE ${table} RENAME TO original_table; CREATE TABLE ${table} AS SELECT * FROM original_table;`);
        expect(() => resolveNativeForkBoundary(source.home, segment.thread, boundary)).toThrow(`unsupported ${table} index`);
        expect(selectQueries()).toHaveLength(0);
    });

    it('rejects an old schema with no persisted rollout byte offsets and closes the read connection', () => {
        const source = fixture(); const segment = source.addSegment(); const boundary = source.addTurn(segment);
        source.database.exec('ALTER TABLE thread_turns DROP COLUMN rollout_byte_offset');
        expect(() => resolveNativeForkBoundary(source.home, segment.thread, boundary)).toThrow('required native metadata schema is missing or unreadable');
        expect(audit.closed).toBe(1);
    });

    it('accepts a concurrent append but rejects physical truncation during scalar validation', () => {
        const source = fixture(); const segment = source.addSegment(); const boundary = source.addTurn(segment);
        audit.beforeQuery = sql => {
            if (!/FROM thread_turns/.test(sql)) return;
            audit.beforeQuery = null;
            const line = JSON.stringify({ ordinal: segment.nextOrdinal, type: 'event_msg', payload: { type: 'concurrent_append' } }) + '\n';
            appendFileSync(segment.path, line);
            source.checkpoint(segment, { ordinal: segment.nextOrdinal + 1, byteOffset: segment.size + Buffer.byteLength(line) });
        };
        expect(resolveNativeForkBoundary(source.home, segment.thread, boundary)).toBe(boundary.turnId);
        audit.beforeQuery = sql => {
            if (!/FROM thread_items/.test(sql)) return;
            audit.beforeQuery = null; truncateSync(segment.path, segment.position(4).end_byte_offset);
        };
        expect(() => resolveNativeForkBoundary(source.home, segment.thread, boundary)).toThrow('history changed during boundary validation');
    });
});

describe('native fork boundary bounded work and lineage rejection', () => {
    it('resolves one of 100,000 turns with three primary-key scalar reads', () => {
        const source = fixture(); const segment = source.addSegment({ records: 300_001 });
        source.addTurn(segment);
        source.database.exec(`
            WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<99999)
            INSERT INTO thread_turns (thread_id,turn_id,rollout_ordinal,status,first_user_item_id,rollout_byte_offset,rollout_end_ordinal)
            SELECT '${segment.id}', 'other-'||i, i*3+1, 'completed', 'other-item-'||i, 1, i*3+3 FROM n;
            WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<99999)
            INSERT INTO thread_items (thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,item_type)
            SELECT '${segment.id}', 'other-'||i, 'other-item-'||i, i*3+2, 0, '{}', 'userMessage' FROM n;
        `);
        expect(source.database.query('SELECT COUNT(*) AS count FROM thread_turns').get().count).toBe(100_000);
        const boundary = { threadId: segment.id, turnId: 'other-99999', itemId: 'other-item-99999' };
        source.database.query('UPDATE thread_turns SET rollout_byte_offset=? WHERE thread_id=? AND turn_id=?')
            .run(segment.position(299_998).end_byte_offset, segment.id, boundary.turnId);
        expect(resolveNativeForkBoundary(source.home, segment.thread, boundary)).toBe(boundary.turnId);
        requireIndexedPointReads(3);
        expect(audit.bytes).toBeLessThanOrEqual(4096);
        expect(audit.directoryReads).toBe(0);
    });

    it('stays indexed with 100,000 items in one turn, including a 16 MiB first-user JSON body', () => {
        const source = fixture(); const segment = source.addSegment({ records: 100_005 });
        const boundary = source.addTurn(segment, { endOrdinal: 100_004 });
        source.database.exec(`
            WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<99999)
            INSERT INTO thread_items (thread_id,turn_id,item_id,rollout_ordinal,created_at_ms,item_json,item_type)
            SELECT '${segment.id}', '${boundary.turnId}', 'tool-'||i, i+2, 0, '{}', 'commandExecution' FROM n;
        `);
        source.database.query('UPDATE thread_items SET item_json=? WHERE thread_id=? AND turn_id=? AND item_id=?')
            .run(JSON.stringify({ id: boundary.itemId, type: 'userMessage', text: 'x'.repeat(16 * 1024 * 1024) }),
                segment.id, boundary.turnId, boundary.itemId);
        expect(source.database.query('SELECT COUNT(*) AS count FROM thread_items').get().count).toBe(100_000);
        const fields = source.database.query('PRAGMA table_info(thread_items)').all().map(row => row.name);
        expect(fields.indexOf('item_json')).toBeGreaterThan(fields.indexOf('rollout_ordinal'));
        expect(fields.indexOf('item_type')).toBeGreaterThan(fields.indexOf('item_json'));
        expect(resolveNativeForkBoundary(source.home, segment.thread, boundary)).toBe(boundary.turnId);
        requireIndexedPointReads(3);
        expect(audit.bytes).toBeLessThanOrEqual(4096);
    });

    it('does not scan unrelated directories after locating a nearby physical ancestor', () => {
        const source = fixture(); const parent = source.addSegment({ threadId: FORK_PARENT_ID });
        const boundary = source.addTurn(parent); const child = source.addSegment({ base: parent.position(10) });
        let index = 0; let closed = 0;
        audit.directory = () => ({
            readSync: () => { index++; return { name: index === 1 ? basename(parent.path) : `irrelevant-${index}`,
                isFile: () => true, isDirectory: () => false }; },
            closeSync: () => { closed++; },
        });
        expect(resolveNativeForkBoundary(source.home, child.thread, inherited(child, boundary))).toBe(boundary.turnId);
        expect(index).toBe(1); expect(closed).toBe(1);
    });

    it('measures cold cross-date ancestor lookup over 1,000 real unrelated session files', () => {
        const source = fixture(); const parent = source.addSegment({ threadId: FORK_PARENT_ID, archive: true });
        const boundary = source.addTurn(parent); const child = source.addSegment({ base: parent.position(10) });
        for (let day = 1; day <= 10; day++) {
            const directory = join(source.home, 'sessions', '2025', '12', day.toString().padStart(2, '0'));
            mkdirSync(directory, { recursive: true });
            for (let index = 0; index < 100; index++) {
                const id = uuid(1000 + day * 100 + index);
                writeFileSync(join(directory, `rollout-2025-12-${day.toString().padStart(2, '0')}T12-00-00-${id}.jsonl`),
                    JSON.stringify({ type: 'session_meta', ordinal: 0, payload: { id, history_mode: 'paginated' } }) + '\n');
            }
        }
        expect(resolveNativeForkBoundary(source.home, child.thread, inherited(child, boundary))).toBe(boundary.turnId);
        // This is deliberately not an O(1) claim: cold physical-ID discovery
        // visits unrelated entries until it reaches the archived ancestor.
        expect(audit.directoryReads).toBeGreaterThan(1000);
        expect(audit.directoryReads).toBeLessThan(1200);
        expect(audit.bytes).toBeLessThanOrEqual(8192);
        requireIndexedPointReads(3);
    });

    it('isolates positive physical-path cache entries by the bound native store', () => {
        for (const itemId of ['first-store-user', 'second-store-user']) {
            const source = fixture(); const parent = source.addSegment({ threadId: FORK_PARENT_ID });
            const boundary = source.addTurn(parent, { itemId }); const child = source.addSegment({ base: parent.position(10) });
            expect(resolveNativeForkBoundary(source.home, child.thread, inherited(child, boundary))).toBe(boundary.turnId);
        }
        expect(selectQueries().filter(query => /FROM thread_items/.test(query.sql)).map(query => query.params[2]))
            .toEqual(['first-store-user', 'second-store-user']);
    });

    it('rechecks cached ancestor headers and rediscovers a physical rollout after an archive move', () => {
        const source = fixture(); const parent = source.addSegment({ threadId: FORK_PARENT_ID });
        const boundary = source.addTurn(parent); const child = source.addSegment({ base: parent.position(10) });
        const resolve = () => resolveNativeForkBoundary(source.home, child.thread, inherited(child, boundary));
        expect(resolve()).toBe(boundary.turnId);
        audit.directoryReads = 0;
        expect(resolve()).toBe(boundary.turnId);
        expect(audit.directoryReads).toBe(0);
        const archive = join(source.home, 'archived_sessions', '2026', '10', '12');
        mkdirSync(archive, { recursive: true });
        const moved = join(archive, basename(parent.path)); renameSync(parent.path, moved);
        expect(resolve()).toBe(boundary.turnId);
        expect(audit.directoryReads).toBeGreaterThan(0);
        const lines = readFileSync(moved, 'utf8').split('\n'); const header = JSON.parse(lines[0]);
        header.payload.history_mode = 'legacy'; lines[0] = JSON.stringify(header); writeFileSync(moved, lines.join('\n'));
        audit.directoryReads = 0;
        expect(resolve).toThrow('unsupported session metadata');
        expect(audit.directoryReads).toBe(0);
    });

    it('aborts directory iteration at the budget rather than allocating an unbounded file list', () => {
        const source = fixture(); const missing = { thread_id: FORK_PARENT_ID, end_ordinal_exclusive: 10, end_byte_offset: 500 };
        const child = source.addSegment({ base: missing }); const boundary = source.addTurn(child);
        let closed = 0;
        audit.directory = () => ({ readSync: () => ({ name: 'irrelevant.jsonl', isFile: () => true, isDirectory: () => false }),
            closeSync: () => { closed++; } });
        expect(() => resolveNativeForkBoundary(source.home, child.thread, boundary)).toThrow('lineage directory budget exceeded');
        expect(audit.directoryReads).toBe(50_001); expect(closed).toBe(1); expect(audit.opened).toBe(0);
    });

    it('fails closed when the exact physical ancestor is absent, despite a matching public-thread file', () => {
        const source = fixture(); source.addSegment({ threadId: FORK_PARENT_ID });
        const child = source.addSegment({ base: { thread_id: FORK_EXECUTION_ID, end_ordinal_exclusive: 10, end_byte_offset: 500 } });
        const boundary = source.addTurn(child);
        expect(() => resolveNativeForkBoundary(source.home, child.thread, boundary)).toThrow('missing plain lineage rollout');
        expect(audit.opened).toBe(0);
    });

    it('bounds a single header and stops before opening native SQLite', () => {
        const source = fixture(); const segment = source.addSegment({ headerPadding: 256 * 1024 });
        const boundary = source.addTurn(segment);
        expect(() => resolveNativeForkBoundary(source.home, segment.thread, boundary)).toThrow('session header is incomplete or too large');
        expect(audit.bytes).toBeLessThanOrEqual(256 * 1024 + 1); expect(audit.opened).toBe(0);
    });

    it('bounds cumulative ancestor headers independently of the per-header limit', () => {
        const source = fixture(); let segment = source.addSegment({ threadId: uuid(20), records: 4, headerPadding: 250_000 });
        for (let index = 21; index <= 28; index++) {
            segment = source.addSegment({ threadId: uuid(index), base: segment.position(segment.nextOrdinal), records: 4, headerPadding: 250_000 });
        }
        const boundary = source.addTurn(segment);
        expect(() => resolveNativeForkBoundary(source.home, segment.thread, boundary)).toThrow('lineage header budget exceeded');
        expect(audit.bytes).toBeLessThanOrEqual(2 * 1024 * 1024 + 4096); expect(audit.opened).toBe(0);
    });

    it('bounds physical lineage depth and rejects cycles', () => {
        const source = fixture(); let segment = source.addSegment({ threadId: uuid(100), records: 4 });
        for (let index = 101; index <= 164; index++) segment = source.addSegment({ threadId: uuid(index), base: segment.position(segment.nextOrdinal), records: 4 });
        const boundary = source.addTurn(segment);
        expect(() => resolveNativeForkBoundary(source.home, segment.thread, boundary)).toThrow('lineage depth budget exceeded');
        const cyclic = source.addSegment({ threadId: uuid(200) });
        const cyclicBoundary = source.addTurn(cyclic);
        const lines = readFileSync(cyclic.path, 'utf8').split('\n'); const header = JSON.parse(lines[0]);
        header.ordinal = 10; header.payload.history_base = { thread_id: cyclic.id, end_ordinal_exclusive: 10, end_byte_offset: cyclic.size };
        lines[0] = JSON.stringify(header); writeFileSync(cyclic.path, lines.join('\n'));
        expect(() => resolveNativeForkBoundary(source.home, cyclic.thread, cyclicBoundary)).toThrow('invalid or cyclic rollout lineage');
        expect(audit.opened).toBe(0);
    });

    it.each(['wrong header ordinal', 'legacy sparse metadata', 'wrong session owner', 'invalid cutoff bytes'])('rejects %s before trusting metadata', problem => {
        const source = fixture(); const parent = source.addSegment({ threadId: FORK_PARENT_ID });
        const segment = source.addSegment({ base: parent.position(10) }); const boundary = source.addTurn(segment);
        const lines = readFileSync(segment.path, 'utf8').split('\n'); const header = JSON.parse(lines[0]);
        if (problem === 'wrong header ordinal') header.ordinal++;
        if (problem === 'legacy sparse metadata') { delete header.payload.history_base; header.ordinal = 0; header.payload.forked_from_ordinal_exclusive = 10; }
        if (problem === 'wrong session owner') header.payload.id = FORK_PARENT_ID;
        if (problem === 'invalid cutoff bytes') header.payload.history_base.end_byte_offset = parent.size + 1;
        lines[0] = JSON.stringify(header); writeFileSync(segment.path, lines.join('\n'));
        expect(() => resolveNativeForkBoundary(source.home, segment.thread, boundary)).toThrow('Native fork boundary unavailable:');
        expect(audit.opened).toBe(0);
    });
});
