import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
const options = JSON.parse(process.argv[2]), require = createRequire(path.join(options.sourceRoot, 'package.json'))
const { chromium } = require('@playwright/test')
const write = (file, data) => fs.writeFile(path.join(options.output, file), JSON.stringify(data, null, 2))
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROME_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'] } : {}) })
const context = await browser.newContext({ viewport: options.viewport === 'phone' ? { width: 390, height: 844 } : { width: 1600, height: 960 }, locale: 'en-US', timezoneId: 'UTC', isMobile: options.viewport === 'phone', hasTouch: options.viewport === 'phone' })
const page = await context.newPage(), errors = [], checkpoints = []
page.setDefaultTimeout(8000)
page.on('pageerror', error => errors.push(String(error)))
await page.addInitScript(() => { localStorage.setItem('hapi.sessionListView', 'recent'); document.addEventListener('DOMContentLoaded', () => { document.documentElement.lang = 'en' }, { once: true }) })
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
const capture = () => page.evaluate(() => {
    const viewport = document.querySelector('.app-session-list-content'), bounds = viewport.getBoundingClientRect()
    const all = [...document.querySelectorAll('[data-testid="recent-session-list"] [data-session-tree-id]')]
    const rows = all.map(element => { const r = element.getBoundingClientRect(); return { id: element.dataset.sessionTreeId, title: element.querySelector('.app-session-row-title')?.textContent, top: r.top - bounds.top, bottom: r.bottom - bounds.top } }).filter(row => row.bottom > 0 && row.top < bounds.height)
    return { scrollTop: viewport.scrollTop, height: bounds.height, mounted: all.length, logicalTotal: Number(document.querySelector('[data-testid="recent-session-list"]').getAttribute('data-recent-total')) || all.length, firstMountedId: all[0]?.dataset.sessionTreeId, rows }
})
const compare = (before, after, name) => {
    const anchor = before.rows[0], next = after.rows.find(row => row.id === anchor.id)
    const value = { name, before, after, anchorId: anchor.id, delta: next ? next.top - anchor.top : null }
    checkpoints.push(value)
    if (!next || Math.abs(value.delta) > 2 || next.title !== anchor.title) throw new Error(name + ': anchor changed ' + JSON.stringify({ anchor, next, delta: value.delta }))
}
try {
    await page.goto(options.url + '/e2e-fixtures/workspace-fixture.html?list&sessionCount=' + options.count, { waitUntil: 'domcontentloaded' })
    const viewport = page.locator('.app-session-list-content')
    await page.locator('[data-testid="recent-session-list"] [data-session-tree-id]').first().waitFor()
    const box = await viewport.boundingBox()
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .4)
    await page.mouse.wheel(0, 1400)
    await page.waitForFunction(() => document.querySelector('.app-session-list-content').scrollTop > 1000)
    await settle()
    const before = await capture(), updatedVisible = before.rows.at(-2).id
    await page.evaluate(({ count, visible }) => { window.__workspaceFixture.updateRecent('chat-' + count, Date.UTC(2026, 9, 12)); window.__workspaceFixture.updateRecent(visible, Date.UTC(2026, 9, 13)) }, { count: options.count, visible: updatedVisible })
    await settle(); const afterSse = await capture(); compare(before, afterSse, 'existing timestamp SSE keeps frozen recency')
    await page.evaluate(count => window.__workspaceFixture.insertRecent('chat-' + (count + 1), Date.UTC(2026, 9, 14)), options.count)
    await page.waitForFunction(count => {
        const list = document.querySelector('[data-testid="recent-session-list"]')
        const total = Number(list?.getAttribute('data-recent-total')) || list?.querySelectorAll('[data-session-tree-id]').length
        const first = list?.querySelector('[data-session-tree-id]')?.getAttribute('data-session-tree-id')
        return total === count + 1 && first === 'chat-' + (count + 1)
    }, options.count)
    await settle(); const afterInsert = await capture(); compare(afterSse, afterInsert, 'new top root compensation')
    await write('checkpoints.json', { checkpoints, errors, updatedVisible })
    // This separate functional case isolates live SSE and structural insertion (not explicit refresh).
    // Explicit refresh has its own preserved strict baseline/candidate case.
    const afterRefresh = afterInsert
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .4)
    await page.mouse.wheel(0, 350); await settle(); const down = await capture()
    await page.mouse.wheel(0, -350); await settle(); const up = await capture()
    checkpoints.push({ name: 'trusted wheel down and reverse', down, up })
    if (!down.rows.length || !up.rows.length || down.scrollTop <= afterRefresh.scrollTop || up.scrollTop >= down.scrollTop) throw new Error('Post-SSE wheel direction or visible rows failed')
    await write('checkpoints.json', { checkpoints, errors, updatedVisible })
    await page.screenshot({ path: path.join(options.output, 'end.png') })
    await write('result.json', { status: errors.length ? 'failed' : 'completed', code: errors.length ? 1 : 0, scope: 'Functional real-route trusted wheel, synthetic SSE, exact anchor within2px; no timing claim' })
    process.exitCode = errors.length ? 1 : 0
} catch (error) {
    await write('failure.json', { error: String(error), stack: error.stack, checkpoints, errors })
    try { await write('failure-state.json', await capture()); await page.screenshot({ path: path.join(options.output, 'failure.png'), timeout: 2000 }) } catch {}
    process.exitCode = 1
} finally { await browser.close() }
