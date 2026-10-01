import { expect, test } from '@playwright/test'

async function openHistory(page: import('@playwright/test').Page, query = '') {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/e2e-fixtures/history-load-fixture.html?${query}`)
    await expect(page.getByText('Fixture message 1200', { exact: true })).toBeInViewport()
    await page.waitForTimeout(2000)
    const box = (await page.locator('.chat-scroll-y').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

test('approaching the older boundary warms one page without publishing it and reuses it at the edge', async ({ page }) => {
    await openHistory(page)
    await page.evaluate(() => window.__probe.holdBefore())
    // Follow the measured viewport toward the boundary; a fixed total delta
    // can stop outside the warm-up zone when virtual row estimates settle.
    for (let input = 0; input < 24; input++) {
        await page.mouse.wheel(0, -700)
        await page.waitForTimeout(80)
        if (await page.evaluate(() => window.__probe.requests.some(r => r.direction === 'before'))) break
    }
    await expect.poll(() => page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'before').length)).toBe(1)
    expect(await page.evaluate(() => window.__probe.windowState())).toMatchObject({ messageCount: 200, oldestSeq: 1001, isLoadingMore: false })
    const before = await page.evaluate(() => window.__probe.finishedRequests)
    await page.evaluate(() => window.__probe.releaseBefore())
    await expect.poll(() => page.evaluate(() => window.__probe.finishedRequests)).toBeGreaterThan(before)
    expect(await page.evaluate(() => window.__probe.windowState().oldestSeq)).toBe(1001)
    const remaining = await page.locator('.chat-scroll-y').evaluate(e => e.scrollTop)
    await page.mouse.wheel(0, -remaining - 20)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().oldestSeq)).toBe(801)
    expect(await page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'before' && r.beforeSeq === 1001).length)).toBe(1)
    expect(await page.locator('[data-hapi-virtual-message]').count()).toBeLessThanOrEqual(40)
    await page.waitForTimeout(400)
    const settled = await page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'before').length)
    expect(settled).toBeLessThanOrEqual(2)
    await page.waitForTimeout(1200)
    expect(await page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'before').length)).toBe(settled)
})

test('continuous native wheel reading crosses five boundaries with bounded DOM and stops fetching when idle', async ({ page }) => {
    test.setTimeout(45_000)
    await openHistory(page, 'slowBefore=1')
    const frontiers = new Set<number>()
    let blankFrames = 0
    for (let input = 0; input < 220; input++) {
        await page.mouse.wheel(0, -1000)
        await page.waitForTimeout(40)
        const sample = await page.evaluate(() => {
            const viewport = document.querySelector('.chat-scroll-y')!.getBoundingClientRect()
            const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-hapi-virtual-message]'))
            return { state: window.__probe.windowState(), mounted: rows.length,
                visible: rows.some(row => { const r = row.getBoundingClientRect(); return r.bottom > viewport.top && r.top < viewport.bottom }) }
        })
        if (sample.state.oldestSeq !== null) frontiers.add(sample.state.oldestSeq)
        if (!sample.visible) blankFrames++
        expect(sample.state.messageCount).toBeLessThanOrEqual(800)
        expect(sample.mounted).toBeLessThanOrEqual(40)
        if (sample.state.oldestSeq === 1) break
    }
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().oldestSeq)).toBe(1)
    for (const frontier of [1001, 801, 601, 401, 201, 1]) expect(frontiers.has(frontier)).toBe(true)
    expect(blankFrames).toBe(0)
    await page.waitForTimeout(700)
    const before = await page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'before').length)
    await page.waitForTimeout(1300)
    expect(await page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'before').length)).toBe(before)
})

test('reverse reading reuses the covered pages and keeps the explicitly chosen history mode', async ({ page }) => {
    test.setTimeout(45_000)
    await openHistory(page)
    for (let input = 0; input < 220; input++) {
        await page.mouse.wheel(0, -1000)
        await page.waitForTimeout(30)
        if (await page.evaluate(() => window.__probe.windowState().oldestSeq === 1)) break
    }
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().oldestSeq)).toBe(1)
    const previous = await page.evaluate(() => window.__probe.requests.length)
    for (let input = 0; input < 140; input++) {
        await page.mouse.wheel(0, 1000)
        await page.waitForTimeout(30)
        const newest = await page.evaluate(() => window.__probe.windowState().newestSeq)
        if (newest === 1000) break
    }
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().newestSeq)).toBeGreaterThanOrEqual(1000)
    expect(await page.evaluate(() => window.__probe.requests.length)).toBe(previous)
    expect(await page.evaluate(() => window.__probe.windowState().viewMode)).toBe('history')
    expect(await page.locator('[data-hapi-virtual-message]').count()).toBeLessThanOrEqual(40)
})

test('a native touch gesture can approach a warm boundary without changing the reader prematurely', async ({ page }) => {
    await openHistory(page)
    const client = await page.context().newCDPSession(page)
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
    // Establish a reading position without issuing an input-driven warm-up;
    // the following touch movement must be what starts the page request.
    await page.locator('.chat-scroll-y').evaluate(e => { e.scrollTop = 4000 })
    await page.waitForTimeout(400)
    expect(await page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'before').length)).toBe(0)
    for (let gesture = 0; gesture < 6; gesture++) {
        await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 100, id: 1 }] })
        for (let y = 150; y <= 700; y += 50) {
            await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y, id: 1 }] })
            await page.waitForTimeout(16)
        }
        await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await page.waitForTimeout(50)
        if (await page.evaluate(() => window.__probe.requests.some(r => r.direction === 'before'))) break
    }
    await expect.poll(() => page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'before').length)).toBe(1)
    expect(await page.evaluate(() => window.__probe.windowState().oldestSeq)).toBe(1001)
    await page.waitForTimeout(700)
    const count = await page.evaluate(() => window.__probe.requests.length)
    await page.waitForTimeout(1000)
    expect(await page.evaluate(() => window.__probe.requests.length)).toBe(count)
    await client.detach()
})
