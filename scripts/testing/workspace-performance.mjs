#!/usr/bin/env node
/** Fixed-workload browser measurements. Uses the real App with the local Hub fixture. */
import { chromium } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
    url: { type: 'string', default: 'http://127.0.0.1:5189' },
    'compare-url': { type: 'string' },
    output: { type: 'string' }, browser: { type: 'string' },
    runs: { type: 'string', default: '5' }, cases: { type: 'string', default: 'single,1,2,4' },
    profile: { type: 'boolean', default: false },
} })
if (!values.output) throw new Error('Provide --output on the cache disk')
if (!['127.0.0.1', 'localhost'].includes(new URL(values.url).hostname)) throw new Error('Use a loopback fixture server')
if (values['compare-url'] && !['127.0.0.1', 'localhost'].includes(new URL(values['compare-url']).hostname)) throw new Error('Use a loopback comparison server')
const variants = values['compare-url'] ? [
    { name: 'reference', url: values.url }, { name: 'candidate', url: values['compare-url'] },
] : [{ name: '', url: values.url }]
const cases = values.cases.split(',')
if (cases.some(value => !['single', '1', '2', '4'].includes(value))) throw new Error('Cases: single,1,2,4')
const runs = Number(values.runs)
await fs.mkdir(values.output, { recursive: true })
// Chromium's Unix socket also uses TMPDIR; keep it below the socket path limit.
process.env.TMPDIR = '/mnt/cache/data-cache'
const browser = await chromium.launch({ executablePath: values.browser, headless: true })
const samples = []
const percentile = (items, fraction) => items.length ? [...items].sort((a, b) => a - b)[Math.ceil(items.length * fraction) - 1] : 0

