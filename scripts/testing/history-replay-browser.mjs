#!/usr/bin/env node
/** Browser acceptance against history-replay-server.py; no production API. */
import { chromium } from '@playwright/test'
import fs from 'node:fs/promises'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
    url: { type: 'string', default: 'http://127.0.0.1:5310' },
    session: { type: 'string' }, output: { type: 'string' },
    pages: { type: 'string', default: '30' },
    browser: { type: 'string' }, width: { type: 'string', default: '390' },
} })
if (!values.session || !values.output) throw new Error('Provide --session and --output')
if (!['127.0.0.1', 'localhost'].includes(new URL(values.url).hostname)) throw new Error('Use the loopback replay server')
const browser = await chromium.launch({ executablePath: values.browser, headless: true })
const page = await browser.newPage({ viewport: { width: Number(values.width), height: 844 } })
const errors = [], pending = [], requests = [], observations = []
page.on('pageerror', error => errors.push(error.message))
await page.route('**/api/sessions/*/messages?*', async route => {
    const url = new URL(route.request().url())
    if (!url.searchParams.has('beforeSeq')) return route.continue()
    const response = await route.fetch()
    const body = await response.json()
    requests.push({ cursor: url.searchParams.get('beforeSeq'), rows: body.messages?.length, status: response.status() })
    await new Promise(resolve => pending.push(async () => { await route.fulfill({ response }); resolve() }))
})
try {
    await page.goto(`${values.url}/sessions/${values.session}`)
    const viewport = page.locator('.chat-scroll-y')
    await page.locator('[data-chat-node-key]').first().waitFor()
    await page.waitForTimeout(1000)
    const box = await viewport.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let round = 0; round < Number(values.pages); round++) {
        await page.mouse.wheel(0, -100000)
        for (let wait = 0; !pending.length && wait < 50; wait++) await page.waitForTimeout(100)
        if (!pending.length) break
        // Settle the reader while holding the response, then inspect every
        // animation frame of publication and virtual remeasurement.
        await page.waitForTimeout(350)
        const anchor = await viewport.evaluate(element => {
            const bounds = element.getBoundingClientRect()
            const padding = parseFloat(getComputedStyle(element).scrollPaddingTop) || 0
            const rows = [...element.querySelectorAll('[data-chat-node-key]')]
            const row = rows.find(row => {
                const rect = row.getBoundingClientRect()
                return rect.height > 0 && rect.bottom > bounds.top + padding && rect.top < bounds.bottom
            })
            const probe = { key: row?.dataset.chatNodeKey, frames: [], stop: false }
            window.__historyReplaySample = probe
            const frame = () => {
                if (probe.stop) return
                const mounted = [...element.querySelectorAll('[data-chat-node-key]')]
                const current = mounted.find(row => row.dataset.chatNodeKey === probe.key)
                probe.frames.push({
                    at: performance.now(), top: current ? current.getBoundingClientRect().top - element.getBoundingClientRect().top : null,
                    mounted: mounted.length, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight,
                })
                requestAnimationFrame(frame)
            }
            requestAnimationFrame(frame)
            return { key: probe.key, top: row?.getBoundingClientRect().top - bounds.top }
        })
        await pending.shift()()
        await page.waitForTimeout(800)
        const frames = await page.evaluate(() => {
            window.__historyReplaySample.stop = true
            return window.__historyReplaySample.frames
        })
        const lostFrames = frames.filter(frame => frame.top === null).length
        const drift = Math.max(0, ...frames.filter(frame => frame.top !== null).map(frame => Math.abs(frame.top - anchor.top)))
        observations.push({ round, anchor, lostFrames, drift, frames })
        console.log(JSON.stringify({ round, lostFrames, drift }))
    }
    // An empty run is useful for a short captured session, but does not count
    // as pagination acceptance. The report distinguishes it explicitly.
    const passed = observations.length > 0 && !errors.length && requests.every(request => request.status === 200)
        && observations.every(item => item.anchor.key && item.lostFrames === 0 && item.drift <= 1)
    await fs.writeFile(values.output, JSON.stringify({ passed, errors, requests, observations }), { mode: 0o600 })
    console.log(JSON.stringify({ passed, pages: observations.length, maxDrift: Math.max(0, ...observations.map(item => item.drift)) }))
    if (!passed) process.exitCode = 1
} finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await browser.close()
}
