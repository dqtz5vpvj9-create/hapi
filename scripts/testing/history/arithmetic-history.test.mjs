import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createArithmeticHistory } from './arithmetic-history.mjs'
import { extendLongHistoryFixture } from './fixture-transform.mjs'
const createdAt = 1790000000000
function fixture(count, logLimit = 256) {
    let generated = 0
    const service = createArithmeticHistory({ count, createdAt, logLimit,
        sessionIds: Array.from({ length: 1000 }, (_, i) => `chat-${i + 1}`),
        message: (id, seq) => { generated++; return { id: `${id}-m-${seq}`, seq, createdAt: createdAt + seq, invokedAt: createdAt + seq, content: { text: '固定的测试内容' } } } })
    const read = (query = '', suffix = '/messages', id = 'chat-1') => {
        const response = service.read(id, suffix, new URLSearchParams(query))
        assert.equal(response.bytes, Buffer.byteLength(response.body))
        return { ...response, data: JSON.parse(response.body) }
    }
    return { service, read, generated: () => generated }
}
const cursor = (name, seq, at = createdAt + seq) => `${name}At=${at}&${name}Seq=${seq}`
for (const count of [320, 10000, 100000]) {
    test(`H=${count}: zero initial allocation, 20 tail, 200 adjacent, bounded midpoint context`, () => {
        const { service, read, generated } = fixture(count)
        assert.equal(generated(), 0)
        assert.equal(service.stats().sessions, 1000)
        const tail = read('limit=20').data
        assert.equal(tail.messages.length, 20)
        assert.equal(tail.messages[0].seq, count - 19)
        assert.equal(tail.messages.at(-1).seq, count)
        assert.equal(tail.page.hasMore, true)
        const previous = read(`limit=200&epoch=1&bounded=true&${cursor('before', count - 19)}`).data
        assert.equal(previous.messages.length, 200)
        assert.equal(previous.messages.at(-1).seq, count - 20)
        const mid = Math.floor(count / 2)
        const context = read('radius=99&epoch=1', `/messages/chat-1-m-${mid}/context`).data
        assert.equal(context.messages.length, 199)
        assert.equal(context.anchor.messageId, `chat-1-m-${mid}`)
        assert.equal(context.messages[99].seq, mid)
        assert.equal(context.page.hasMoreBefore, true)
        assert.equal(context.page.hasMoreAfter, true)
        assert.equal(generated(), 419)
        assert.equal(service.stats().generatedBodies, 419)
        assert.equal(service.stats().retainedBodies, 0)
        assert.equal(service.stats().maxBodiesPerRequest, 200)
    })
    test(`H=${count}: paginated outline does not generate bodies`, () => {
        const { service, read, generated } = fixture(count)
        const latest = read('limit=100&epoch=1', '/messages/outline').data
        assert.equal(latest.entries.length, 100)
        assert.equal(latest.entries.at(-1).seq, count - 1)
        const previous = read(`limit=100&epoch=1&${cursor('before', latest.entries[0].seq)}`, '/messages/outline').data
        assert.ok(previous.entries.at(-1).seq < latest.entries[0].seq)
        assert.equal(generated(), 0)
        assert.equal(service.stats().generatedBodies, 0)
        assert.ok(service.stats().maxLabelsPerRequest <= 100)
        assert.equal(latest.page.scannedThrough, count)
        assert.equal(latest.page.indexing, false)
    })
}
test('cursor arithmetic matches lexicographic reference including tie positions', () => {
    const { read } = fixture(320)
    const reference = Array.from({ length: 320 }, (_, i) => ({ at: createdAt + i + 1, seq: i + 1 }))
    const compare = (a, b) => a.at - b.at || a.seq - b.seq
    for (const seq of [1, 2, 159, 319, 320, 321]) for (const offset of [-1, 0, 1]) {
        const point = { at: createdAt + seq + offset, seq }
        for (const direction of ['before', 'after']) {
            const result = read(`limit=17&epoch=1&${cursor(direction, seq, point.at)}`).data
            const eligible = reference.filter(row => direction === 'before' ? compare(row, point) < 0 : compare(row, point) > 0)
            const expected = direction === 'before' ? eligible.slice(-17) : eligible.slice(0, 17)
            assert.deepEqual(result.messages.map(row => row.seq), expected.map(row => row.seq))
            assert.equal(result.page.hasMore, eligible.length > expected.length)
        }
    }
})
test('after until is inclusive and does not claim more beyond captured snapshot', () => {
    const { read } = fixture(100000)
    const result = read(`limit=200&epoch=1&${cursor('after', 99900)}&${cursor('until', 99907)}`).data
    assert.deepEqual(result.messages.map(row => row.seq), [99901, 99902, 99903, 99904, 99905, 99906, 99907])
    assert.equal(result.page.hasMore, false)
    assert.equal(result.page.snapshotHeadSeq, 100000)
})
test('forward/backward pagination covers each row once without gaps', () => {
    const { read } = fixture(320)
    const a = read('limit=200').data, b = read(`limit=200&epoch=1&${cursor('before', a.messages[0].seq)}`).data
    assert.deepEqual([...b.messages, ...a.messages].map(row => row.seq), Array.from({ length: 320 }, (_, i) => i + 1))
    const c = read(`limit=200&epoch=1&${cursor('after', 1)}&${cursor('until', 320)}`).data
    const d = read(`limit=200&epoch=1&${cursor('after', c.messages.at(-1).seq)}&${cursor('until', 320)}`).data
    assert.deepEqual([...c.messages, ...d.messages].map(row => row.seq), Array.from({ length: 319 }, (_, i) => i + 2))
    assert.equal(b.page.hasMore, false); assert.equal(d.page.hasMore, false)
})
test('context boundaries and message identity are exact; malformed inputs generate no bodies', () => {
    const { read, generated } = fixture(100000)
    for (const seq of [1, 100000]) {
        const result = read('radius=99', `/messages/chat-1-m-${seq}/context`).data
        assert.equal(result.messages.length, 100)
        assert.equal(result.page.hasMoreBefore, seq !== 1)
        assert.equal(result.page.hasMoreAfter, seq !== 100000)
    }
    const before = generated()
    for (const suffix of ['/messages/chat-2-m-1/context', '/messages/chat-1-m-01/context', '/messages/chat-1-m-0/context', '/messages/chat-1-m-100001/context']) assert.equal(read('radius=99', suffix).status, 404)
    for (const q of ['limit=201', 'limit=0', 'limit=1.5', 'beforeSeq=2', 'beforeAt=5', 'epoch=1', 'untilAt=5&untilSeq=1', 'bounded=maybe']) assert.equal(read(q).status, 400)
    assert.equal(read('radius=100', '/messages/chat-1-m-100/context').status, 400)
    assert.equal(read(cursor('before', 200), '/messages/outline').status, 400)
    assert.equal(read('limit=101', '/messages/outline').status, 400)
    assert.equal(read('', '/messages', 'chat-1001').status, 404)
    assert.equal(generated(), before)
})
test('epoch mismatch resets message/outline cursors but preserves context identity', () => {
    const { service, read } = fixture(10000)
    service.setEpoch('chat-1', 2)
    const tail = read(`limit=20&epoch=1&${cursor('before', 500)}`).data
    assert.equal(tail.page.reset, true); assert.equal(tail.page.epoch, 2); assert.equal(tail.page.direction, 'latest')
    assert.equal(tail.messages.at(-1).seq, 10000)
    const outline = read(`limit=5&epoch=1&${cursor('before', 500)}`, '/messages/outline').data
    assert.equal(outline.page.reset, true); assert.equal(outline.entries.at(-1).seq, 9999)
    const context = read('radius=2&epoch=1', '/messages/chat-1-m-500/context').data
    assert.equal(context.page.reset, true); assert.equal(context.anchor.messageId, 'chat-1-m-500')
})
test('metrics retention is bounded and response counters reconcile', () => {
    const { service, read } = fixture(100000, 8)
    let bytes = 0
    for (let i = 0; i < 30; i++) bytes += read('limit=20').bytes
    const stats = service.stats()
    assert.equal(stats.records.length, 8); assert.equal(stats.droppedRecords, 22)
    assert.equal(stats.requests, 30); assert.equal(stats.generatedBodies, 600); assert.equal(stats.responseBytes, bytes)
    stats.records[0].id = 'modified'; assert.equal(service.stats().records[0].id, 'chat-1')
})
test('portable transform replaces entire lazy history and intercepts only synthetic boundary', () => {
    const raw = fs.readFileSync(path.join(process.env.SOURCE_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url)), 'web/e2e-fixtures/workspace-fixture.tsx'), 'utf8')
    const transformed = extendLongHistoryFixture(raw)
    assert.doesNotMatch(transformed, /Array\.from\(\{ length: 320 \}/)
    assert.doesNotMatch(transformed, /history\.get =/)
    assert.match(transformed, /createAppRouter\(createMemoryHistory/)
    assert.match(transformed, /const arithmeticHistory = createArithmeticHistory/)
    assert.match(transformed, /historyBenchmark:/)
    assert.ok(transformed.indexOf('if (method === \'GET\' && historyRoute)') < transformed.indexOf('const eligible = rows.filter'))
    assert.throws(() => extendLongHistoryFixture('unknown source'), /contract changed/)
})

