import { stat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteBackup } from '../../storage/sqliteBackup'
import type { SqliteStorageUsageResponse } from '@hapi/protocol/apiTypes'
import { Hono } from 'hono'
import type { WebAppEnv } from '../middleware/auth'

async function fileSize(path: string, required = false): Promise<number> {
    try {
        return (await stat(path)).size
    } catch (error) {
        if (!required && error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0
        throw error
    }
}

export function createStorageRoutes(dbPath: string): Hono<WebAppEnv> {
    const app = new Hono<WebAppEnv>()

    app.get('/storage/sqlite', async (c) => {
        if (c.get('namespace') !== 'default') {
            return c.json({ error: 'Storage usage is only available to the hub owner' }, 403)
        }
        c.header('Cache-Control', 'no-store')
        try {
            const [databaseBytes, walBytes, shmBytes] = await Promise.all([
                fileSize(dbPath, true),
                fileSize(`${dbPath}-wal`),
                fileSize(`${dbPath}-shm`),
            ])
            const response: SqliteStorageUsageResponse = {
                path: dbPath,
                databaseBytes,
                walBytes,
                shmBytes,
                totalBytes: databaseBytes + walBytes + shmBytes,
            }
            return c.json(response)
        } catch (error) {
            return c.json({
                error: error instanceof Error ? error.message : 'Failed to read SQLite storage usage'
            }, 500)
        }
    })

    let backupInProgress = false
    app.post('/storage/sqlite/backup', async (c) => {
        if (c.get('namespace') !== 'default') return c.json({ error: 'Backup is only available to the hub owner' }, 403)
        if (backupInProgress) return c.json({ error: 'A backup is already in progress' }, 409)
        backupInProgress = true
        let directory: string | undefined
        try {
            directory = await mkdtemp(join(tmpdir(), 'hapi-backup-'))
            const path = join(directory, 'hapi.db')
            createSqliteBackup(dbPath, path)
            const reader = Bun.file(path).stream().getReader()
            const cleanup = async () => {
                try { if (directory) await rm(directory, { recursive: true, force: true }) }
                finally { backupInProgress = false }
            }
            const body = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    try {
                        const next = await reader.read()
                        if (next.done) { await cleanup(); controller.close() }
                        else controller.enqueue(next.value)
                    } catch (error) { controller.error(error); await cleanup() }
                },
                async cancel() { try { await reader.cancel() } finally { await cleanup() } },
            })
            return new Response(body, { headers: {
                'Content-Type': 'application/vnd.sqlite3',
                'Content-Disposition': `attachment; filename="hapi-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db"`,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            } })
        } catch {
            try { if (directory) await rm(directory, { recursive: true, force: true }) }
            finally { backupInProgress = false }
            return c.json({ error: 'Backup failed. Check database health and available disk space.' }, 500)
        }
    })

    return app
}
