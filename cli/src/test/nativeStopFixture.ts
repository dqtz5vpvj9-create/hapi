import { createRequire } from 'node:module';
import { join } from 'node:path';

type Statement = { run(...values: unknown[]): unknown; all(...values: unknown[]): any[]; get(...values: unknown[]): any };
export type FixtureDatabase = { exec(sql: string): unknown; query(sql: string): Statement; close(): void };
export function createStopDatabase(home: string): FixtureDatabase {
    const require = createRequire(import.meta.url);
    const path = join(home, 'thread_history_1.sqlite');
    if (typeof Bun !== 'undefined') {
        const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
        return new Database(path) as unknown as FixtureDatabase;
    }
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(path);
    return { exec: sql => db.exec(sql), query: sql => db.prepare(sql) as unknown as Statement, close: () => db.close() };
}
export class NativeStopFixture {
    readonly database: FixtureDatabase;
    readonly calls: Array<{ method: string; params: Record<string, unknown>; count: number; bytes: number }> = [];
    readonly turns: any[] = [];
    readonly items: any[] = [];
    private readonly cursors = new Map<string, { scope: 'items' | 'turns'; ordinal: number; inclusive: boolean }>();
    constructor(readonly home: string, readonly threadId = 'thread') {
        this.database = createStopDatabase(home);
        this.database.exec(`
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT,
                started_at INTEGER, completed_at INTEGER, rollout_end_ordinal INTEGER, PRIMARY KEY(thread_id,turn_id));
            CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_turns_page ON thread_turns(thread_id,rollout_ordinal);
            CREATE INDEX IF NOT EXISTS idx_thread_turns_end_page ON thread_turns(thread_id,rollout_end_ordinal,turn_id);
            CREATE TABLE IF NOT EXISTS thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER,
                created_at_ms INTEGER, started_at_ms INTEGER, completed_at_ms INTEGER, item_type TEXT,
                item_json TEXT, PRIMARY KEY(thread_id,turn_id,item_id));
            CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_items_page ON thread_items(thread_id,rollout_ordinal);
            CREATE INDEX IF NOT EXISTS idx_thread_items_by_turn_page ON thread_items(thread_id,turn_id,rollout_ordinal);
            CREATE INDEX IF NOT EXISTS idx_thread_items_user_messages ON thread_items(thread_id,rollout_ordinal) WHERE item_type='userMessage';
        `);
    }
    addTurn(id: string, status: string, itemless = false, assistant = false) {
        const i = this.turns.length; const start = 1700000000 + i * 2; const ordinal = i * 4 + 1;
        const turn = { id, status, startedAt: start as number | null, completedAt: status === 'inProgress' ? null : start + 1,
            items: [], ordinal, endOrdinal: status === 'inProgress' ? null : ordinal + 3 };
        this.turns.push(turn); this.persist(turn);
        if (!itemless) this.addItem(turn, `${id}-question`, ordinal + 1,
            { id: `${id}-question`, type: 'userMessage', content: [{ type: 'text', text: `QUESTION ${id}` }] });
        if (assistant) this.addItem(turn, `${id}-answer`, ordinal + 2, { id: `${id}-answer`, type: 'agentMessage', text: `ANSWER ${id}` });
        return turn;
    }
    addItem(turn: any, id: string, ordinal: number, item: any) {
        const at = turn.startedAt * 1000 + (item.type === 'agentMessage' ? 1500 : 500);
        this.items.push({ turnId: turn.id, ordinal, startedAtMs: at, completedAtMs: at, item });
        this.database.query('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?)').run(this.threadId, turn.id, id, ordinal, at, at, at, item.type,
            'DO NOT READ: SQLITE BODY IS NOT THE RPC BODY');
    }
    persist(turn: any) {
        this.database.query('INSERT OR REPLACE INTO thread_turns VALUES(?,?,?,?,?,?,?)').run(this.threadId,
            turn.id, turn.ordinal, turn.status, turn.startedAt, turn.completedAt, turn.endOrdinal);
    }
    complete(turn: any, status: string, persist = true) {
        turn.status = status; turn.completedAt = turn.startedAt + 1; turn.endOrdinal = turn.ordinal + 3;
        if (persist) this.persist(turn);
    }
    private cursor(scope: 'items' | 'turns', ordinal: number, inclusive: boolean) {
        const value = `issued-${this.cursors.size}`; this.cursors.set(value, { scope, ordinal, inclusive }); return value;
    }
    async request(method: string, params: Record<string, unknown>): Promise<any> {
        if (params.threadId !== this.threadId) throw new Error('Wrong fixture thread');
        const scope = method === 'thread/items/list' ? 'items' : method === 'thread/turns/list' ? 'turns' : undefined;
        if (!scope) throw new Error('Forbidden fixture native RPC: ' + method);
        if (scope === 'turns' && params.itemsView !== 'notLoaded') throw new Error('Fixture requires metadata-only view');
        const asc = params.sortDirection === 'asc';
        let rows = scope === 'items' ? [...this.items] : this.turns.map(turn => ({ ...turn, items: [], itemsView: 'notLoaded' }));
        if (params.turnId) rows = rows.filter(row => row.turnId === params.turnId);
        let anchor: { ordinal: number; inclusive: boolean } | undefined;
        if (typeof params.cursor === 'string') {
            const issued = this.cursors.get(params.cursor);
            if (!issued || issued.scope !== scope) throw new Error('Invalid cursor scope');
            anchor = issued;
        } else if (params.cursor) {
            const value = params.cursor as { type: string; itemId: string };
            if (scope !== 'items' || value.type !== 'item' || !params.turnId) throw new Error('Unsupported anchor');
            const item = rows.find(row => row.item?.id === value.itemId);
            if (!item) throw new Error('No real item anchor');
            anchor = { ordinal: item.ordinal, inclusive: false };
        }
        if (anchor) rows = rows.filter(row => asc ? row.ordinal > anchor!.ordinal || anchor!.inclusive && row.ordinal === anchor!.ordinal
            : row.ordinal < anchor!.ordinal || anchor!.inclusive && row.ordinal === anchor!.ordinal);
        rows.sort((a, b) => (a.ordinal - b.ordinal) * (asc ? 1 : -1));
        const data = rows.slice(0, Number(params.limit));
        const wire = data.map(row => {
            const { ordinal, endOrdinal, ...entry } = row;
            return scope === 'turns' ? { ...entry, error: null, durationMs: row.completedAt == null ? null : 1000 } : entry;
        });
        const result = { data: wire, nextCursor: rows.length > data.length ? this.cursor(scope, data.at(-1).ordinal, false) : null,
            backwardsCursor: data.length ? this.cursor(scope, data[0].ordinal, true) : null };
        this.calls.push({ method, params, count: data.length, bytes: Buffer.byteLength(JSON.stringify(result)) });
        return result;
    }
    close() { this.database.close(); }
}
