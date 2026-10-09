import type { Database } from 'bun:sqlite'
import { applyWorkspaceCommand, WorkspaceSnapshotSchema, type WorkspaceSnapshot, type WorkspaceUpdateRequest, type WorkspaceUpdateResult } from '@hapi/protocol/workspaces'

export function createWorkspaceSchema(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS workspace_collections (
            namespace TEXT PRIMARY KEY,
            revision INTEGER NOT NULL,
            document TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_operations (
            namespace TEXT NOT NULL,
            operation_id TEXT NOT NULL,
            PRIMARY KEY(namespace, operation_id)
        );
    `)
}

/** One collection revision makes a move between workspaces a single CAS transaction. */
export class WorkspaceStore {
    constructor(private db: Database) {}

    hasOperation(namespace: string, operationId: string): boolean {
        return Boolean(this.db.prepare('SELECT 1 FROM workspace_operations WHERE namespace=? AND operation_id=?').get(namespace, operationId))
    }

    get(namespace: string): WorkspaceSnapshot {
        const row = this.db.prepare('SELECT revision, document FROM workspace_collections WHERE namespace=?')
            .get(namespace) as { revision: number; document: string } | null
        return { schemaVersion: 2, revision: row?.revision ?? 0, workspaces: row ? JSON.parse(row.document) : [] }
    }

    update(namespace: string, request: WorkspaceUpdateRequest): WorkspaceUpdateResult {
        return this.db.transaction((): WorkspaceUpdateResult => {
            const current = this.get(namespace)
            // A response may be lost after commit. Retrying the same operation must not
            // move a pane again or resurrect a workspace that another device then closed.
            if (this.hasOperation(namespace, request.operation.id)) return { status: 'duplicate', snapshot: current }
            if (request.expectedRevision !== current.revision) return { status: 'conflict', snapshot: current }
            const result = request.operation.command.type === 'import' && current.revision !== 0
                ? { workspaces: current.workspaces, skipped: 'already-initialized' }
                : applyWorkspaceCommand(current.workspaces, request.operation.command)
            const snapshot = WorkspaceSnapshotSchema.parse({ schemaVersion: 2, revision: current.revision + 1, workspaces: result.workspaces })
            this.db.prepare(`INSERT INTO workspace_collections(namespace, revision, document) VALUES (?, ?, ?)
                ON CONFLICT(namespace) DO UPDATE SET revision=excluded.revision, document=excluded.document`)
                .run(namespace, snapshot.revision, JSON.stringify(snapshot.workspaces))
            this.db.prepare('INSERT INTO workspace_operations(namespace, operation_id) VALUES (?, ?)').run(namespace, request.operation.id)
            return { status: 'applied', snapshot, ...(result.skipped ? { skipped: result.skipped } : {}) }
        }).immediate()
    }
}
