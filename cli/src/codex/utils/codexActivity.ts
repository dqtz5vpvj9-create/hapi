import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readCodexRolloutActivity } from './codexRolloutActivity';

/** Read activity only for the native thread already bound to this session. */
export function readCodexActivity(threadId: string, home: string): number | undefined {
    if (!existsSync(home)) return undefined;
    const file = readdirSync(home).filter(name => /^state_\d+\.sqlite$/.test(name))
        .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))[0];
    if (!file) return undefined;
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const db = new Database(join(home, file), { readonly: true });
    try {
        const row = db.query('SELECT rollout_path, created_at FROM threads WHERE id = ?')
            .get(threadId) as { rollout_path: string; created_at: number } | null;
        return row ? readCodexRolloutActivity(row.rollout_path) ?? row.created_at * 1000 : undefined;
    } finally { db.close(); }
}
