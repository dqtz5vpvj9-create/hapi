import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'

describe('spawn receipts', () => {
    it('migrates v31 and retains claimed and completed identities through restart', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-spawn-'))
        const path = join(dir, 'hapi.db')
        let store = new Store(path)
        try {
            store.close()
            const legacy = new Database(path)
            legacy.exec('DROP TABLE spawn_requests; PRAGMA user_version=31')
            legacy.close()
            store = new Store(path)
            expect(store.spawnRequests.claim('a', 'request', 'hash', 'session')).toBe(true)
            expect(store.spawnRequests.claim('a', 'request', 'hash', 'other')).toBe(false)
            store.close()
            store = new Store(path)
            expect(store.spawnRequests.get('a', 'request')).toEqual({ fingerprint: 'hash', sessionId: 'session', response: null })
            expect(store.spawnRequests.get('b', 'request')).toBeUndefined()
            store.spawnRequests.complete('a', 'request', { type: 'success', sessionId: 'session' })
            store.close()
            store = new Store(path)
            expect(store.spawnRequests.get('a', 'request')?.response).toEqual({ type: 'success', sessionId: 'session' })
            expect(store.spawnRequests.claim('a', 'request', 'hash', 'other')).toBe(false)
        } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
    })
})
