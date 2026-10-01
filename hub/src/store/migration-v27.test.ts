import { afterEach, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from './index'
import { encodeMessageContent } from './contentCodec'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('upgrades v27 without decoding history at startup and resumes bounded outline backfill after restart', () => {
    const dir = mkdtempSync(join('/mnt/cache/data-cache', 'hapi-outline-migration-'))
    dirs.push(dir)
    const path = join(dir, 'hapi.db')
    let store = new Store(path)
    const session = store.sessions.getOrCreateSession('outline-legacy', null, null, 'reader')
    store.close()
    const legacy = new Database(path)
    legacy.exec(`DROP TRIGGER message_outline_content_changed;
        DROP TRIGGER message_outline_position_changed;
        DROP TABLE message_outline;
        DROP TABLE message_outline_scan;
        DROP TABLE message_outline_unreadable;
        PRAGMA user_version=27;`)
    const insert = legacy.prepare('INSERT INTO messages(id,session_id,content,created_at,seq,invoked_at) VALUES (?,?,?,?,?,?)')
    legacy.transaction(() => {
        for (let seq = 1; seq <= 513; seq++) insert.run(`old-${seq}`, session.id, encodeMessageContent(seq === 1
            ? { role: 'user', content: { type: 'text', text: 'Original question' } }
            : { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'answer' } } }), seq, seq, seq)
    })()
    legacy.close()
    store = new Store(path)
    try {
        const db = (store as unknown as { db: Database }).db
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 28 })
        expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 513 })
        expect(store.messages.getOutline(session.id).entries).toEqual([])
        const first = store.messages.backfillOutline(session.id)
        expect(first.complete).toBe(false)
        expect(first.enumerated).toBeLessThanOrEqual(128)
        store.close()
        store = new Store(path)
        expect(store.messages.getOutline(session.id).coverage.scannedThrough).toBe(first.scannedThrough)
        for (let batch = 0; batch < 100 && !store.messages.getOutline(session.id).coverage.complete; batch++) store.messages.backfillOutline(session.id)
        expect(store.messages.getOutline(session.id)).toMatchObject({ entries: [{ messageId: 'old-1', label: 'Original question' }], coverage: { complete: true } })
    } finally { store.close() }
})

it('indexes imported and copied questions through the actual message-write transactions', () => {
    const store = new Store(':memory:')
    try {
        const source = store.sessions.getOrCreateSession('source', null, null, 'reader')
        const target = store.sessions.getOrCreateSession('target', null, null, 'reader')
        const input = { role: 'user', content: { type: 'text', text: 'Copied question' } }
        const added = store.messages.addImportedMessage(source.id, input, 'original', 1000)
        const copied = store.messages.copyMessageToSession(target.id, added.message)
        expect(store.messages.getOutline(source.id).entries.map(entry => entry.messageId)).toEqual([added.message.id])
        expect(store.messages.getOutline(target.id).entries).toMatchObject([{ messageId: copied.id, label: 'Copied question' }])
        expect(store.messages.addImportedMessage(source.id, input, 'original', 1000).inserted).toBe(false)
        expect(store.messages.getOutline(source.id).entries).toHaveLength(1)
    } finally { store.close() }
})
