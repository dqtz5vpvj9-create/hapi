import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { runOwnedChild, recordRun } from './lifecycle.mjs'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function fixture(pid = 1234) {
    const child = Object.assign(new EventEmitter(), { pid }), signals = new EventEmitter(), kills = []
    return { child, signals, kills, options: { spawnChild: () => child, signals, kill: (group, signal) => kills.push([group, signal]), timeoutMs: 1000, graceMs: 10 } }
}
test('fast exit during status I/O is retained; handlers and timers are removed', async () => {
    const f = fixture()
    const result = await runOwnedChild('unused', [], {}, { ...f.options, onSpawn: async () => { f.child.emit('exit', 0); await pause(5) } })
    assert.equal(result.code, 0)
    assert.deepEqual(f.kills, [[-1234, 'SIGKILL']])
    assert.equal(f.signals.listenerCount('SIGINT'), 0)
    assert.equal(f.signals.listenerCount('SIGTERM'), 0)
})
test('spawn error is retained during status I/O and never kills an invalid group', async () => {
    const f = fixture(undefined); f.child.pid = undefined
    const result = await runOwnedChild('unused', [], {}, { ...f.options, onSpawn: async () => { f.child.emit('error', new Error('ENOENT')); await pause(5) } })
    assert.equal(result.code, 1); assert.match(result.error, /ENOENT/)
    assert.deepEqual(f.kills, [])
})
test('status-write failure cleans up owned child and records a nonzero terminal receipt', async () => {
    const f = fixture(), status = {}, saved = []
    let cleaned = false
    const code = await recordRun(status, async () => saved.push({ ...status }), () => runOwnedChild('unused', [], {}, { ...f.options, onSpawn: async () => { throw new Error('status write failed') } }), async () => { cleaned = true })
    assert.equal(code, 1); assert.equal(cleaned, true)
    assert.equal(saved.at(-1).status, 'terminal'); assert.equal(saved.at(-1).code, 1)
    assert.match(saved.at(-1).failure, /status write failed/)
    assert.deepEqual(f.kills, [[-1234, 'SIGKILL']])
})
test('watchdog escalates only its owned group and cannot classify exit zero as success', async () => {
    const f = fixture()
    const result = await runOwnedChild('unused', [], {}, { ...f.options, timeoutMs: 5, kill: (group, signal) => { f.kills.push([group, signal]); if (signal === 'SIGKILL') f.child.emit('exit', 0) } })
    assert.equal(result.timedOut, true); assert.notEqual(result.code, 0)
    assert.deepEqual(f.kills.slice(0, 2), [[-1234, 'SIGTERM'], [-1234, 'SIGKILL']])
    assert.ok(f.kills.every(([group]) => group === -1234))
})
test('initial receipt-write failure skips work and still runs cleanup', async () => {
    let writes = 0, ran = false, cleaned = false
    const status = {}
    const code = await recordRun(status, async () => { if (++writes === 1) throw new Error('disk failure') }, async () => { ran = true }, async () => { cleaned = true })
    assert.equal(code, 1); assert.equal(ran, false); assert.equal(cleaned, true)
    assert.equal(status.status, 'terminal'); assert.match(status.failure, /disk failure/)
})
