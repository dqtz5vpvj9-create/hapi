#!/usr/bin/env node
/** Wheel/touch traversal of private real-history replay, including reversal. */
import { chromium } from '@playwright/test'
import fs from 'node:fs/promises'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
    url: { type: 'string', default: 'http://127.0.0.1:5310' },
    session: { type: 'string' }, output: { type: 'string' }, browser: { type: 'string' },
    gesture: { type: 'string', default: 'wheel' }, width: { type: 'string', default: '390' },
    pages: { type: 'string', default: '28' },
} })
if (!values.session || !values.output) throw new Error('Provide --session and --output')
if (!['127.0.0.1', 'localhost'].includes(new URL(values.url).hostname)) throw new Error('Use the loopback replay server')
if (!['wheel', 'touch'].includes(values.gesture)) throw new Error('--gesture must be wheel or touch')
const browser = await chromium.launch({ executablePath: values.browser, headless: true })
const context = await browser.newContext({ viewport: { width: Number(values.width), height: 844 }, hasTouch: values.gesture === 'touch' })
const page = await context.newPage()
const network = [], errors = []
let phase = 'open'
page.on('pageerror', error => errors.push(error.message))
page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.endsWith('/messages')) network.push({ phase, query: url.search })
})
try {
    await page.goto(`${values.url}/sessions/${values.session}`)
    await page.locator('[data-chat-node-key]').first().waitFor()
    await page.waitForTimeout(1500)
    await page.evaluate(() => {
        const viewport = document.querySelector('.chat-scroll-y')
        const probe = { frames: [], direction: 0, inputAt: 0, stopped: false }
        window.__historyMotion = probe
        let touchY = null, previous = new Map(), last = performance.now()
        const input = delta => { probe.direction = Math.sign(delta); probe.inputAt = performance.now() }
        viewport.addEventListener('wheel', event => input(event.deltaY), { passive: true })
        viewport.addEventListener('touchstart', event => { touchY = event.touches[0].clientY }, { passive: true })
        viewport.addEventListener('touchmove', event => {
            const next = event.touches[0].clientY
            if (touchY !== null) input(touchY - next)
            touchY = next
        }, { passive: true })
        function frame() {
            if (probe.stopped) return
            const now = performance.now(), bounds = viewport.getBoundingClientRect()
            const rows = [...viewport.querySelectorAll('[data-chat-node-key]')]
            const points = rows.map(row => {
                const rect = row.getBoundingClientRect()
                return { key: row.dataset.chatNodeKey, top: rect.top - bounds.top, bottom: rect.bottom - bounds.top }
            })
            const visible = points.filter(row => row.bottom > 0 && row.top < bounds.height)
            probe.frames.push({ at: now, dt: now - last, top: viewport.scrollTop, height: viewport.scrollHeight,
                direction: probe.direction, inputAge: now - probe.inputAt, mounted: rows.length, visible,
                deltas: visible.filter(row => previous.has(row.key)).map(row => row.top - previous.get(row.key)) })
            last = now; previous = new Map(points.map(row => [row.key, row.top]))
            requestAnimationFrame(frame)
        }
        requestAnimationFrame(frame)
    })
    const box = await page.locator('.chat-scroll-y').boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    const cdp = values.gesture === 'touch' ? await context.newCDPSession(page) : null
    for (const direction of [-1, 1]) {
        phase = direction < 0 ? 'up' : 'reverse'
        const count = cdp ? 55 : direction < 0 ? 220 : 130
        for (let i = 0; i < count; i++) {
            if (cdp) {
                const x = box.x + box.width / 2
                const start = box.y + box.height * (direction < 0 ? 0.15 : 0.85)
                const distance = box.height * 0.7
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] })
                for (let step = 1; step <= 8; step++) {
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start - direction * distance * step / 8 }] })
                    await page.waitForTimeout(16)
                }
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
                await page.waitForTimeout(80)
            } else {
                await page.mouse.wheel(0, direction * 450)
                await page.waitForTimeout(50)
            }
            if (direction < 0 && network.filter(request => request.query.includes('beforeSeq')).length >= Number(values.pages)) break
        }
        // Let preceding inertia finish before changing direction so attribution
        // does not classify the old gesture against the next one.
        await page.waitForTimeout(1200)
    }
    const frames = await page.evaluate(() => { window.__historyMotion.stopped = true; return window.__historyMotion.frames })
    const intervals = frames.map(frame => frame.dt).sort((a, b) => a - b)
    const conflicts = frames.flatMap((frame, index) => {
        const sorted = [...frame.deltas].sort((a, b) => a - b)
        const middle = Math.floor(sorted.length / 2)
        const delta = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
        return frame.inputAge < 500 && delta * frame.direction > 8 ? [{ index, at: frame.at, delta, direction: frame.direction }] : []
    })
    const summary = { gesture: values.gesture, errors, frames: frames.length,
        p95: intervals[Math.floor(intervals.length * 0.95)], max: intervals.at(-1),
        blank: frames.filter(frame => !frame.visible.length).length,
        maxMounted: Math.max(0, ...frames.map(frame => frame.mounted)), conflicts,
        requests: network.reduce((counts, request) => ({ ...counts, [request.phase]: (counts[request.phase] ?? 0) + 1 }), {}) }
    await fs.writeFile(values.output, JSON.stringify({ summary, network, frames }), { mode: 0o600 })
    console.log(JSON.stringify(summary))
    if (errors.length || summary.blank || conflicts.length) process.exitCode = 1
} finally {
    await browser.close()
}
