import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 } })

test('native initial loading remains visible until the first response arrives', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?nativeChat=1&holdLatest=1&coldInitial=1')
    await expect(page.getByText('Loading messages…', { exact: true })).toBeVisible()
    await page.setViewportSize({ width: 412, height: 915 })
    await expect(page.getByText('Loading messages…', { exact: true })).toBeVisible()
    expect(await page.locator('[data-chat-node-key]').count()).toBe(0)
    await page.evaluate(() => window.__probe.releaseLatest())
    await expect(page.getByText('Fixture message 1200', { exact: true })).toBeVisible()
})

test('collapsed native process content triggers first-viewport coverage', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?nativeChat=1&nativeReplay=completed&coldInitial=1&holdBefore=1')
    await expect(page.locator('.hapi-native-process[aria-expanded="false"]').first()).toBeHidden()
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(true)
    await page.evaluate(() => window.__probe.releaseBefore())
    await expect.poll(() => page.locator('.chat-scroll-y').evaluate(e => e.scrollHeight - e.clientHeight)).toBeGreaterThan(1)
    await expect.poll(() => page.locator('.chat-scroll-y').evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeLessThanOrEqual(1)
    await expect(page.getByText('The native chat upgrade is ready for verification.', { exact: true })).toBeVisible()
})

for (const native of [false, true]) {
    test(`an empty ${native ? 'native' : 'legacy'} response completes opening`, async ({ page }) => {
        await page.goto(`/e2e-fixtures/history-load-fixture.html?emptySession=1${native ? '&nativeChat=1' : ''}`)
        await expect(page.locator('[data-chat-presented="true"]')).toHaveCount(1)
        await expect(page.locator('[data-chat-opening]')).toHaveCount(0)
        expect(await page.locator('[data-hapi-virtual-message]').count()).toBe(0)
    })

    test(`a genuinely short ${native ? 'native' : 'legacy'} conversation starts at the top`, async ({ page }) => {
        await page.goto(`/e2e-fixtures/history-load-fixture.html?shortSession=1${native ? '&nativeChat=1' : ''}`)
        await expect(page.getByText('Fixture message 1198', { exact: true })).toBeVisible()
        await expect.poll(() => page.evaluate(() => window.__probe.windowState().isSyncingTail)).toBe(false)
        const geometry = await page.locator('.chat-scroll-y').evaluate(viewport => {
            const first = viewport.querySelector('[data-hapi-virtual-message]')!
            return { top: first.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
                scrollTop: viewport.scrollTop, overflow: viewport.scrollHeight - viewport.clientHeight }
        })
        expect(geometry.top).toBeLessThan(40)
        expect(geometry.scrollTop).toBe(0)
        expect(geometry.overflow).toBe(0)
        expect(await page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'before'))).toHaveLength(0)
    })
}

for (const native of [false, true]) {
    test(`an already filled ${native ? 'native' : 'legacy'} first page does not publish extra history`, async ({ page }) => {
        await page.goto(`/e2e-fixtures/history-load-fixture.html?coldInitial=1&groupedHistory=1${native ? '&nativeChat=1' : ''}`)
        await expect(page.getByText(/^History passage 1200.2:/)).toBeInViewport()
        // Let asynchronous layout and any speculative preload finish. Warm
        // pages may be fetched, but an already full viewport needs no prepend.
        await page.waitForTimeout(1200)
        expect(await page.evaluate(() => window.__probe.windowState())).toMatchObject({
            oldestSeq: 1181, newestSeq: 1200, messageCount: 20, isLoadingMore: false,
        })
    })
}

test('user interaction cancels a pending native opening prepend', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?nativeChat=1&compactInitial=1&coldInitial=1&holdBefore=1')
    await expect(page.getByText('Fixture message 1200', { exact: true })).toBeHidden()
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(true)
    await page.locator('.chat-scroll-y').dispatchEvent('pointerdown', { pointerType: 'touch' })
    await page.evaluate(() => window.__probe.releaseBefore())
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(false)
    expect(await page.evaluate(() => window.__probe.windowState())).toMatchObject({ messageCount: 1, newestSeq: 1200 })
    expect(await page.locator('.chat-scroll-y').evaluate(e => e.scrollTop)).toBe(0)
})

test('native opening coverage uses measured rows rather than their taller virtual estimates', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 915 })
    await page.goto('/e2e-fixtures/history-load-fixture.html?nativeChat=1&coldInitial=1&compactInitial=10&holdBefore=1')
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(true)
    await expect(page.getByText('Fixture message 1200', { exact: true })).toBeHidden()
    await page.evaluate(() => window.__probe.releaseBefore())
    await expect(page.getByText('Fixture message 1200', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().oldestSeq)).toBe(981)
})

