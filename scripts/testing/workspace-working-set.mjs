#!/usr/bin/env node
/** Measure code readers after exceeding presentation/page caches. */
import { chromium } from '@playwright/test'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
    url: { type: 'string', default: 'http://127.0.0.1:5192' },
    output: { type: 'string' }, browser: { type: 'string' },
    runs: { type: 'string', default: '3' }, cycles: { type: 'string', default: '5' },
    sessions: { type: 'string', default: '12' },
    'heap-snapshots': { type: 'boolean', default: false },
} })
if (!values.output) throw new Error('Provide --output on the cache disk')
if (!['127.0.0.1', 'localhost'].includes(new URL(values.url).hostname)) throw new Error('Use a loopback fixture server')
const runs = Number(values.runs), cycles = Number(values.cycles), sessions = Number(values.sessions)
if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(cycles) || cycles < 2 || !Number.isInteger(sessions) || sessions < 4) throw new Error('Positive runs, at least two cycles and four sessions are required')
await fs.mkdir(values.output, { recursive: true })
process.env.TMPDIR = '/mnt/cache/data-cache'
const browser = await chromium.launch({ executablePath: values.browser, headless: true })
const samples = []
const percentile = (items, fraction) => [...items].sort((a, b) => a - b)[Math.ceil(items.length * fraction) - 1]

async function runScenario(run) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 960 } })
    const page = await context.newPage()
    const client = await context.newCDPSession(page)
    await client.send('Performance.enable')
    page.setDefaultTimeout(30000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const sample = { run, visits: [], cycles: [], errors, passed: false }
    const readers = new Map()
    const pane = id => page.locator(`[data-pane-id][data-session-id="chat-${id}"]`)
    const viewport = id => pane(id).locator('.chat-scroll-y')
    const editor = id => pane(id).locator('[contenteditable]:not([contenteditable="false"])')
    const ready = async id => {
        const handle = await page.waitForFunction(id => Boolean(document.querySelector(`[data-session-id="chat-${id}"] [data-chat-presented=true]`)), id)
        await handle.dispose()
    }
    const measureHeap = async (cycle, visited) => {
        // Collection is outside visit timing. It removes garbage, not live caches.
        await client.send('HeapProfiler.collectGarbage')
        const metrics = Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]))
        const view = await page.evaluate(() => ({
            domNodes: document.querySelectorAll('*').length,
            mountedMessages: document.querySelectorAll('[data-chat-node-key]').length,
            codeLines: document.querySelectorAll('.cm-line').length,
            panes: document.querySelectorAll('[data-pane-id]').length,
            residentWorkspaces: document.querySelectorAll('.workspace-stage').length,
            requests: window.__workspaceFixture.requests.length,
            fixtureResponseBytes: window.__workspaceFixture.responseBytes,
            messageWindows: window.__workspaceFixture.messageWindows(),
            bodyCacheBytes: Object.entries(sessionStorage).filter(([key]) => key.startsWith('hapi:message-window:v2:')).reduce((sum, [, body]) => sum + body.length * 2, 0),
        }))
        sample.cycles.push({ cycle, visited, retainedHeapBytes: metrics.JSHeapUsedSize, cdpNodes: metrics.Nodes, ...view })
        console.log(JSON.stringify({ run, ...sample.cycles.at(-1) }))
        if (values['heap-snapshots'] && (cycle === 0 || cycle === 1 || cycle === cycles - 1)) {
            const stream = createWriteStream(path.join(values.output, `run-${run}-cycle-${cycle}.heapsnapshot`))
            const chunk = ({ chunk }) => stream.write(chunk)
            client.on('HeapProfiler.addHeapSnapshotChunk', chunk)
            await client.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
            client.off('HeapProfiler.addHeapSnapshotChunk', chunk)
            await new Promise((resolve, reject) => { stream.on('error', reject); stream.end(resolve) })
        }
    }
    try {
        await page.goto(`${values.url}/e2e-fixtures/workspace-fixture.html?panes=1&workingSet=${sessions}&rich`, { waitUntil: 'domcontentloaded' })
        await ready(1)
        await measureHeap(-1)
        for (let cycle = 0; cycle < cycles; cycle++) {
            for (let id = 1; id <= sessions; id++) {
                // Timestamp the actual DOM click, excluding Playwright actionability/scroll.
                const button = page.locator(`.workspace-tabs button[title="Workspace ${id}"]`)
                await button.evaluate((element, id) => element.addEventListener('click', () => {
                    window.__workingSetStart = performance.now()
                    window.__workingSetFirstFrame = null
                    requestAnimationFrame(() => {
                        const root = document.querySelector(`[data-workspace-visible=true] [data-session-id="chat-${id}"]`)
                        window.__workingSetFirstFrame = {
                            ready: !!root?.querySelector('[data-chat-presented=true]'),
                            skeleton: !!root?.querySelector('[data-chat-opening]'),
                            ms: performance.now() - window.__workingSetStart,
                        }
                    })
                }, { once: true }), id)
                await button.click()
                await ready(id)
                if (cycle === 0) {
                    await pane(id).locator('[data-hapi-large-code] .cm-editor').waitFor()
                    await editor(id).fill(`Working-set draft ${id}`)
                    await viewport(id).evaluate((element, distance) => {
                        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
                        element.scrollTop -= distance
                        element.dispatchEvent(new Event('scroll'))
                    }, 13000 + ((id - 1) % 12 + 1) * 400)
                    const handle = await page.waitForFunction(id => Boolean(window.__workspaceFixture.captureReading(`chat-${id}`)?.code), id)
                    await handle.dispose()
                    await viewport(id).evaluate(element => element.dispatchEvent(new Event('scrollend')))
                    const anchor = await page.evaluate(id => window.__workspaceFixture.captureReading(`chat-${id}`), id)
                    const top = await page.evaluate(({ id, anchor }) => window.__workspaceFixture.codePoint(`chat-${id}`, anchor), { id, anchor })
                    if (top === null || anchor.code.position < 20000) throw new Error(`No deep source position for chat-${id}`)
                    readers.set(id, { anchor, top })
                } else {
                    const reader = readers.get(id)
                    const handle = await page.waitForFunction(async ({ id, anchor, top }) => {
                        const point = await window.__workspaceFixture.codePoint(`chat-${id}`, anchor)
                        if (point === null || Math.abs(point - top) > 2) return false
                        return { durationMs: performance.now() - window.__workingSetStart, driftPx: point - top }
                    }, { id, ...reader }, { polling: 'raf' })
                    const timing = await handle.jsonValue()
                    await handle.dispose()
                    if (await editor(id).innerText() !== `Working-set draft ${id}`) throw new Error(`Lost draft for chat-${id}`)
                    sample.visits.push({ cycle, id, ...timing, firstFrame: await page.evaluate(() => window.__workingSetFirstFrame) })
                }
                if (await page.locator('[data-pane-id]:visible').count() !== 1) throw new Error('A hidden workspace is visible')
                if (await page.locator('[data-pane-id]').count() > 5) throw new Error('Single-pane resident working set exceeded five views')
                if (cycle === 0 && id % 12 === 0 && id < sessions) await measureHeap(cycle, id)
            }
            await measureHeap(cycle, sessions)
            await fs.writeFile(path.join(values.output, `run-${run}.json`), JSON.stringify(sample, null, 2))
        }
        const fixture = await page.evaluate(() => ({ sends: window.__workspaceFixture.sends, unhandled: window.__workspaceFixture.unhandled }))
        if (fixture.sends.length || fixture.unhandled.length || errors.length) throw new Error(JSON.stringify(fixture))
        sample.passed = true
    } catch (error) {
        sample.error = String(error)
        sample.failure = await page.evaluate(() => ({
            readers: Object.entries(sessionStorage).filter(([key]) => key.startsWith('hapi:message-reader:')),
            pane: [...document.querySelectorAll('[data-pane-id]')].map(element => ({ id: element.getAttribute('data-session-id'), presented: Boolean(element.querySelector('[data-chat-presented=true]')) })),
        })).catch(() => null)
    } finally {
        await client.detach()
        await context.close()
    }
    return sample
}