test('native epoch-reset semantics retain until and report actual full snapshot head', () => {
    const { service, read } = fixture(10000)
    service.setEpoch('chat-1', 2)
    const result = read(`limit=20&epoch=1&${cursor('after', 100)}&${cursor('until', 150)}`).data
    assert.equal(result.page.reset, true); assert.equal(result.page.direction, 'latest')
    assert.equal(result.messages[0].seq, 131); assert.equal(result.messages.at(-1).seq, 150)
    assert.equal(result.page.snapshotHeadSeq, 10000)
    assert.equal(result.page.nextBeforeSeq, 131)
})

test('native dense empty pages preserve direction and head with null page cursors', () => {
    const { read, generated } = fixture(100000)
    for (const [direction, seq] of [['before', 1], ['after', 100000]]) {
        const result = read(`limit=200&epoch=1&${cursor(direction, seq)}`).data
        assert.deepEqual(result.messages, []); assert.equal(result.page.direction, direction)
        assert.equal(result.page.hasMore, false); assert.equal(result.page.snapshotHeadSeq, 100000)
        for (const key of ['nextBeforeAt', 'nextBeforeSeq', 'nextAfterAt', 'nextAfterSeq']) assert.equal(result.page[key], null)
    }
    assert.equal(generated(), 0)
})
