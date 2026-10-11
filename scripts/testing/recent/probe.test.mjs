import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { installRecentProbe } from './probe.mjs'
test('init installs immediately without a documentElement or MutationObserver', () => {
    const events = [], context = { window: {}, document: { addEventListener: name => events.push(name), querySelector: () => null }, performance: { now: () => 10 }, PerformanceObserver: class { observe() {} }, requestAnimationFrame() {}, cancelAnimationFrame() {}, Element: class {} }
    vm.runInNewContext(`(${installRecentProbe.toString()})({mode:'lean'})`, context)
    assert.equal(typeof context.window.__recentRecovery.ready, 'function')
    assert.equal(context.window.__recentRecovery.ready(), false)
    assert.deepEqual(events, ['click', 'wheel'])
    assert.throws(() => context.window.__recentRecovery.arm(), /correct first viewport/)
})

test('clipped slices use integer device-pixel coordinates and retain unobservable status', () => {
    const context = { window: { devicePixelRatio: 1 }, document: { addEventListener() {} }, performance: { now: () => 10 }, PerformanceObserver: class { observe() {} } }
    vm.runInNewContext(`(${installRecentProbe.toString()})({mode:'full'})`, context)
    const point = context.window.__recentRecovery.pixelCoordinate
    assert.equal(point(887, 888), 887)
    assert.equal(point(887.25, 888), null)
    assert.equal(point(0, 1), 0)
    assert.equal(point(0.25, 0.75, 2), .5)
    assert.equal(point(0.25, .5, 2), null)
})
test('trusted wheel in a replacement Recent viewport is observed without a RAF DOM sample', () => {
    const handlers = {}, bounds = { top: 0, bottom: 400, left: 0, right: 300, height: 400, width: 300 }
    const row = { dataset: { sessionTreeId: 'chat-1' }, getBoundingClientRect: () => bounds, contains: node => node === row, querySelector: selector => selector.includes('title') ? { textContent: 'Recent benchmark 0001' } : {} }
    const list = { getBoundingClientRect: () => bounds, querySelectorAll: selector => selector === '.app-session-date-heading' ? [] : [row] }
    const makeViewport = () => ({ isConnected: true, getBoundingClientRect: () => bounds, querySelector: () => list, scrollTop: 0, scrollHeight: 400, clientHeight: 400 })
    let current = makeViewport(); const initial = current
    const context = { window: { devicePixelRatio: 1 }, document: { addEventListener: (name, handler) => handlers[name] = handler, querySelector: selector => selector.includes('content') ? current : list, querySelectorAll: () => [], elementFromPoint: () => row }, performance: { now: () => 10 }, PerformanceObserver: class { observe() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} }
    vm.runInNewContext(`(${installRecentProbe.toString()})({mode:'lean'})`, context)
    const probe = context.window.__recentRecovery
    assert.equal(probe.ready(), true); probe.arm()
    initial.isConnected = false; current = makeViewport()
    handlers.wheel({ target: { closest: () => current, className: 'session-list-item' }, timeStamp: 10, deltaY: 30, isTrusted: true })
    const result = probe.stop()
    assert.equal(result.wheels.length, 1)
    assert.equal(result.wheelTargetDiagnostics[0].sameElement, false)
    assert.equal(result.wheelTargetDiagnostics[0].previousConnected, false)
})
