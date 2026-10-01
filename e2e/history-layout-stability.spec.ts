import { expect, test } from '@playwright/test'

test('keeps mounted history readable after its layout is hidden during a live update', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => {
        if (message.type() === 'error') errors.push(message.text())
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/e2e-fixtures/history-load-fixture.html?readingAnchor=1')
    await expect(page.getByText(/^Anchor paragraph 090:/)).toBeVisible()
    await page.waitForTimeout(2000)
    const viewport = page.locator('.chat-scroll-y')
    await viewport.hover()
    await page.mouse.wheel(0, -2200)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('history')
    await page.waitForTimeout(700)
    await expect.poll(() => page.evaluate(() => Boolean(window.__readingAnchorTasks.capture()?.text))).toBe(true)
    const anchor = await page.evaluate(() => window.__readingAnchorTasks.capture())
    const point = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor!), anchor)
    const olderRequests = await page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'before').length)

    // SessionChat retains this subtree under display:none in Terminal view.
    // The actual Terminal/Hub interaction has its separate integration gate.
    await viewport.evaluate(element => { element.style.display = 'none' })
    await page.evaluate(() => window.__probe.appendRemoteMessage())
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'before').length)).toBe(olderRequests)
    await expect(viewport).toBeAttached()
    await viewport.evaluate(element => { element.style.display = '' })
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(500)
    await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor!), anchor)).toBeCloseTo(point!, 0)
    await expect.poll(() => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[data-hapi-virtual-message]'))
        .every(row => Number.isFinite(Number.parseFloat(getComputedStyle(row).height))))).toBe(true)
    expect(errors).toEqual([])
    await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click()
    await expect(page.getByText('Fixture message 1201', { exact: true })).toBeVisible()
})

type OverlapFrame = {
    at: number
    top: number
    overlap: Array<{ a: string; b: string; rawDelta: number; visiblePixels: number }>
}

test('keeps readable rows separated throughout older-page loading and delayed image sizing', async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await page.goto('/e2e-fixtures/history-load-fixture.html?readingAnchor=1&readingPending=1&longIncoming=1')
    await expect(page.getByText(/^Anchor paragraph 090:/)).toBeVisible()
    await page.waitForTimeout(2000)

    await page.evaluate(() => {
        const state = { frames: [] as OverlapFrame[], stopped: false }
        ;(window as Window & { __rowLayout?: typeof state }).__rowLayout = state
        const sample = () => {
            if (state.stopped) return
            const viewport = document.querySelector<HTMLElement>('.chat-scroll-y')!
            const bounds = viewport.getBoundingClientRect()
            const rows = Array.from(viewport.querySelectorAll<HTMLElement>('[data-hapi-virtual-message]'))
                .map(element => ({
                    id: element.dataset.hapiVirtualMessage!,
                    index: Number(element.dataset.index),
                    top: element.getBoundingClientRect().top,
                    bottom: element.getBoundingClientRect().bottom,
                }))
                .sort((a, b) => a.index - b.index)
            const overlap = rows.flatMap((row, index) => {
                const next = rows[index + 1]
                if (!next || next.index !== row.index + 1) return []
                const visiblePixels = Math.min(row.bottom, next.bottom, bounds.bottom)
                    - Math.max(row.top, next.top, bounds.top)
                return visiblePixels > 1 ? [{
                    a: row.id, b: next.id, rawDelta: row.bottom - next.top, visiblePixels,
                }] : []
            })
            state.frames.push({ at: performance.now(), top: viewport.scrollTop, overlap })
            requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
        window.__probe.holdBefore()
    })

    const viewport = page.locator('.chat-scroll-y')
    const box = (await viewport.boundingBox())!
    const delta = await viewport.evaluate(element => {
        const passage = Array.from(element.querySelectorAll<HTMLElement>('[id^="hapi-message-"]'))
            .find(row => row.id.includes('agent-text:m-1195'))!
        return passage.getBoundingClientRect().top - element.getBoundingClientRect().top + 8
    })
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, delta)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(true)
    const countBefore = await page.evaluate(() => window.__probe.windowState().messageCount)
    await page.getByRole('img', { name: 'reading-anchor.svg', exact: true }).evaluate(image => {
        image.style.maxHeight = 'none'
        image.style.height = `${image.getBoundingClientRect().height + 80}px`
    })
    await page.evaluate(() => window.__probe.releaseBefore())
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(false)
    expect(await page.evaluate(() => window.__probe.windowState().messageCount)).toBeGreaterThan(countBefore)
    for (let index = 0; index < 10; index++) {
        await page.mouse.wheel(0, -700)
        await page.waitForTimeout(80)
    }
    await page.waitForTimeout(500)
    const frames = await page.evaluate(() => {
        const state = (window as Window & { __rowLayout: { frames: OverlapFrame[]; stopped: boolean } }).__rowLayout
        state.stopped = true
        return state.frames
    })
    await info.attach('row-layout-trajectory', { body: JSON.stringify(frames), contentType: 'application/json' })
    expect(frames.length).toBeGreaterThan(10)
    expect(frames.filter(frame => frame.overlap.length > 0)).toEqual([])
    expect(await page.locator('[data-hapi-virtual-message]').count()).toBeLessThanOrEqual(40)
    expect(errors).toEqual([])
})
