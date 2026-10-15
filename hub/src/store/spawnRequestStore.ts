import type { Database } from 'bun:sqlite'
import type { SpawnResponse } from '@hapi/protocol/apiTypes'

type SpawnRequest = { fingerprint: string; sessionId: string; response: SpawnResponse | null }
type Row = { fingerprint: string; session_id: string; response_json: string | null }

export function createSpawnRequestSchema(db: Database): void {
    // Receipts deliberately outlive sessions: deleting a session must never turn
    // a delayed HTTP retry into a new process. Store hashes, not prompt/config data.
    db.exec(`CREATE TABLE IF NOT EXISTS spawn_requests (
        namespace TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        session_id TEXT NOT NULL, response_json TEXT,
        PRIMARY KEY(namespace, request_id)
    )`)
}

export class SpawnRequestStore {
    constructor(private readonly db: Database) {}

    private durable<T>(write: () => T): T {
        if (this.db.inTransaction) throw new Error('Spawn admission requires its own durable transaction')
        const prior = (this.db.prepare('PRAGMA synchronous').get() as { synchronous: number }).synchronous
        try {
            this.db.exec('PRAGMA synchronous = FULL')
            return this.db.transaction(write).immediate()
        } finally {
            this.db.exec(`PRAGMA synchronous = ${prior}`)
        }
    }

    get(namespace: string, requestId: string): SpawnRequest | undefined {
        const row = this.db.prepare('SELECT * FROM spawn_requests WHERE namespace = ? AND request_id = ?')
            .get(namespace, requestId) as Row | undefined
        return row ? { fingerprint: row.fingerprint, sessionId: row.session_id,
            response: row.response_json ? JSON.parse(row.response_json) as SpawnResponse : null } : undefined
    }

    claim(namespace: string, requestId: string, fingerprint: string, sessionId: string): boolean {
        return this.durable(() => this.db.prepare(`INSERT OR IGNORE INTO spawn_requests
            (namespace, request_id, fingerprint, session_id) VALUES (?, ?, ?, ?)`)
            .run(namespace, requestId, fingerprint, sessionId).changes === 1)
    }

    complete(namespace: string, requestId: string, response: SpawnResponse): void {
        this.durable(() => this.db.prepare('UPDATE spawn_requests SET response_json = ? WHERE namespace = ? AND request_id = ?')
            .run(JSON.stringify(response), namespace, requestId))
    }
}
