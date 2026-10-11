import type { Database } from 'bun:sqlite'
import type { SessionReadState } from '@hapi/protocol/schemas'

export function createSessionPresenceSchema(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS session_execution_versions (
            session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
            version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_read_states (
            namespace TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            seen_at REAL NOT NULL,
            manual_unread_at REAL,
            PRIMARY KEY(namespace, user_id, session_id)
        );
    `)
}

export class SessionPresenceStore {
    constructor(private readonly db: Database) {}
    executionVersion(sessionId: string): number {
        return (this.db.prepare('SELECT version FROM session_execution_versions WHERE session_id=?')
            .get(sessionId) as { version: number } | null)?.version ?? 0
    }
    nextExecutionVersion(sessionId: string): number {
        return (this.db.prepare(`INSERT INTO session_execution_versions(session_id,version) VALUES (?,1)
            ON CONFLICT(session_id) DO UPDATE SET version=version+1 RETURNING version`)
            .get(sessionId) as { version: number }).version
    }
    readStates(namespace: string, userId: number): Record<string, SessionReadState> {
        const rows = this.db.prepare(`SELECT session_id,version,seen_at,manual_unread_at FROM session_read_states
            WHERE namespace=? AND user_id=?`).all(namespace, userId) as Array<{
                session_id: string; version: number; seen_at: number; manual_unread_at: number | null
            }>
        return Object.fromEntries(rows.map(row => [row.session_id, {
            version: row.version, seenAt: row.seen_at, manualUnreadAt: row.manual_unread_at
        }]))
    }
    updateReadState(namespace: string, userId: number, sessionId: string,
        input: { expectedVersion: number; seenAt: number; manualUnreadAt: number | null }
    ): { applied: boolean; state: SessionReadState } {
        return this.db.transaction(() => {
            const row = this.db.prepare(`SELECT version,seen_at,manual_unread_at FROM session_read_states
                WHERE namespace=? AND user_id=? AND session_id=?`).get(namespace, userId, sessionId) as {
                    version: number; seen_at: number; manual_unread_at: number | null
                } | null
            const current = { version: row?.version ?? 0, seenAt: row?.seen_at ?? 0, manualUnreadAt: row?.manual_unread_at ?? null }
            if (current.version !== input.expectedVersion) return { applied: false, state: current }
            const state = { version: current.version + 1,
                seenAt: Math.max(current.seenAt, input.seenAt), manualUnreadAt: input.manualUnreadAt }
            this.db.prepare(`INSERT INTO session_read_states(namespace,user_id,session_id,version,seen_at,manual_unread_at)
                VALUES (?,?,?,?,?,?) ON CONFLICT(namespace,user_id,session_id) DO UPDATE SET
                version=excluded.version,seen_at=excluded.seen_at,manual_unread_at=excluded.manual_unread_at`)
                .run(namespace, userId, sessionId, state.version, state.seenAt, state.manualUnreadAt)
            return { applied: true, state }
        }).immediate()
    }
}
