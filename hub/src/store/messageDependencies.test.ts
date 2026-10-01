import { afterEach, describe, expect, it } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Store } from './index'
import { encodeMessageContent } from './contentCodec'
import { randomUUID } from 'node:crypto'

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
function setup() {
    const store = new Store(':memory:')
    stores.push(store)
    const db = (store as unknown as { db: Database }).db
    const session = store.sessions.getOrCreateSession(randomUUID(), null, null, 'reader')
    return { store, db, session }
}
const call = (key: string) => ({ role: 'agent', content: { type: 'output', data: {
    type: 'assistant', uuid: `uuid-${key}`, message: { content: [{ type: 'tool_use', id: key, name: 'Task', input: { prompt: `prompt-${key}`, description: 'x'.repeat(300) } }] }
} } })
const legacy = (db: Database, sessionId: string, id: string, seq: number, content: unknown) => db.prepare(`
    INSERT INTO messages(id,session_id,content,created_at,seq,invoked_at) VALUES (?,?,?,?,?,?)`)
    .run(id, sessionId, encodeMessageContent(content), seq, seq, seq)

function finishBackfill(store: Store, sessionId: string) {
    let batches = 0, decodedRows = 0
    for (;;) {
        const batch = store.messages.backfillMessageDependencies(sessionId)
        expect(batch.enumerated).toBeLessThanOrEqual(128)
        expect(batch.decodedBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
        decodedRows += batch.decodedRows
        if (++batches > 200) throw new Error('Backfill failed to progress')
        if (batch.complete) return { batches, decodedRows }
    }
}

describe('history relationship index through actual message lifecycle', () => {
    it('indexes writes atomically and looks up calls across irrelevant history within the session', () => {
        const { store, db, session } = setup()
        const first = store.messages.addMessage(session.id, call('far-task'))
        for (let i = 0; i < 1000; i++) store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: `unrelated ${i}` } })
        const child = store.messages.addMessage(session.id, { role: 'agent', content: { type: 'output', data: {
            type: 'assistant', isSidechain: true, parentToolUseId: 'far-task', uuid: 'child-uuid',
            message: { content: [{ type: 'text', text: 'child answer' }] }
        } } })
        expect(store.messages.findMessageDependencyCandidates(session.id, 'tool_call', 'far-task').map(row => row.id)).toEqual([first.id])
        expect(store.messages.findMessageDependencyCandidates(session.id, 'parent_tool_use', 'far-task').map(row => row.id)).toEqual([child.id])
        const foreign = store.sessions.getOrCreateSession('foreign', null, null, 'other')
        store.messages.addMessage(foreign.id, call('far-task'))
        expect(store.messages.findMessageDependencyCandidates(session.id, 'tool_call', 'far-task').map(row => row.id)).toEqual([first.id])
        const plan = db.prepare('EXPLAIN QUERY PLAN SELECT message_id FROM message_dependency_keys WHERE session_id=? AND extractor_version=? AND kind=? AND key=?')
            .all(session.id, 1, 'tool_call', 'far-task') as Array<{ detail: string }>
        expect(plan.some(row => row.detail.includes('idx_message_dependency_keys_lookup'))).toBe(true)
    })

    it('backfills compressed legacy messages in bounded persistent batches without decoding them again', () => {
        const { store, db, session } = setup()
        for (let i = 0; i < 501; i++) legacy(db, session.id, `legacy-${i}`, i + 1, call(`legacy-${i}`))
        expect((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE typeof(content)='blob'").get() as { n: number }).n).toBe(501)
        const first = store.messages.backfillMessageDependencies(session.id)
        expect(first.complete).toBe(false)
        expect(first.enumerated).toBeGreaterThan(0)
        expect(first.enumerated).toBeLessThanOrEqual(128)
        const rest = finishBackfill(store, session.id)
        expect(first.decodedRows + rest.decodedRows).toBe(501)
        expect(store.messages.findMessageDependencyCandidates(session.id, 'task_prompt', 'prompt-legacy-500').map(row => row.id)).toEqual(['legacy-500'])
        expect(store.messages.backfillMessageDependencies(session.id).decodedRows).toBe(0)
        expect((db.prepare('SELECT last_seq FROM message_dependency_scan WHERE session_id=?').get(session.id) as { last_seq: number }).last_seq).toBe(501)
    })

    it('invalidates facts and persisted progress on content edits, then reindexes the current content', () => {
        const { store, db, session } = setup()
        legacy(db, session.id, 'editable', 1, call('before-edit'))
        finishBackfill(store, session.id)
        db.prepare('UPDATE messages SET content=? WHERE id=?').run(encodeMessageContent(call('after-edit')), 'editable')
        expect(store.messages.findMessageDependencyCandidates(session.id, 'tool_call', 'before-edit')).toEqual([])
        finishBackfill(store, session.id)
        expect(store.messages.findMessageDependencyCandidates(session.id, 'tool_call', 'after-edit').map(row => row.id)).toEqual(['editable'])
        const queued = store.messages.syncNativeQueuedMessage(session.id, 'queued', 'old draft')
        store.messages.syncNativeQueuedMessage(session.id, 'queued', 'new draft')
        expect((db.prepare('SELECT status FROM message_dependency_state WHERE message_id=?').get(queued.id) as { status: string }).status).toBe('indexed')
    })

    it('copies with the new raw identity and moves fact scope with the actual rows', () => {
        const { store, session } = setup()
        const target = store.sessions.getOrCreateSession('target', null, null, 'reader')
        const source = store.messages.addMessage(session.id, { role: 'agent', content: { type: 'codex', data: {
            type: 'tool-call', callId: 'move-call', name: 'Bash', input: {}
        } } }, 'pending-call')
        const copied = store.messages.copyMessageToSession(target.id, source)
        expect(store.messages.findMessageDependencyCandidates(target.id, 'sdk_uuid', copied.id).map(row => row.id)).toEqual([copied.id])
        store.messages.moveUninvokedMessages(session.id, target.id)
        expect(store.messages.findMessageDependencyCandidates(session.id, 'tool_call', 'move-call')).toEqual([])
        expect(store.messages.findMessageDependencyCandidates(target.id, 'tool_call', 'move-call').length).toBeGreaterThan(0)
    })

    it('cascades removals and restarts the legacy scan after rewind reuses a sequence', () => {
        const { store, db, session } = setup()
        for (let i = 0; i < 5; i++) store.messages.addImportedMessage(session.id, call(`rewind-${i}`), `local-${i}`, i + 1000)
        finishBackfill(store, session.id)
        store.messages.truncateMessagesFromLocalId(session.id, 'local-3', [])
        expect(store.messages.findMessageDependencyCandidates(session.id, 'tool_call', 'rewind-4')).toEqual([])
        legacy(db, session.id, 'replacement', 4, call('replacement-call'))
        finishBackfill(store, session.id)
        expect(store.messages.findMessageDependencyCandidates(session.id, 'tool_call', 'replacement-call').map(row => row.id)).toEqual(['replacement'])
        expect((db.prepare('SELECT COUNT(*) AS n FROM message_dependency_keys k LEFT JOIN messages m ON m.id=k.message_id WHERE m.id IS NULL').get() as { n: number }).n).toBe(0)
    })

    it('records unsupported and corrupt legacy content so subsequent reads do not repeatedly decode it', () => {
        const { store, db, session } = setup()
        legacy(db, session.id, 'unknown', 1, { role: 'agent', content: { type: 'future-agent', data: { callId: 'unknown' } } })
        legacy(db, session.id, 'broken', 2, null)
        db.prepare('UPDATE messages SET content=? WHERE id=?').run(new Uint8Array([1, 2, 3]), 'broken')
        finishBackfill(store, session.id)
        const states = db.prepare('SELECT message_id,status FROM message_dependency_state ORDER BY message_id').all()
        expect(states).toEqual([{ message_id: 'broken', status: 'decode_error' }, { message_id: 'unknown', status: 'unsupported' }])
        expect(store.messages.backfillMessageDependencies(session.id).decodedRows).toBe(0)
    })
    it('rolls back the message, epoch and partial index when a relationship write fails', () => {
        const { store, db, session } = setup()
        db.exec(`CREATE TRIGGER reject_relationship BEFORE INSERT ON message_dependency_keys
            WHEN NEW.key='reject-call' BEGIN SELECT RAISE(ABORT, 'relationship write rejected'); END;`)
        expect(() => store.messages.addMessage(session.id, call('reject-call'))).toThrow('relationship write rejected')
        expect(store.messages.countMessages(session.id)).toBe(0)
        expect((db.prepare('SELECT COUNT(*) AS n FROM message_dependency_state').get() as { n: number }).n).toBe(0)
        expect(store.messages.getMessageEpoch(session.id)).toBe(0)
        const row = store.messages.addMessage(session.id, call('valid-call'))
        expect(() => store.messages.copyMessagesToSession(session.id, [row, { ...row, content: call('reject-call') }]))
            .toThrow('relationship write rejected')
        expect(store.messages.countMessages(session.id)).toBe(1)
        expect(store.messages.findMessageDependencyCandidates(session.id, 'tool_call', 'valid-call').map(m => m.id)).toEqual([row.id])
    })

    it('keeps both legacy prompt candidates and both calls in one message without choosing a parent', () => {
        const { store, session } = setup()
        const firstContent = call('call-a')
        const blocks = firstContent.content.data.message.content
        blocks[0].input.prompt = 'same prompt'
        blocks.push({ ...blocks[0], id: 'call-b' })
        const first = store.messages.addMessage(session.id, firstContent)
        const secondContent = call('call-c')
        secondContent.content.data.message.content[0].input.prompt = 'same prompt'
        const second = store.messages.addMessage(session.id, secondContent)
        const candidates = store.messages.findMessageDependencyCandidates(session.id, 'task_prompt', 'same prompt')
            .sort((a, b) => a.at - b.at || a.seq - b.seq || a.ordinal - b.ordinal)
        expect(candidates.map(row => [row.id, row.ordinal])).toEqual([[first.id, 0], [first.id, 1], [second.id, 0]])
        expect(store.messages.findMessageDependencyCandidates(session.id, 'task_prompt', 'Same prompt')).toEqual([])
        expect(store.messages.findMessageDependencyCandidates(session.id, 'subagent_call', 'call-b').map(row => row.id)).toEqual([first.id])
        const target = store.sessions.getOrCreateSession('merge-target', null, null, 'reader')
        expect(store.messages.mergeSessionMessages(session.id, target.id).moved).toBe(2)
        expect(store.messages.findMessageDependencyCandidates(session.id, 'task_prompt', 'same prompt')).toEqual([])
        expect(store.messages.findMessageDependencyCandidates(target.id, 'task_prompt', 'same prompt')).toHaveLength(3)
    })

    it('stops at the candidate budget using the actual joined query index order', () => {
        const { store, db, session } = setup()
        for (let i = 0; i < 260; i++) store.messages.addMessage(session.id, call('many-members'))
        expect(store.messages.findMessageDependencyCandidates(session.id, 'tool_call', 'many-members', 1000)).toHaveLength(201)
        const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT m.id,m.seq,COALESCE(m.invoked_at,m.created_at) AS at,k.ordinal,s.is_sidechain AS isSidechain
            FROM message_dependency_keys k JOIN messages m ON m.id=k.message_id
            JOIN message_dependency_state s ON s.message_id=m.id AND s.extractor_version=?
            WHERE k.extractor_version=? AND k.session_id=? AND m.session_id=? AND k.kind=? AND k.key=?
            ORDER BY k.message_id,k.ordinal LIMIT ?`).all(1, 1, session.id, session.id, 'tool_call', 'many-members', 201) as Array<{ detail: string }>
        expect(plan.some(row => row.detail.includes('idx_message_dependency_keys_lookup'))).toBe(true)
        expect(plan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false)
    })

    it('seeks the extractor generation before scanning a large old-key region', () => {
        const { store, db, session } = setup()
        for (let i = 0; i < 501; i++) store.messages.addMessage(session.id, call('old-generation'))
        db.prepare('UPDATE message_dependency_state SET extractor_version=0 WHERE session_id=?').run(session.id)
        db.prepare('UPDATE message_dependency_keys SET extractor_version=0 WHERE session_id=?').run(session.id)
        expect(store.messages.findMessageDependencyCandidates(session.id, 'tool_call', 'old-generation')).toEqual([])
        const fresh = store.messages.addMessage(session.id, call('old-generation'))
        expect(store.messages.findMessageDependencyCandidates(session.id, 'tool_call', 'old-generation').map(row=>row.id)).toEqual([fresh.id])
        const plan = db.prepare('EXPLAIN QUERY PLAN SELECT message_id FROM message_dependency_keys WHERE session_id=? AND extractor_version=? AND kind=? AND key=?')
            .all(session.id,1,'tool_call','old-generation') as Array<{detail:string}>
        expect(plan.some(row=>row.detail.includes('extractor_version=? AND kind=? AND key=?'))).toBe(true)
    })

    it('classifies over-limit compressed JSON as unsupported and charges failed decode attempts', () => {
        const { store, db, session } = setup()
        const oversized = {role:'user',content:{type:'text',text:'x'.repeat(3*1024*1024)}}
        for(let i=0;i<3;i++) legacy(db,session.id,`large-${i}`,i+1,oversized)
        const first=store.messages.backfillMessageDependencies(session.id)
        expect(first.decodedRows).toBe(1)
        expect(first.decodedBytes).toBe(0)
        expect(first.budgetedBytes).toBe(2*1024*1024)
        expect((db.prepare('SELECT status FROM message_dependency_state WHERE message_id=?').get('large-0') as {status:string}).status).toBe('unsupported')
        finishBackfill(store,session.id)
        expect(store.messages.backfillMessageDependencies(session.id).decodedRows).toBe(0)
    })

    it('rolls back a failed backfill index write and retries the same row after the failure is removed', () => {
        const {store,db,session}=setup()
        legacy(db,session.id,'legacy-retry',1,call('reject-backfill'))
        db.exec(`CREATE TRIGGER reject_backfill BEFORE INSERT ON message_dependency_keys
            WHEN NEW.key='reject-backfill' BEGIN SELECT RAISE(ABORT,'index write failure'); END;`)
        expect(()=>store.messages.backfillMessageDependencies(session.id)).toThrow('index write failure')
        expect(db.prepare('SELECT * FROM message_dependency_state WHERE message_id=?').get('legacy-retry')).toBeNull()
        expect(db.prepare('SELECT * FROM message_dependency_scan WHERE session_id=?').get(session.id)).toBeNull()
        db.exec('DROP TRIGGER reject_backfill')
        finishBackfill(store,session.id)
        expect(store.messages.findMessageDependencyCandidates(session.id,'tool_call','reject-backfill').map(row=>row.id)).toEqual(['legacy-retry'])
    })

})
