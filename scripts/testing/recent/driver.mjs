import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { installRecentProbe } from './probe.mjs'
const options = JSON.parse(process.argv[2])
const require = createRequire(path.join(options.sourceRoot, 'package.json'))
const { chromium } = require('@playwright/test')
const output = options.output
const write = (name, data) => fs.writeFile(path.join(output, name), JSON.stringify(data, null, 2))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const bounded = (promise, ms, name) => {
    let timer
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(name + ' timed out')), ms) })]).finally(() => clearTimeout(timer))
}
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) })
const context = await browser.newContext({ viewport: options.viewport === 'phone' ? { width: 390, height: 844 } : { width: 1600, height: 960 }, locale: 'en-US', timezoneId: 'UTC', deviceScaleFactor: 1, hasTouch: options.viewport === 'phone', isMobile: options.viewport === 'phone' })
const page = await context.newPage(), cdp = await context.newCDPSession(page)
page.setDefaultTimeout(8000)
const errors = [], consoleErrors = [], dispatch = []
page.on('pageerror', error => errors.push(String(error)))
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
await page.addInitScript(({ entry }) => { localStorage.setItem('hapi.sessionListView', entry === 'saved' ? 'recent' : 'directory'); document.addEventListener('DOMContentLoaded', () => { document.documentElement.lang = 'en' }, { once: true }) }, options)
await page.addInitScript(installRecentProbe, { mode: options.mode })
await cdp.send('Performance.enable')
if (options.cpu) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start') }
let cpuStopped = false
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(value => [value.name, value.value]))
try {
    const before = await metrics()
    await write('progress.json', { phase: 'navigation', at: new Date().toISOString(), options })
    await page.goto(options.url + '/e2e-fixtures/workspace-fixture.html?list&sessionCount=' + options.count, { waitUntil: 'domcontentloaded' })
    if (options.entry === 'ui') await page.locator('.app-session-list-views').getByRole('button', { name: 'Recent', exact: true }).click()
    await bounded(page.waitForFunction(() => window.__recentRecovery?.ready(), null, { timeout: 8000, polling: 'raf' }), 9000, 'correct first Recent viewport')
    const arm = await page.evaluate(() => window.__recentRecovery.arm())
    const hostStart = performance.now()
    await write('progress.json', { phase: 'input', at: new Date().toISOString(), arm })
    // Independent host timers preserve intended inputs even while renderer is busy.
    const promises = Array.from({ length: 60 }, (_, index) => (async () => {
        const scheduledMs = index * (1000 / 60)
        await pause(Math.max(0, hostStart + scheduledMs - performance.now()))
        const event = { index, scheduledMs, dispatchedMs: performance.now() - hostStart, deltaY: arm.viewportHeight * .1 * (index < 30 ? 1 : -1) }
        dispatch.push(event)
        try { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: arm.point.x, y: arm.point.y, deltaX: 0, deltaY: event.deltaY }); event.completedMs = performance.now() - hostStart } catch (error) { event.error = String(error) }
    })())
    await bounded(Promise.all(promises), 8000, 'input dispatch')
    await pause(1100)
    const observation = await bounded(page.evaluate(() => window.__recentRecovery.stop()), 3000, 'probe stop')
    const after = await metrics()
    if (options.cpu) { const result = await bounded(cdp.send('Profiler.stop'), 3000, 'CPU stop'); cpuStopped = true; await write('profile.cpuprofile', result.profile) }
    let afterGc = null, gcError = null
    try { await cdp.send('HeapProfiler.enable'); await cdp.send('HeapProfiler.collectGarbage'); afterGc = await metrics() } catch (error) { gcError = String(error) }
    const start = observation.firstWheelAt, end = start === null ? null : start + 1000
    const frames = observation.frames.filter(at => start !== null && at >= start && at <= end)
    const gaps = frames.slice(1).map((at, index) => at - frames[index])
    const tasks = observation.longTasks.filter(task => start !== null && task.at < end && task.at + task.duration > start)
    const immediate = observation.snapshots.filter(sample => start !== null && sample.at >= start && sample.at <= end)
    const proxy = observation.wheels.map(wheel => { const next = observation.frames.find(at => at >= wheel.at); return next == null ? null : next - wheel.at }).filter(value => value !== null)
    const sum = values => values.reduce((a, b) => a + b, 0)
    const summary = { options, errors, consoleErrors, initial: observation.initial, final: observation.final,
        entryToCorrectMs: observation.entryAt == null ? null : observation.readyAt - observation.entryAt,
        readyToFirstWheelMs: start === null ? null : start - observation.readyAt, armedAt: arm.armedAt, wheelTargetDiagnostics: observation.wheelTargetDiagnostics, outsideWheelCount: observation.outsideWheelCount,
        maxRafGapMs: gaps.length ? Math.max(...gaps) : null, longTasksFirstSecond: tasks,
        inputToNextRafProxyMs: { count: proxy.length, maximum: proxy.length ? Math.max(...proxy) : null },
        firstSecondCorrectness: options.mode === 'full' ? { samples: immediate.length, incorrect: immediate.filter(sample => !sample.correct).length, unobservableHits: sum(immediate.map(sample => sample.rows.filter(row => row.hit === 'unobservable').length)) } : null,
        probeWorkFirstSecondMs: sum(immediate.map(sample => sample.workMs)),
        input: { scheduledCount: dispatch.length, lastHostDispatchMs: Math.max(...dispatch.map(event => event.dispatchedMs)), deliveredCount: observation.wheels.length, deliveredFirstSecond: observation.wheels.filter(event => event.at <= end).length,
            requestedSigned: sum(dispatch.map(event => event.deltaY)), deliveredSigned: sum(observation.wheels.map(event => event.deltaY)), requestedAbsolute: sum(dispatch.map(event => Math.abs(event.deltaY))), deliveredAbsolute: sum(observation.wheels.map(event => Math.abs(event.deltaY))), allTrusted: observation.wheels.length > 0 && observation.wheels.every(event => event.trusted), observedDown: observation.wheels.some(event => event.deltaY > 0), observedUp: observation.wheels.some(event => event.deltaY < 0) },
        heap: { before: before.JSHeapUsedSize, after: after.JSHeapUsedSize, delta: after.JSHeapUsedSize - before.JSHeapUsedSize, afterGc: afterGc?.JSHeapUsedSize ?? null, gcError, scope: 'CDP page JS heap; includes fixture; post-GC captured outside timed input and CPU interval; not total process memory' },
        boundary: { startsAtTop: observation.initial.scrollTop <= 1, finalAtTop: observation.final.scrollTop <= 1, initialRange: observation.initial.maxScrollTop, desiredOneWayDistance: arm.viewportHeight * 3 },
        limits: ['One synthetic local Chromium trial; phone is desktop mobile emulation with trusted wheel, not physical touch', 'RAF and event callbacks are scheduling proxies, not pixel presentation timestamps', 'Full correctness probe reads geometry; lean run does not establish per-frame content correctness', 'Opposite-direction wheel coalescing can reduce absolute delta without input loss'] }
    await write('observation.json', { observation, dispatch, metrics: { before, after, afterGc } })
    await write('summary.json', summary)
    await page.screenshot({ path: path.join(output, 'end.png'), timeout: 3000 })
    const inputObserved = observation.wheels.some(event => event.deltaY > 0) && observation.wheels.some(event => event.deltaY < 0)
    const failure = !inputObserved || !observation.initial.correct || !observation.final.correct || (options.mode === 'full' && immediate.some(sample => !sample.correct)) || errors.length
    await write('result.json', { status: !inputObserved ? 'missing-recorded-input' : failure ? 'correctness-failed' : 'completed', code: failure ? 1 : 0 })
    process.exitCode = failure ? 1 : 0
} catch (error) {
    await write('failure.json', { error: String(error), stack: error.stack, errors, consoleErrors, dispatch })
    try { await write('failure-state.json', await bounded(page.evaluate(() => ({ probe: window.__recentRecovery?.peek(), text: document.body?.innerText?.slice(0, 5000) })), 2000, 'failure state')) } catch (captureError) { await write('failure-state-error.json', { error: String(captureError) }) }
    try { await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 2000 }) } catch {}
    if (options.cpu && !cpuStopped) try { const result = await bounded(cdp.send('Profiler.stop'), 2000, 'failure CPU stop'); await write('profile.cpuprofile', result.profile) } catch {}
    await write('result.json', { status: 'failed', code: 1 })
    process.exitCode = 1
} finally { await write('page-errors.json', { errors, consoleErrors }); await browser.close() }
