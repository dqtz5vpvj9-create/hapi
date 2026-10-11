import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extendRecentFixture } from './fixture-transform.mjs'
test('known workspace fixture gets count/order and lazy unchanged histories', () => {
    const raw = fs.readFileSync(path.join(process.env.SOURCE_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url)), 'web/e2e-fixtures/workspace-fixture.tsx'), 'utf8')
    const code = extendRecentFixture(raw)
    assert.match(code, /logicalRowsPerSession: 320/)
    assert.match(code, /createAppRouter\(createMemoryHistory/)
    assert.match(code, /history.get = \(id: string\)/)
    assert.match(code, /recentTime\(index\)/)
    assert.throws(() => extendRecentFixture('changed'), /contract changed/)
})
test('inserted roots have a genuinely distinct native identity', () => {
    const raw = fs.readFileSync(path.join(process.env.SOURCE_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url)), 'web/e2e-fixtures/workspace-fixture.tsx'), 'utf8')
    const code = extendRecentFixture(raw)
    assert.match(code, /codexSessionId: 'native-' \+ index/)
    assert.throws(() => extendRecentFixture(raw + raw), /contract changed/)
})
test('synthetic insertion emits a new native ID and rejects duplicate roots', () => {
    const raw = fs.readFileSync(path.join(process.env.SOURCE_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url)), 'web/e2e-fixtures/workspace-fixture.tsx'), 'utf8')
    const code = extendRecentFixture(raw)
    const body = code.match(/insertRecent\(id: string, updatedAt: number\) \{([\s\S]*?)\n    \},/)[1].replace('sessions[0].metadata!', 'sessions[0].metadata')
    const sessions = [{ id: 'chat-1', metadata: { codexSessionId: 'native-1', name: 'Original' } }], emitted = []
    const insert = new Function('sessions', 'streams', 'id', 'updatedAt', body)
    insert(sessions, [{ emit: event => emitted.push(event) }], 'chat-1001', 123)
    assert.equal(sessions.length, 2)
    assert.equal(sessions[1].metadata.codexSessionId, 'native-1001')
    assert.equal(sessions[0].metadata.codexSessionId, 'native-1')
    assert.equal(emitted[0].sessionId, 'chat-1001')
    assert.equal(emitted[0].data.updatedAt, 123)
    assert.throws(() => insert(sessions, [], 'chat-1001', 124), /Duplicate/)
})
