import test from 'node:test'
import assert from 'node:assert/strict'
import { driverFiles, validateHistoryCells } from './cells.mjs'
const cell = { historyCount: 100000, viewport: 'phone', mode: 'lean', cpu: false }
test('scenarios select distinct unchanged driver/probe pairs', () => {
    assert.deepEqual(driverFiles.cold, ['driver-cold.mjs', 'probe-cold.mjs'])
    assert.deepEqual(driverFiles.warm, ['driver-warm.mjs', 'probe-warm.mjs'])
    assert.deepEqual(driverFiles.geometry, ['driver-geometry.mjs', 'probe-geometry.mjs'])
})
test('accepted matrix remains bounded and explicit; does not mutate caller cells', () => {
    for (const historyCount of [320, 10000, 100000]) for (const viewport of ['phone', 'desktop']) {
        const input = { ...cell, historyCount, viewport }
        assert.deepEqual(validateHistoryCells('cold', [input]), [{ ...input, entry: 'cold' }])
        assert.equal(input.entry, undefined)
    }
    for (const warmMode of ['code', 'target']) assert.equal(validateHistoryCells('warm', [{ ...cell, warmMode }])[0].warmMode, warmMode)
    assert.equal(validateHistoryCells('geometry', [cell])[0].entry, 'geometry')
})
test('reject missing/malformed/unbounded or semantically confused cells', () => {
    for (const value of [null, [], Array(31).fill(cell), {}, [null], [{ ...cell, historyCount: 100001 }], [{ ...cell, cpu: 'false' }], [{ ...cell, mode: 'unknown' }], [{ ...cell, entry: 'warm' }]]) assert.throws(() => validateHistoryCells('cold', value))
    assert.throws(() => validateHistoryCells('unknown', [cell]))
    assert.throws(() => validateHistoryCells('__proto__', [cell]))
    assert.throws(() => validateHistoryCells('warm', [cell]))
    assert.throws(() => validateHistoryCells('cold', [{ ...cell, warmMode: 'target' }]))
    assert.throws(() => validateHistoryCells('cold', [{ ...cell, mode: 'full', cpu: true }]))
    assert.throws(() => validateHistoryCells('geometry', [{ ...cell, mode: 'full' }]))
    assert.throws(() => validateHistoryCells('geometry', [{ ...cell, cpu: true }]))
})
