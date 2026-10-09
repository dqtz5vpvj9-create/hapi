import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteBackup, verifySqliteBackup } from './sqliteBackup'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'hapi-backup-test-')); roots.push(root)
    const source = join(root, 'source.db')
    const db = new Database(source)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=29; CREATE TABLE sessions(id TEXT); CREATE TABLE machines(id TEXT); CREATE TABLE messages(body TEXT);')
    db.query('INSERT INTO messages VALUES (?)').run('committed WAL message')
    return { root, source, db }
}
describe('SQLite backup and restore-copy', () => {
    it('captures committed WAL data and creates a verified independent restore copy', () => {
        const { root, source, db } = fixture()
        try {
            const snapshot = join(root, 'backup.db')
            expect(createSqliteBackup(source, snapshot)).toEqual({ schemaVersion: 29 })
            db.query('INSERT INTO messages VALUES (?)').run('later message')
            const restored = join(root, 'restore.db')
            createSqliteBackup(snapshot, restored)
            const check = new Database(restored, { readonly: true })
            expect(check.query('SELECT body FROM messages').all()).toEqual([{ body: 'committed WAL message' }])
            check.close()
        } finally { db.close() }
    })
    it('never overwrites an existing destination or the source', () => {
        const { root, source, db } = fixture()
        try {
            const destination = join(root, 'existing.db'); writeFileSync(destination, 'keep me')
            expect(() => createSqliteBackup(source, destination)).toThrow('new file')
            expect(readFileSync(destination, 'utf8')).toBe('keep me')
            expect(() => createSqliteBackup(source, source)).toThrow('new file')
        } finally { db.close() }
    })
    it('rejects unrelated SQLite files', () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-backup-test-')); roots.push(root)
        const path = join(root, 'unrelated.db'); const db = new Database(path); db.exec('CREATE TABLE unrelated(x)'); db.close()
        expect(() => verifySqliteBackup(path)).toThrow('Not a HAPI backup')
    })
})
