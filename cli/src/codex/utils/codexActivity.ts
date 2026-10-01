import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Read activity only for the native thread already bound to this session. */
export function readCodexActivity(threadId: string, home: string): number | undefined {
    if (!existsSync(home)) return undefined;
    const file = readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name))
        .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))[0];
    if (!file) return undefined;
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const db = new Database(join(home, file), { readonly: true });
    try {
        const columns = new Set((db.query('PRAGMA table_info(threads)').all() as { name: string }[]).map(column => column.name));
        const row = db.query(`SELECT ${columns.has('updated_at_ms') ? 'COALESCE(updated_at_ms, updated_at * 1000)' : 'updated_at * 1000'} AS at FROM threads WHERE id = ?`)
            .get(threadId) as { at: number } | null;
        return row?.at;
    } finally { db.close(); }
}
