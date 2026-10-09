import { Database } from 'bun:sqlite'
import { chmodSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** A SQLite snapshot includes committed WAL contents; copying the .db alone does not. */
export function verifySqliteBackup(path: string): { schemaVersion: number } {
    const db = new Database(path, { readonly: true })
    try {
        const result = db.query('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
        if (result.length !== 1 || result[0].integrity_check !== 'ok') throw new Error('SQLite integrity check failed')
        const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
        for (const required of ['sessions', 'messages', 'machines']) {
            if (!tables.some(table => table.name === required)) throw new Error(`Not a HAPI backup: missing ${required}`)
        }
        const row = db.query('PRAGMA user_version').get() as { user_version: number }
        return { schemaVersion: row.user_version }
    } finally { db.close() }
}

/** Always writes a new path. It never overwrites a running or existing database. */
export function createSqliteBackup(source: string, destination: string): { schemaVersion: number } {
    if (resolve(source) === resolve(destination) || existsSync(destination)) throw new Error('Destination must be a new file')
    verifySqliteBackup(source)
    const db = new Database(source, { readonly: true })
    try { db.query('VACUUM INTO ?').run(destination) }
    finally { db.close() }
    chmodSync(destination, 0o600)
    return verifySqliteBackup(destination)
}
