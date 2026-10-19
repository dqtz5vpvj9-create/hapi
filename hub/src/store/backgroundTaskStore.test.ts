import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'
import { SessionCache } from '../sync/sessionCache'
import type { EventPublisher } from '../sync/eventPublisher'

function start(id: string) {
    return { role: 'agent', content: { type: 'output', data: { type: 'tool_result', content: `Command running in background with ID: ${id}` } } }
}
function complete(id: string) {
    return { role: 'agent', content: { type: 'output', data: { type: 'user', message: { content: `<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>` } } } }
}
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

function fixture(path = ':memory:') {
    const store = new Store(path)
    const cache = new SessionCache(store, { emit() {} } as unknown as EventPublisher)
    const session = cache.getOrCreateSession('test', { path: '/work', host: 'local', flavor: 'claude' }, null, 'owner')
    const send = (content: unknown, createdAt = Date.now(), localId?: string) => {
        store.messages.addAgentMessage(session.id, content, localId, createdAt)
        cache.refreshBackgroundTasks(session.id)
    }
    return { store, cache, session, send }
}

describe('durable background task observations', () => {
    it('deduplicates starts/completions and never resurrects a terminal task', () => {
        const f = fixture()
        try {
            f.cache.markSessionActive(f.session.id)
            f.send(start('a')); f.send(start('a')); f.send(start('b'))
            expect(f.cache.getSession(f.session.id)?.backgroundTaskCount).toBe(2)
            f.send(complete('a')); f.send(complete('a')); f.send(start('a'))
            expect(f.store.backgroundTasks.runningCount(f.session.id)).toBe(1)
            f.send(complete('c')); f.send(start('c'))
            expect(f.store.backgroundTasks.runningCount(f.session.id)).toBe(1)
            f.send({ role: 'agent', content: { type: 'output', data: { type: 'user', content: '<task-notification>Done</task-notification>' } } })
            expect(f.store.backgroundTasks.runningCount(f.session.id)).toBe(1)
            expect(f.store.backgroundTasks.list(f.session.id).map(({ taskId, state }) => [taskId, state])).toEqual([['a', 'completed'], ['b', 'running'], ['c', 'completed']])
        } finally { f.store.close() }
    })

    it('recovers after a real database close/reopen and hides disconnected counts until keepalive returns', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-bg-state-')); directories.push(directory)
        const path = join(directory, 'hapi.db')
        const f = fixture(path)
        f.cache.handleSessionAlive({ sid: f.session.id, time: Date.now(), thinking: false })
        f.send(start('a')); f.send(start('b')); f.send(complete('b'))
        f.cache.expireInactive(Date.now() + 31_000)
        expect(f.cache.getSession(f.session.id)?.backgroundTaskCount).toBe(0)
        expect(f.store.backgroundTasks.runningCount(f.session.id)).toBe(1)
        f.store.close()
        const store = new Store(path)
        try {
            const cache = new SessionCache(store, { emit() {} } as unknown as EventPublisher)
            cache.reloadAll()
            expect(cache.getSession(f.session.id)?.backgroundTaskCount).toBe(0)
            cache.handleSessionAlive({ sid: f.session.id, time: Date.now(), thinking: false })
            expect(cache.getSession(f.session.id)?.backgroundTaskCount).toBe(1)
            store.messages.addAgentMessage(f.session.id, start('b'))
            cache.refreshBackgroundTasks(f.session.id)
            expect(cache.getSession(f.session.id)?.backgroundTaskCount).toBe(1)
        } finally { store.close() }
    })

    it('explicit end detaches tasks and fences late transcript starts while allowing new task IDs', () => {
        const f = fixture()
        try {
            const now = Date.now()
            f.cache.handleSessionAlive({ sid: f.session.id, time: now - 20, sourceConnection: 2 })
            f.send(start('running'), now - 100)
            f.cache.handleSessionEnd({ sid: f.session.id, time: now - 20, sourceConnection: 1 })
            expect(f.store.backgroundTasks.runningCount(f.session.id)).toBe(1)
            f.cache.handleSessionEnd({ sid: f.session.id, time: now - 20, sourceConnection: 2 })
            f.send(start('running'), now + 1)
            f.send(start('previously-unseen-old-task'), now - 30)
            expect(f.store.backgroundTasks.runningCount(f.session.id)).toBe(0)
            f.send(complete('running'))
            expect(f.store.backgroundTasks.list(f.session.id).find(entry => entry.taskId === 'running')?.state).toBe('completed')
            f.send(start('new-task'), now + 2)
            f.cache.handleSessionAlive({ sid: f.session.id, time: now + 2, sourceConnection: 3 })
            expect(f.cache.getSession(f.session.id)?.backgroundTaskCount).toBe(1)
        } finally { f.store.close() }
    })

    it('scopes identical task IDs to sessions and excludes copied/imported history', () => {
        const f = fixture()
        try {
            const other = f.store.sessions.getOrCreateSession('other', {}, null, 'foreign')
            const fork = f.store.sessions.getOrCreateSession('fork', {}, null, 'owner')
            const message = f.store.messages.addAgentMessage(f.session.id, start('shared-id'))
            f.store.messages.addAgentMessage(other.id, start('shared-id'))
            f.send(complete('shared-id'))
            f.store.messages.copyMessageToSession(fork.id, message)
            f.store.messages.addImportedMessage(fork.id, start('imported'), 'import', 1000)
            expect(f.store.backgroundTasks.runningCount(f.session.id)).toBe(0)
            expect(f.store.backgroundTasks.runningCount(other.id)).toBe(1)
            expect(f.store.backgroundTasks.list(fork.id)).toEqual([])
            expect(f.cache.resolveSessionAccess(other.id, 'owner')).toMatchObject({ ok: false, reason: 'access-denied' })
        } finally { f.store.close() }
    })

    it('uses canonical stored content on localId replay and commits message/task state atomically', () => {
        const f = fixture()
        try {
            f.send(start('a'), Date.now(), 'same-message')
            f.send(start('b'))
            f.send(complete('b'), Date.now(), 'same-message')
            expect(f.store.backgroundTasks.runningCount(f.session.id)).toBe(2)
            const db = (f.store as unknown as { db: Database }).db
            db.exec("CREATE TRIGGER reject_background_task BEFORE INSERT ON session_background_tasks BEGIN SELECT RAISE(ABORT,'test rejection'); END;")
            const count = f.store.messages.getAllMessages(f.session.id).length
            expect(() => f.send(start('rejected'))).toThrow('test rejection')
            expect(f.store.messages.getAllMessages(f.session.id)).toHaveLength(count)
            expect(f.store.backgroundTasks.list(f.session.id).some(entry => entry.taskId === 'rejected')).toBe(false)
        } finally { f.store.close() }
    })

    it('merges same-session observations without losing terminal tombstones or crossing namespaces', () => {
        const f = fixture()
        try {
            const target = f.store.sessions.getOrCreateSession('target', {}, null, 'owner')
            const foreign = f.store.sessions.getOrCreateSession('foreign', {}, null, 'foreign')
            f.send(start('a')); f.send(complete('a')); f.send(start('b'))
            f.store.messages.addAgentMessage(target.id, start('a'))
            f.store.backgroundTasks.merge(f.session.id, target.id)
            expect(f.store.backgroundTasks.runningCount(target.id)).toBe(1)
            f.store.messages.addAgentMessage(target.id, start('a'))
            expect(f.store.backgroundTasks.runningCount(target.id)).toBe(1)
            expect(() => f.store.backgroundTasks.merge(f.session.id, foreign.id)).toThrow('scope mismatch')
            expect(f.store.backgroundTasks.list(foreign.id)).toEqual([])
        } finally { f.store.close() }
    })

    it('upgrades schema 32 without treating historical tasks as live processes', () => {
        const directory = mkdtempSync(join(tmpdir(), 'hapi-bg-migration-')); directories.push(directory)
        const path = join(directory, 'hapi.db')
        const f = fixture(path); f.send(start('historical')); f.store.close()
        const db = new Database(path)
        db.exec('DROP TABLE session_background_tasks; DROP TABLE session_background_task_fences; PRAGMA user_version=32;')
        db.close()
        const store = new Store(path)
        try {
            expect((store as unknown as { db: Database }).db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 33 })
            expect(store.messages.getAllMessages(f.session.id)).toHaveLength(1)
            expect(store.backgroundTasks.list(f.session.id)).toEqual([])
            store.messages.addAgentMessage(f.session.id, start('new-observation'))
            expect(store.backgroundTasks.runningCount(f.session.id)).toBe(1)
        } finally { store.close() }
    })
})
