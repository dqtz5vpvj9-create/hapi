import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NativeForkBoundary } from '@hapi/protocol/apiTypes';
import { createStopDatabase, type FixtureDatabase } from './nativeStopFixture';

export const FORK_THREAD_ID = '0197ad6a-76ca-7000-8000-000000000001';
export const FORK_PARENT_ID = '0197ad6a-76ca-7000-8000-000000000002';
export const FORK_EXECUTION_ID = '0197ad6a-76ca-7000-8000-000000000003';

export type ForkPosition = { thread_id: string; end_ordinal_exclusive: number; end_byte_offset: number };
export type ForkSegment = {
    id: string;
    path: string;
    start: number;
    size: number;
    nextOrdinal: number;
    thread: { id: string; historyMode: 'paginated'; path: string };
    position(ordinal: number): ForkPosition;
};

/** Real SQLite, not an emulation of WHERE/ordering. These are the relevant
 * official rust-v0.162.0 migration tables, column order, and indexes. In
 * particular item_type MUST remain after item_json: reading that tail column
 * traverses large JSON overflow pages even when only one row is returned.
 * https://github.com/openai/codex/tree/rust-v0.162.0/codex-rs/state/thread_history_migrations
 * The unrelated realtime table and migration bookkeeping are omitted. */
export class NativeForkFixture {
    readonly database: FixtureDatabase;
    constructor(readonly home: string) {
        this.database = createStopDatabase(home);
        this.database.exec(`
            CREATE TABLE thread_turns (
                thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL,
                status TEXT NOT NULL, error_json TEXT, started_at INTEGER, completed_at INTEGER,
                duration_ms INTEGER, first_user_item_id TEXT, final_agent_item_id TEXT,
                PRIMARY KEY (thread_id, turn_id));
            CREATE UNIQUE INDEX idx_thread_turns_page ON thread_turns(thread_id, rollout_ordinal);
            CREATE TABLE thread_items (
                thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
                rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL,
                PRIMARY KEY (thread_id, turn_id, item_id));
            CREATE UNIQUE INDEX idx_thread_items_page ON thread_items(thread_id, rollout_ordinal);
            CREATE INDEX idx_thread_items_by_turn_page ON thread_items(thread_id, turn_id, rollout_ordinal);
            CREATE TABLE thread_history_projection_state (
                thread_id TEXT PRIMARY KEY, next_rollout_byte_offset INTEGER NOT NULL, next_rollout_ordinal INTEGER NOT NULL);
            ALTER TABLE thread_items ADD COLUMN item_type TEXT NOT NULL DEFAULT '';
            CREATE INDEX idx_thread_items_user_messages ON thread_items(thread_id, rollout_ordinal) WHERE item_type = 'userMessage';
            ALTER TABLE thread_turns ADD COLUMN rollout_byte_offset INTEGER;
            ALTER TABLE thread_turns ADD COLUMN rollout_end_ordinal INTEGER;
            ALTER TABLE thread_turns ADD COLUMN rollout_end_byte_offset INTEGER;
            ALTER TABLE thread_turns ADD COLUMN root_turn_id TEXT;
            ALTER TABLE thread_items ADD COLUMN updated_at_ordinal INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE thread_items ADD COLUMN started_at_ms INTEGER;
            ALTER TABLE thread_items ADD COLUMN completed_at_ms INTEGER;
            CREATE INDEX idx_thread_items_updated_page ON thread_items(thread_id, updated_at_ordinal);
            CREATE INDEX idx_thread_items_by_turn_updated_page ON thread_items(thread_id, turn_id, updated_at_ordinal);
            CREATE INDEX idx_thread_turns_end_page ON thread_turns(thread_id, rollout_end_ordinal, turn_id)
                WHERE rollout_end_ordinal IS NOT NULL;
        `);
    }
    addSegment(options: {
        threadId?: string; physicalId?: string; base?: ForkPosition; records?: number;
        archive?: boolean; headerPadding?: number;
    } = {}): ForkSegment {
        const threadId = options.threadId ?? FORK_THREAD_ID;
        const id = options.physicalId ?? threadId;
        const path = join(this.home, options.archive ? 'archived_sessions' : 'sessions', '2026', '10', '11',
            `rollout-2026-10-11T14-00-00-${threadId}${id === threadId ? '' : `_${id}`}.jsonl`);
        mkdirSync(dirname(path), { recursive: true });
        const header = JSON.stringify({ type: 'session_meta', ordinal: options.base?.end_ordinal_exclusive ?? 0,
            payload: { id: threadId, history_mode: 'paginated', ...(options.base ? { history_base: options.base } : {}),
                ...(options.headerPadding ? { fixture_padding: 'x'.repeat(options.headerPadding) } : {}) } }) + '\n';
        writeFileSync(path, header);
        const start = (options.base?.end_ordinal_exclusive ?? 0) + 1;
        const offsets = new Map<number, number>();
        let size = Buffer.byteLength(header);
        const records = options.records ?? 32;
        let chunk = '';
        for (let ordinal = start; ordinal < start + records; ordinal++) {
            offsets.set(ordinal, size);
            // Opaque valid records make the byte positions real. The resolver
            // must never replay these to construct a history projection.
            const line = JSON.stringify({ ordinal, type: 'event_msg', payload: { type: 'fixture_event' } }) + '\n';
            chunk += line;
            size += Buffer.byteLength(line);
            if ((ordinal - start + 1) % 4096 === 0) { appendFileSync(path, chunk); chunk = ''; }
        }
        if (chunk) appendFileSync(path, chunk);
        const nextOrdinal = start + records;
        offsets.set(nextOrdinal, size);
        const segment: ForkSegment = { id, path, start, size, nextOrdinal,
            thread: { id: threadId, historyMode: 'paginated', path },
            position: ordinal => {
                const offset = offsets.get(ordinal);
                if (offset === undefined) throw new Error(`Fixture ordinal ${ordinal} is outside the physical segment`);
                return { thread_id: id, end_ordinal_exclusive: ordinal, end_byte_offset: offset };
            } };
        this.checkpoint(segment);
        return segment;
    }
    checkpoint(segment: ForkSegment, options: { ordinal?: number; byteOffset?: number } = {}): void {
        this.database.query(`INSERT OR REPLACE INTO thread_history_projection_state
            (thread_id, next_rollout_byte_offset, next_rollout_ordinal) VALUES (?, ?, ?)`)
            .run(segment.id, options.byteOffset ?? segment.size, options.ordinal ?? segment.nextOrdinal);
    }
    addTurn(segment: ForkSegment, options: {
        id?: string; ordinal?: number; itemId?: string; endOrdinal?: number | null;
        firstUserItemId?: string | null; byteOffset?: number | null;
    } = {}): NativeForkBoundary {
        const turnId = options.id ?? 'turn-first';
        const itemId = options.itemId ?? `${turnId}-user`;
        const ordinal = options.ordinal ?? segment.start;
        const end = options.endOrdinal === undefined ? ordinal + 2 : options.endOrdinal;
        this.database.query(`INSERT INTO thread_turns
            (thread_id, turn_id, rollout_ordinal, status, started_at, completed_at, first_user_item_id,
                rollout_byte_offset, rollout_end_ordinal, rollout_end_byte_offset)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(segment.id, turnId, ordinal, end === null ? 'inProgress' : 'completed', 1700000000,
                end === null ? null : 1700000001,
                options.firstUserItemId === undefined ? itemId : options.firstUserItemId,
                options.byteOffset === undefined ? segment.position(ordinal).end_byte_offset : options.byteOffset,
                end, end === null ? null : segment.position(end + 1).end_byte_offset);
        this.addItem(segment, turnId, itemId, ordinal + 1);
        return { threadId: segment.thread.id, turnId, itemId };
    }
    addItem(segment: ForkSegment, turnId: string, itemId: string, ordinal: number, type = 'userMessage', body?: string): void {
        this.database.query(`INSERT INTO thread_items
            (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(segment.id, turnId, itemId, ordinal, 1700000000000,
                body ?? JSON.stringify({ id: itemId, type, content: [{ type: 'text', text: 'not for the boundary reader' }] }), type);
    }
    close(): void { this.database.close(); }
}