try {
    for (let run = 1; run <= runs; run++) {
        const sample = await runScenario(run)
        samples.push(sample)
        await fs.writeFile(path.join(values.output, `run-${run}.json`), JSON.stringify(sample, null, 2))
        console.log(JSON.stringify({ run, passed: sample.passed, visits: sample.visits.length, error: sample.error }))
    }
    const visits = samples.flatMap(sample => sample.visits)
    const summary = {
        browser: await browser.version(), viewport: '1600x960', runs, cycles, sessions,
        passed: samples.filter(sample => sample.passed).length, failed: samples.filter(sample => !sample.passed).length,
        measuredRestores: visits.length,
        restoreMs: visits.length ? { p50: percentile(visits.map(v => v.durationMs), 0.5), p95: percentile(visits.map(v => v.durationMs), 0.95), max: Math.max(...visits.map(v => v.durationMs)) } : null,
        maxDriftPx: visits.length ? Math.max(...visits.map(v => Math.abs(v.driftPx))) : null,
        firstFrameReady: visits.filter(v => v.firstFrame?.ready).length,
        firstFrameSkeleton: visits.filter(v => v.firstFrame?.skeleton).length,
        heap: samples.map(sample => ({ run: sample.run, cycles: sample.cycles })),
        limitations: `Controlled Chromium fixture; ${sessions} fixed 320-row histories live in the browser mock server. Each last answer has 1500 TypeScript lines. Heap includes that fixed mock cost. Timings begin at DOM click and end when the original source character is within 2 CSS px; Playwright/CDP polling overhead is included. Full GC runs after every 12 first visits and each complete revisit cycle. Not physical-device, network, browser RSS, or model performance.`,
    }
    await fs.writeFile(path.join(values.output, 'summary.json'), JSON.stringify(summary, null, 2))
    if (summary.failed) process.exitCode = 1
} finally { await browser.close() }
