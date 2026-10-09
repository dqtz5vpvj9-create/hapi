import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from './index'
import { encodeMessageContent } from './contentCodec'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('v26 history relationship index migration and persistent backfill', () => {
    it('creates only index schema at startup and resumes bounded backfill after reopening the database', () => {
        const dir = mkdtempSync(join('/mnt/cache/data-cache', 'hapi-index-migration-'))
        dirs.push(dir)
        const path = join(dir, 'hapi.db')
        let store = new Store(path)
        const session = store.sessions.getOrCreateSession('legacy-reader', null, null, 'reader')
        store.close()
        const legacy = new Database(path)
        legacy.exec(`DROP TRIGGER message_dependency_content_changed;
            DROP TRIGGER message_dependency_session_changed;
            DROP TABLE message_dependency_keys;
            DROP TABLE message_dependency_state;
            DROP TABLE message_dependency_scan;
            PRAGMA user_version=26;`)
        const insert = legacy.prepare('INSERT INTO messages(id,session_id,content,created_at,seq,invoked_at) VALUES (?,?,?,?,?,?)')
        legacy.transaction(() => {
            for (let i = 0; i < 513; i++) insert.run(`old-${i}`, session.id, encodeMessageContent({
                role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: `call-${i}`, name: 'Bash', input: { command: 'x'.repeat(300) } } }
            }), i + 1000, i + 1, i + 1000)
        })()
        legacy.close()
        store = new Store(path)
        try {
            let db = (store as unknown as { db: Database }).db
            expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(29)
            expect((db.prepare('SELECT COUNT(*) AS n FROM message_dependency_state').get() as { n: number }).n).toBe(0)
            const first = store.messages.backfillMessageDependencies(session.id)
            expect(first.complete).toBe(false)
            expect(first.lastSeq).toBeGreaterThan(0)
            store.close()
            store = new Store(path)
            db = (store as unknown as { db: Database }).db
            expect((db.prepare('SELECT last_seq FROM message_dependency_scan WHERE session_id=?').get(session.id) as { last_seq: number }).last_seq).toBe(first.lastSeq)
            let decoded = first.decodedRows
            let latest = first
            for (let batches = 0; !latest.complete && batches < 100; batches++) {
                latest = store.messages.backfillMessageDependencies(session.id)
                decoded += latest.decodedRows
            }
            expect(latest.complete).toBe(true)
            expect(decoded).toBe(513)
            expect(store.messages.findMessageDependencyCandidates(session.id, 'tool_call', 'call-512').map(row => row.id)).toEqual(['old-512'])
        } finally { store.close() }
    })
})
