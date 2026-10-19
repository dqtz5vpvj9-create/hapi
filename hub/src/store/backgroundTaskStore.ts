import type { Database } from 'bun:sqlite'
import { extractBackgroundTaskEvents, type BackgroundTaskEvent } from '../sync/backgroundTasks'
import type { StoredMessage } from './types'
import { prepareCached } from './statementCache'

export type BackgroundTaskState = BackgroundTaskEvent['state'] | 'detached'
export type StoredBackgroundTask = { taskId: string; state: BackgroundTaskState; firstSeenAt: number; updatedAt: number }

export function createBackgroundTaskSchema(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS session_background_tasks (
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            task_id TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('running','completed','failed','cancelled','detached')),
            first_seen_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(session_id, task_id)
        );
        CREATE INDEX IF NOT EXISTS idx_background_tasks_state ON session_background_tasks(session_id,state);
        CREATE TABLE IF NOT EXISTS session_background_task_fences (
            session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
            ended_at INTEGER NOT NULL
        );
    `)
}

/** Called inside the agent-message transaction, using the stored canonical body.
 * Transcript import/copy is deliberately excluded: copied history does not
 * transfer ownership of its old background processes to a fork.
 */
export function recordBackgroundTasks(db: Database, message: StoredMessage): boolean {
    const events = extractBackgroundTaskEvents(message.content)
    if (events.length === 0) return false
    const fence = prepareCached(db, 'SELECT ended_at FROM session_background_task_fences WHERE session_id=?')
        .get(message.sessionId) as { ended_at: number } | null
    let changed = false
    for (const event of events) {
        const state = event.state === 'running' && fence && message.createdAt <= fence.ended_at ? 'detached' : event.state
        const result = prepareCached(db, `INSERT INTO session_background_tasks(session_id,task_id,state,first_seen_at,updated_at)
            VALUES (?,?,?,?,?) ON CONFLICT(session_id,task_id) DO UPDATE SET
            state=excluded.state, updated_at=MAX(session_background_tasks.updated_at,excluded.updated_at)
            WHERE session_background_tasks.state <> excluded.state
                AND (session_background_tasks.state='running'
                    OR (session_background_tasks.state='detached' AND excluded.state IN ('completed','failed','cancelled')))`)
            .run(message.sessionId, event.taskId, state, message.createdAt, message.createdAt)
        changed ||= result.changes > 0
    }
    return changed
}

export class BackgroundTaskStore {
    constructor(private readonly db: Database) {}

    runningCount(sessionId: string): number {
        return (prepareCached(this.db, "SELECT COUNT(*) AS count FROM session_background_tasks WHERE session_id=? AND state='running'")
            .get(sessionId) as { count: number }).count
    }

    list(sessionId: string): StoredBackgroundTask[] {
        const rows = prepareCached(this.db, 'SELECT task_id,state,first_seen_at,updated_at FROM session_background_tasks WHERE session_id=? ORDER BY task_id')
            .all(sessionId) as Array<{ task_id: string; state: BackgroundTaskState; first_seen_at: number; updated_at: number }>
        return rows.map(row => ({ taskId: row.task_id, state: row.state, firstSeenAt: row.first_seen_at, updatedAt: row.updated_at }))
    }

    /** Explicit wrapper exit ends its ownership; a network timeout does not.
     * Detached is an observation gap, not a claim that the process succeeded.
     */
    detach(sessionId: string, at: number): void {
        this.db.transaction(() => {
            prepareCached(this.db, `INSERT INTO session_background_task_fences(session_id,ended_at) VALUES (?,?)
                ON CONFLICT(session_id) DO UPDATE SET ended_at=MAX(ended_at,excluded.ended_at)`).run(sessionId, at)
            prepareCached(this.db, "UPDATE session_background_tasks SET state='detached',updated_at=MAX(updated_at,?) WHERE session_id=? AND state='running'")
                .run(at, sessionId)
        })()
    }

    /** Consolidation is the same logical session; preserve terminal tombstones. */
    merge(sourceId: string, targetId: string): void {
        this.db.transaction(() => {
            const scopes = prepareCached(this.db, 'SELECT source.namespace AS source_namespace,target.namespace AS target_namespace FROM sessions source JOIN sessions target ON target.id=? WHERE source.id=?')
                .get(targetId, sourceId) as { source_namespace: string; target_namespace: string } | null
            if (!scopes || scopes.source_namespace !== scopes.target_namespace) throw new Error('Background task session merge scope mismatch')
            const rows = this.list(sourceId)
            for (const row of rows) {
                prepareCached(this.db, `INSERT INTO session_background_tasks(session_id,task_id,state,first_seen_at,updated_at)
                    VALUES (?,?,?,?,?) ON CONFLICT(session_id,task_id) DO UPDATE SET
                    state=excluded.state,updated_at=MAX(session_background_tasks.updated_at,excluded.updated_at)
                    WHERE session_background_tasks.state='running' AND excluded.state<>'running'`)
                    .run(targetId, row.taskId, row.state, row.firstSeenAt, row.updatedAt)
            }
            prepareCached(this.db, `INSERT INTO session_background_task_fences(session_id,ended_at)
                SELECT ?,ended_at FROM session_background_task_fences WHERE session_id=?
                ON CONFLICT(session_id) DO UPDATE SET ended_at=MAX(ended_at,excluded.ended_at)`).run(targetId, sourceId)
        })()
    }
}
