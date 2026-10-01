import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { Store } from './index'

const id = 'codex:thread:turn:item:agent_message'
function content(text: string, live = true) {
    return { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE,
        data: { type: 'message', id, message: text, ...(live ? { streamSnapshot: true } : {}) } } }
}

describe('native text persistence', () => {
    it('recovers the last partial after a restart and retires it on interruption', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-native-text-'))
        const path = join(directory, 'test.db')
        let store = new Store(path)
        try {
            const session = store.sessions.getOrCreateSession('restart', {}, null, 'default')
            store.messages.addAgentMessage(session.id, content('first'))
            store.messages.addAgentMessage(session.id, content('last partial'))
            store.close()
            store = new Store(path)
            expect(store.messages.getAllMessages(session.id).map(row => row.content)).toEqual([content('last partial')])
            store.messages.addAgentMessage(session.id, content('resumed partial'))
            // The bridge commits interrupted text with streamSnapshot retained,
            // but with its authoritative localId. It must survive later replay.
            store.messages.addAgentMessage(session.id, content('interrupted'), id)
            store.messages.addAgentMessage(session.id, content('late partial'))
            expect(store.messages.getAllMessages(session.id).map(row => row.content)).toEqual([content('interrupted')])
            expect(store.messages.findMessageDependencyCandidates(session.id, 'text_stream', id)).toHaveLength(1)
        } finally {
            store.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })

    it('rolls back a failed replacement without losing the last readable text', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-native-text-'))
        const path = join(directory, 'test.db')
        const store = new Store(path)
        const db = new Database(path)
        try {
            const session = store.sessions.getOrCreateSession('failed-write', {}, null, 'default')
            const previous = store.messages.addAgentMessage(session.id, content('readable partial'))
            db.exec(`CREATE TRIGGER reject_snapshot_key BEFORE UPDATE OF local_id ON messages
                BEGIN SELECT RAISE(ABORT, 'injected replacement failure'); END`)
            expect(() => store.messages.addAgentMessage(session.id, content('next partial'))).toThrow('injected replacement failure')
            expect(store.messages.getAllMessages(session.id)).toEqual([previous])
            db.exec('DROP TRIGGER reject_snapshot_key')
            store.messages.addAgentMessage(session.id, content('complete', false), id)
            expect(store.messages.getAllMessages(session.id).map(row => row.content)).toEqual([content('complete', false)])
        } finally {
            db.close()
            store.close()
            rmSync(directory, { recursive: true, force: true })
        }
    })
})
