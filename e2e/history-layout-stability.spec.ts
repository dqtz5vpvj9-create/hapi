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
    await page.goto('/e2e-fixtures/history-load-fixture.html?readingAnchor=1&readingPending=1&longIncoming=1&holdBefore=1')
    await expect(page.getByText(/^Anchor paragraph 090:/)).toBeVisible()
    await page.waitForTimeout(2000)

    // Gate the API before mount, rather than after an adjacent-page preload
    // could already have captured an ungated request. The seven-row initial
    // fixture window starts at the image immediately above the long passage.
    const initial = await page.evaluate(() => window.__probe.windowState())
    expect(initial).toMatchObject({
        messageCount: 7, oldestSeq: 1194, newestSeq: 1200,
        isLoadingMore: false, isSyncingTail: false,
    })
    const setupProof: unknown[] = []
    const recordSetup = async (phase: string) => {
        setupProof.push(await page.evaluate(phase => {
            const viewport = document.querySelector<HTMLElement>('.chat-scroll-y')!
            const image = viewport.querySelector<HTMLImageElement>('img[alt="reading-anchor.svg"]')
            const bounds = viewport.getBoundingClientRect()
            const imageBounds = image?.getBoundingClientRect()
            return {
                phase, at: performance.now(), state: window.__probe.windowState(),
                requests: window.__probe.requests.map(request => ({ ...request })),
                finishedRequests: window.__probe.finishedRequests,
                viewport: { top: viewport.scrollTop, height: viewport.clientHeight, scrollHeight: viewport.scrollHeight },
                image: imageBounds ? {
                    top: imageBounds.top, bottom: imageBounds.bottom, height: imageBounds.height,
                    visiblePixels: Math.min(imageBounds.bottom, bounds.bottom) - Math.max(imageBounds.top, bounds.top),
                } : null,
            }
        }, phase))
        await info.attach(`delayed-image-setup-${phase}`, { body: JSON.stringify(setupProof.at(-1)), contentType: 'application/json' })
    }
    await recordSetup('before-input')

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
    })

    const viewport = page.locator('.chat-scroll-y')
    const box = (await viewport.boundingBox())!
    // Align the actual loaded-window edge. Aligning m-1195 instead leaves
    // the image-containing row above it and can miss the foreground sentinel.
    const delta = await viewport.evaluate(element => -element.scrollTop - 1)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, delta)
    await recordSetup('after-input')
    await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeLessThanOrEqual(1)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('history')
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(true)
    const heldRequests = await page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'before'))
    expect(heldRequests).toHaveLength(1)
    expect(heldRequests[0]).toMatchObject({ beforeSeq: initial.oldestSeq, limit: 200 })
    const countBefore = await page.evaluate(() => window.__probe.windowState().messageCount)
    expect(countBefore).toBe(initial.messageCount)
    await recordSetup('foreground-held')

    const image = page.getByRole('img', { name: 'reading-anchor.svg', exact: true })
    await expect(image).toBeInViewport()
    const imageHeight = await image.evaluate(element => element.getBoundingClientRect().height)
    expect(imageHeight).toBeGreaterThan(0)
    await image.evaluate(image => {
        image.style.maxHeight = 'none'
        image.style.height = `${image.getBoundingClientRect().height + 80}px`
    })
    await expect.poll(() => image.evaluate(element => element.getBoundingClientRect().height)).toBeCloseTo(imageHeight + 80, 0)
    await expect(image).toBeInViewport()
    expect(await page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(true)
    expect(await page.evaluate(() => window.__probe.windowState().messageCount)).toBe(countBefore)
    await recordSetup('image-grown-while-held')

    await page.evaluate(() => window.__probe.releaseBefore())
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(false)
    expect(await page.evaluate(() => window.__probe.windowState().messageCount)).toBeGreaterThan(countBefore)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().oldestSeq)).toBe(initial.oldestSeq! - 200)
    await recordSetup('older-page-applied')
    await info.attach('delayed-image-setup-proof', { body: JSON.stringify(setupProof), contentType: 'application/json' })
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