async function observeFirstPresentation(page: import('@playwright/test').Page) {
    await page.addInitScript(() => {
        const frames: { visible: boolean; bottom: number; floor: number }[] = []
        Object.assign(window, { openingFrames: frames })
        const sample = () => {
            const viewport = document.querySelector<HTMLElement>('.chat-scroll-y')
            const rows = [...document.querySelectorAll<HTMLElement>('[data-hapi-virtual-message]')]
            const last = rows.at(-1)
            if (viewport && last) frames.push({
                visible: getComputedStyle(last).visibility === 'visible',
                bottom: last.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top,
                floor: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
            })
            if (frames.filter(frame => frame.visible).length < 30) requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
    })
}

async function expectStableFirstPresentation(page: import('@playwright/test').Page) {
    await expect.poll(() => page.evaluate(() => (window as unknown as { openingFrames: { visible: boolean }[] })
        .openingFrames.filter(frame => frame.visible).length)).toBe(30)
    const frames = await page.evaluate(() => (window as unknown as {
        openingFrames: { visible: boolean; bottom: number; floor: number }[]
    }).openingFrames)
    const first = frames.findIndex(frame => frame.visible)
    const visible = frames.slice(first)
    expect(visible.every(frame => frame.visible)).toBe(true)
    expect(Math.max(...visible.map(frame => frame.floor))).toBeLessThanOrEqual(1)
    const bottoms = visible.map(frame => frame.bottom)
    expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(1)
}

for (const native of [false, true]) {
    test(`a collapsed ${native ? 'native' : 'legacy'} opening shows only its final viewport`, async ({ page }) => {
        await observeFirstPresentation(page)
        await page.goto(`/e2e-fixtures/history-load-fixture.html?coldInitial=1&compactInitial=1&holdBefore=1${native ? '&nativeChat=1' : ''}`)
        await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(true)
        await expect(page.getByText('Loading messages…', { exact: true })).toBeVisible()
        await expect(page.getByText('Fixture message 1200', { exact: true })).toBeHidden()
        // Changing width while the necessary page is pending must not expose
        // the partial page or reveal geometry measured at the old width.
        await page.setViewportSize({ width: 412, height: 915 })
        await page.evaluate(() => window.__probe.releaseBefore())
        await expect(page.getByText('Fixture message 1200', { exact: true })).toBeInViewport()
        await expectStableFirstPresentation(page)
        expect(await page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'before'))).toHaveLength(1)
    })

    test(`a filled ${native ? 'native' : 'legacy'} opening is stable from its first visible frame`, async ({ page }) => {
        await observeFirstPresentation(page)
        await page.goto(`/e2e-fixtures/history-load-fixture.html?coldInitial=1&groupedHistory=1${native ? '&nativeChat=1' : ''}`)
        await expect(page.getByText(/^History passage 1200.2:/)).toBeInViewport()
        await expectStableFirstPresentation(page)
    })

    test(`background sync keeps the ${native ? 'native' : 'legacy'} body visible`, async ({ page }) => {
        await page.goto(`/e2e-fixtures/history-load-fixture.html?shortSession=1${native ? '&nativeChat=1' : ''}`)
        await expect(page.getByText('Fixture message 1200', { exact: true })).toBeVisible()
        await page.evaluate(() => { window.__probe.holdLatest(); void window.__probe.refetch() })
        await expect.poll(() => page.evaluate(() => window.__probe.windowState().isSyncingTail)).toBe(true)
        await expect(page.getByText('Fixture message 1200', { exact: true })).toBeVisible()
        await expect(page.locator('[data-chat-opening]')).toHaveCount(0)
        await page.evaluate(() => window.__probe.releaseLatest())
        await expect.poll(() => page.evaluate(() => window.__probe.windowState().isSyncingTail)).toBe(false)
        await expect(page.getByText('Fixture message 1200', { exact: true })).toBeVisible()
    })

    test(`a cached ${native ? 'native' : 'legacy'} opening does not wait for tail revalidation`, async ({ page }) => {
        await observeFirstPresentation(page)
        await page.goto(`/e2e-fixtures/history-load-fixture.html?cachedReentry=1&holdLatest=1${native ? '&nativeChat=1' : ''}`)
        await expect(page.getByText('Fixture message 1200', { exact: true })).toBeVisible()
        await expectStableFirstPresentation(page)
        expect(await page.evaluate(() => window.__probe.windowState().isSyncingTail)).toBe(true)
        await page.evaluate(() => window.__probe.releaseLatest())
        await expect.poll(() => page.evaluate(() => window.__probe.windowState().isSyncingTail)).toBe(false)
        await expect(page.locator('[data-chat-opening]')).toHaveCount(0)
    })

    test(`a failed ${native ? 'native' : 'legacy'} opening page does not leave the cached body hidden`, async ({ page }) => {
        await page.goto(`/e2e-fixtures/history-load-fixture.html?coldInitial=1&compactInitial=1&failBefore=99${native ? '&nativeChat=1' : ''}`)
        await expect(page.getByText('Fixture message 1200', { exact: true })).toBeVisible({ timeout: 15000 })
        await expect(page.locator('[data-chat-opening]')).toHaveCount(0)
    })
}
