import { afterEach, describe, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { Store } from './index'
import { encodeMessageContent } from './contentCodec'
import { backfillMessageOutline, createMessageOutlineSchema, getMessageOutlineCoverage, indexMessageOutline, readMessageOutline } from './messageOutline'

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
function setup() {
    const store = new Store(':memory:')
    stores.push(store)
    const db = (store as unknown as { db: Database }).db
    createMessageOutlineSchema(db)
    const session = store.sessions.getOrCreateSession(randomUUID(), null, null, 'reader')
    const insert = (id: string, seq: number, content: unknown, invoked: number | null = seq) => {
        db.prepare('INSERT INTO messages(id,session_id,content,created_at,seq,invoked_at) VALUES (?,?,?,?,?,?)')
            .run(id, session.id, encodeMessageContent(content), seq, seq, invoked)
    }
    const finish = () => {
        for (let batch = 0; batch < 200; batch++) {
            const result = backfillMessageOutline(db, session.id)
            expect(result.enumerated).toBeLessThanOrEqual(128)
            expect(result.decodedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
            if (result.scannedThrough >= result.headSeq) return result
        }
        throw new Error('Backfill did not progress')
    }
    return { store, db, session, insert, finish }
}
const user = (text: string) => ({ role: 'user', content: { type: 'text', text } })
const assistant = { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Long answer' } } }

describe('sparse outline metadata', () => {
    it('finds a question before 1200 answer records without reading or retaining their bodies in the directory', () => {
        const { db, session, insert, finish } = setup()
        db.transaction(() => {
            insert('question', 1, user('Find this question'))
            for (let seq = 2; seq <= 1201; seq++) insert(`answer-${seq}`, seq, assistant)
        })()
        expect(readMessageOutline(db, session.id).coverage.complete).toBe(false)
        expect(finish().complete).toBe(true)
        const page = readMessageOutline(db, session.id)
        expect(page.entries.map(entry => entry.messageId)).toEqual(['question'])
        expect(db.prepare('SELECT COUNT(*) AS n FROM message_outline').get()).toEqual({ n: 1 })
        const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT o.message_id FROM message_outline o JOIN messages m ON m.id=o.message_id
            WHERE o.session_id=? AND o.eligible=1 AND (o.position_at,o.seq)<(?,?) ORDER BY o.position_at DESC,o.seq DESC LIMIT 40`).all(session.id, 9999, 9999)
        expect(JSON.stringify(plan)).toContain('idx_message_outline_position')
        expect(JSON.stringify(plan)).not.toContain('TEMP B-TREE')
    })

    it('uses canonical position, excludes queued questions, and survives edits, invocation and deletion', () => {
        const { db, session, insert, finish } = setup()
        insert('a', 1, user('first'), 50)
        insert('b', 2, user('second'), 50)
        insert('queued', 3, user('waiting'), null)
        finish()
        const first = readMessageOutline(db, session.id, null, 1)
        expect(first.entries.map(entry => entry.messageId)).toEqual(['b'])
        expect(readMessageOutline(db, session.id, first.before, 1).entries.map(entry => entry.messageId)).toEqual(['a'])
        db.prepare('UPDATE messages SET invoked_at=60 WHERE id=?').run('queued')
        expect(readMessageOutline(db, session.id).entries[0].messageId).toBe('queued')
        db.prepare('UPDATE messages SET content=? WHERE id=?').run(encodeMessageContent(user('edited')), 'b')
        expect(getMessageOutlineCoverage(db, session.id).complete).toBe(false)
        db.transaction(() => indexMessageOutline(db, 'b', user('edited')))()
        expect(readMessageOutline(db, session.id).entries.find(entry => entry.messageId === 'b')?.label).toBe('edited')
        db.prepare('DELETE FROM messages WHERE id=?').run('b')
        expect(readMessageOutline(db, session.id).entries.some(entry => entry.messageId === 'b')).toBe(false)
    })

    it('does not report unreadable history as a complete empty directory', () => {
        const { db, session, insert, finish } = setup()
        insert('bad', 1, user('original'))
        db.prepare('UPDATE messages SET content=? WHERE id=?').run(new Uint8Array([1, 2, 3]), 'bad')
        const progress = finish()
        expect(progress.unreadable).toBe(true)
        expect(progress.complete).toBe(false)
        db.prepare('UPDATE messages SET content=? WHERE id=?').run(encodeMessageContent(user('repaired')), 'bad')
        expect(finish().complete).toBe(true)
        expect(readMessageOutline(db, session.id).entries[0].label).toBe('repaired')
    })
    it('rolls back a database read failure instead of persisting an unreadable message', () => {
        const { db, session, insert, finish } = setup()
        insert('retryable', 1, user('A valid question'))
        const target = db as unknown as { prepare: (sql: string) => unknown }
        const original = target.prepare
        target.prepare = function (sql: string) {
            if (sql === 'SELECT content FROM messages WHERE id=?') throw new Error('SQLITE_IOERR injected read failure')
            return original.call(db, sql)
        }
        try { expect(() => backfillMessageOutline(db, session.id)).toThrow('SQLITE_IOERR') }
        finally { target.prepare = original }
        expect(getMessageOutlineCoverage(db, session.id)).toMatchObject({ scannedThrough: 0, unreadable: false })
        expect(finish().complete).toBe(true)
        expect(readMessageOutline(db, session.id).entries[0].messageId).toBe('retryable')
    })

    it('seeks eligible metadata past a large scheduled queue', () => {
        const { db, session, insert } = setup()
        db.transaction(() => {
            insert('visible', 1, user('Read this'))
            indexMessageOutline(db, 'visible', user('Read this'))
            for (let seq = 2; seq <= 10001; seq++) {
                insert(`queued-${seq}`, seq, user('Scheduled'), null)
                indexMessageOutline(db, `queued-${seq}`, user('Scheduled'))
            }
        })()
        expect(readMessageOutline(db, session.id, null, 1).entries.map(entry => entry.messageId)).toEqual(['visible'])
        const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT o.message_id FROM message_outline o
            JOIN messages m ON m.id=o.message_id WHERE o.session_id=? AND o.eligible=1
            ORDER BY o.position_at DESC,o.seq DESC LIMIT 2`).all(session.id)
        expect(JSON.stringify(plan)).toContain('session_id=? AND eligible=?')
        expect(JSON.stringify(plan)).not.toContain('TEMP B-TREE')
    })

})
