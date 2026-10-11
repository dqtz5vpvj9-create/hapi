import test from 'node:test'
import assert from 'node:assert/strict'
import { changed, identity, validateCells, verifyBuild } from './receipts.mjs'
test('receipts are order independent and reject additions/removals/content changes', () => {
    assert.equal(identity({ b: '2', a: '1' }), identity({ a: '1', b: '2' }))
    assert.deepEqual(changed({ a: '1', b: '2' }, { a: '3', c: '4' }), ['a', 'b', 'c'])
})
test('cell validation bounds workloads and rejects unsupported anchor claims', () => {
    const cell = { count: 1000, viewport: 'phone', entry: 'saved', mode: 'lean', cpu: false }
    assert.deepEqual(validateCells([cell]), [cell])
    for (const patch of [{ count: 5001 }, { count: 4.1 }, { viewport: 'tablet' }, { mode: 'unknown' }, { cpu: 1 }, { mode: 'anchor', entry: 'ui' }, { mode: 'anchor', count: 99 }]) assert.throws(() => validateCells([{ ...cell, ...patch }]))
    assert.throws(() => validateCells([])); assert.throws(() => validateCells(Array(31).fill(cell)))
})

test('build verification rejects source/helper drift and receipt or asset tampering', () => {
    const sources = { 'web/src/App.tsx': 'source', 'harness/driver.mjs': 'helper' }, assets = { 'assets/app.js': 'bundle' }
    const receipt = { code: 0, timedOut: false, interrupted: false, changedDuringBuild: [], sources, sourceIdentity: identity(sources), assets, assetIdentity: identity(assets) }
    assert.doesNotThrow(() => verifyBuild(receipt, assets, sources))
    for (const key of Object.keys(sources)) assert.throws(() => verifyBuild(receipt, assets, { ...sources, [key]: 'changed' }), /drift/)
    assert.throws(() => verifyBuild(receipt, { ...assets, 'assets/app.js': 'tampered' }, sources), /assets changed/)
    assert.throws(() => verifyBuild({ ...receipt, sources: { ...sources, extra: 'changed' } }, assets, sources), /receipt/)
    assert.throws(() => verifyBuild({ ...receipt, interrupted: true }, assets, sources), /Unclean/)
})