async function runScenario(kind, round, variant) {
    const count = kind === 'single' ? 1 : Number(kind)
    const context = await browser.newContext({ viewport: { width: 1600, height: 960 } })
    const page = await context.newPage()
    const client = await context.newCDPSession(page)
    await client.send('Performance.enable')
    let transferredBytes = 0
    await client.send('Network.enable')
    client.on('Network.loadingFinished', event => { transferredBytes += event.encodedDataLength })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(expected => {
        const state = { frames: [], longTasks: [], readyAt: null }
        window.__workspacePerformance = state
        new PerformanceObserver(list => {
            for (const item of list.getEntries()) state.longTasks.push({ start: item.startTime, duration: item.duration })
        }).observe({ type: 'longtask', buffered: true })
        const frame = timestamp => {
            state.frames.push(timestamp)
            if (state.readyAt === null && [...document.querySelectorAll('[data-chat-presented=true]')].filter(e => e.getClientRects().length).length === expected) state.readyAt = performance.now()
            requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
    }, count)
    const metrics = async () => Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
    const ready = () => page.waitForFunction(expected => document.querySelectorAll('[data-chat-presented=true]').length === expected, count, { timeout: 30000 })
    const prefix = async key => { await page.keyboard.press('Control+b'); await page.keyboard.press(key) }
    let previous = await metrics()
    let start = 0
    let bytes = 0
    let apiBytes = 0
    const phases = {}
    const capture = async name => {
        const after = await metrics()
        const timing = await page.evaluate(from => {
            const state = window.__workspacePerformance, end = performance.now()
            const frames = state.frames.filter(t => t >= from && t <= end)
            return {
                start: from, end, readyAt: state.readyAt,
                frames: frames.slice(1).map((t, i) => t - frames[i]),
                tasks: state.longTasks.filter(t => t.start >= from && t.start <= end),
                dom: document.querySelectorAll('*').length,
                mountedMessages: document.querySelectorAll('[data-chat-node-key]').length,
                apiBytes: window.__workspaceFixture.responseBytes,
                requests: [...window.__workspaceFixture.requests],
            }
        }, start)
        const timeFields = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration']
        const cpu = Object.fromEntries(timeFields.map(field => [field + 'Ms', (after[field] - previous[field]) * 1000]))
        const result = {
            durationMs: timing.end - timing.start, ...cpu,
            frameP50Ms: percentile(timing.frames, 0.5), frameP95Ms: percentile(timing.frames, 0.95),
            frameMaxMs: Math.max(0, ...timing.frames), framesOver50Ms: timing.frames.filter(n => n > 50).length,
            longTasks: timing.tasks.length, longTaskMs: timing.tasks.reduce((sum, task) => sum + task.duration, 0),
            jsHeapBytes: after.JSHeapUsedSize, domNodes: timing.dom, cdpNodes: after.Nodes, mountedMessages: timing.mountedMessages,
            transferredBytes: transferredBytes - bytes, fixtureResponseBytes: timing.apiBytes - apiBytes,
        }
        if (name === 'startup') result.readyAtMs = timing.readyAt
        phases[name] = result
        previous = after; start = timing.end; bytes = transferredBytes; apiBytes = timing.apiBytes
        return timing
    }
    const reset = async () => {
        previous = await metrics()
        const sample = await page.evaluate(() => ({ now: performance.now(), bytes: window.__workspaceFixture.responseBytes }))
        start = sample.now; bytes = transferredBytes; apiBytes = sample.bytes
    }
    try {
        if (values.profile) {
            await client.send('Profiler.enable')
            await client.send('Profiler.start')
        }
        const query = kind === 'single' ? '?single' : `?panes=${count}`
        await page.goto(`${variant.url}/e2e-fixtures/workspace-fixture.html${query}`, { waitUntil: 'domcontentloaded' })
        await ready()
        await page.waitForFunction(() => window.__workspacePerformance.readyAt !== null)
        await capture('startup')
        if (values.profile) {
            const { profile } = await client.send('Profiler.stop')
            await fs.writeFile(path.join(values.output, `${variant.name || 'sample'}-${kind}-${round}.cpuprofile`), JSON.stringify(profile))
        }
        await page.waitForTimeout(2000)
        await capture('idle')
        if (values.profile) await client.send('Profiler.start')
        await page.evaluate(async visible => {
            for (let tick = 0; tick < 20; tick++) {
                for (let id = 1; id <= visible; id++) window.__workspaceFixture.append(`chat-${id}`)
                await new Promise(resolve => setTimeout(resolve, 100))
            }
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        }, count)
        await capture('stream')
        if (values.profile) {
            const { profile } = await client.send('Profiler.stop')
            await fs.writeFile(path.join(values.output, `${variant.name || 'sample'}-${kind}-${round}-stream.cpuprofile`), JSON.stringify(profile))
        }
        const viewport = page.locator('.chat-scroll-y').first()
        await viewport.hover()
        await reset()
        for (let tick = 0; tick < 8; tick++) {
            await page.mouse.wheel(0, -260)
            await page.waitForTimeout(100)
        }
        await page.waitForTimeout(400)
        await capture('scroll')
        if (kind === 'single') {
            const sidebar = page.locator('.app-session-sidebar-frame')
            await sidebar.getByText('Windows 终端集成', { exact: true }).click()
            await page.getByText('chat-2 · 记录 320', { exact: true }).waitFor()
            await reset()
            await sidebar.getByText('历史阅读优化', { exact: true }).click()
        } else {
            await prefix('c')
            await page.getByRole('dialog').getByRole('button', { name: 'New workspace', exact: true }).click()
            await page.locator('.workspace-empty').waitFor()
            await reset()
            await prefix('p')
        }
        await ready()
        await page.waitForFunction(() => !!document.querySelector('[data-chat-node-key*="chat-1-"]'))
        await capture('restore')
        await client.send('HeapProfiler.collectGarbage')
        const retainedHeapBytes = (await metrics()).JSHeapUsedSize
        const fixture = await page.evaluate(() => ({ requests: window.__workspaceFixture.requests, unhandled: window.__workspaceFixture.unhandled, sends: window.__workspaceFixture.sends }))
        if (fixture.unhandled.length || fixture.sends.length || errors.length) throw new Error(JSON.stringify({ errors, unhandled: fixture.unhandled, sends: fixture.sends.length }))
        return { kind, round, variant: variant.name, passed: true, phases, retainedHeapBytes, requests: fixture.requests }
    } catch (error) {
        return { kind, round, variant: variant.name, passed: false, phases, errors, error: String(error) }
    } finally { await context.close() }
}

try {
    for (let round = 1; round <= runs; round++) {
        // Rotate order to avoid giving every first run to the same condition.
        const offset = (round - 1) % cases.length
        for (const kind of [...cases.slice(offset), ...cases.slice(0, offset)]) {
            for (const variant of round % 2 ? variants : [...variants].reverse()) {
                const sample = await runScenario(kind, round, variant)
                samples.push(sample)
                await fs.writeFile(path.join(values.output, `${variant.name ? variant.name + '-' : ''}${kind}-${round}.json`), JSON.stringify(sample, null, 2))
                console.log(JSON.stringify({ kind, round, variant: variant.name, passed: sample.passed, readyMs: sample.phases.startup?.readyAtMs, error: sample.error }))
            }
        }
    }
    const summary = {}
    for (const variant of variants) for (const kind of cases) {
        const matching = samples.filter(row => row.kind === kind && row.variant === variant.name)
        const rows = matching.filter(row => row.passed)
        const phases = {}
        for (const phase of ['startup', 'idle', 'stream', 'scroll', 'restore']) {
            phases[phase] = {}
            for (const key of Object.keys(rows[0]?.phases[phase] ?? {})) {
                const items = rows.map(row => row.phases[phase][key])
                phases[phase][key] = { median: percentile(items, 0.5), min: Math.min(...items), max: Math.max(...items) }
            }
        }
        const heap = rows.map(row => row.retainedHeapBytes)
        summary[variant.name ? variant.name + '/' + kind : kind] = {
            passed: rows.length, failed: matching.filter(row => !row.passed).length, phases,
            retainedHeapBytes: heap.length ? { median: percentile(heap, 0.5), min: Math.min(...heap), max: Math.max(...heap) } : null,
        }
    }
    await fs.writeFile(path.join(values.output, 'summary.json'), JSON.stringify({ browser: await browser.version(), runs, viewport: '1600x960', summary }, null, 2))
    if (samples.some(sample => !sample.passed)) process.exitCode = 1
} finally { await browser.close() }
