import { expect, test, type Page } from '@playwright/test'

// Deterministic contract regression. Hold the first real 20-row response rather
// than guessing a cold-load duration. No production source changes are needed.
const url = '/e2e-fixtures/history-load-fixture.html?nativeChat=1&coldInitial=1&holdLatest=1&holdBefore=1'
const viewport = (page: Page) => page.locator('.chat-scroll-y')
async function opening(page: Page) {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(url)
    await expect(viewport(page)).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.__probe.requests.some(r => r.direction === 'latest' && r.limit === 20))).toBe(true)
    const geometry = await viewport(page).evaluate(el => ({ top: el.scrollTop, floor: el.scrollHeight - el.clientHeight }))
    expect(geometry).toEqual({ top: 0, floor: 0 })
    await expect(page.locator('[data-chat-presented]')).toHaveAttribute('data-chat-presented', 'false')
}
async function release(page: Page) {
    await page.evaluate(() => window.__probe.releaseLatest())
    await expect(page.locator('[data-chat-presented]')).toHaveAttribute('data-chat-presented', 'true')
}
async function distance(page: Page) {
    return viewport(page).evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)
}
async function wheel(page: Page, delta: number) {
    const box = await viewport(page).boundingBox()
    if (!box) throw new Error('Reader not mounted')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await viewport(page).evaluate(el => {
        ;(window as any).__coldWheelDelivered = false
        el.addEventListener('wheel', () => { (window as any).__coldWheelDelivered = true }, { once: true })
    })
    await page.mouse.wheel(0, delta)
    await expect.poll(() => page.evaluate(() => (window as any).__coldWheelDelivered)).toBe(true)
}

test('control: held cold history lands at latest without input', async ({ page }) => {
    await opening(page); await release(page)
    await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
})

test('retains an upward wheel received before the held 20-row page', async ({ page }) => {
    await opening(page)
    await wheel(page, -120)
    expect(await viewport(page).evaluate(el => el.scrollTop)).toBe(0)
    await release(page)
    await expect.poll(() => distance(page)).toBeCloseTo(120, 0)
})

test('retains a trusted touch drag received before the held 20-row page', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
    const page = await context.newPage()
    try {
        await opening(page)
        const box = await viewport(page).boundingBox()
        if (!box) throw new Error('Reader not mounted')
        await viewport(page).evaluate(el => {
            ;(window as any).__coldTouches = []
            for (const type of ['touchstart', 'touchmove', 'touchend']) el.addEventListener(type, event => {
                ;(window as any).__coldTouches.push({ type, trusted: event.isTrusted,
                    y: (event as TouchEvent).touches[0]?.clientY ?? null })
            }, { passive: true })
        })
        const cdp = await context.newCDPSession(page)
        const x = box.x + box.width / 2, y = box.y + Math.min(200, box.height / 3)
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 120, id: 1 }] })
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await expect.poll(() => page.evaluate(() => (window as any).__coldTouches.filter((e: any) => e.type === 'touchmove' && e.trusted).length)).toBeGreaterThan(0)
        const delivered = await page.evaluate(() => (window as any).__coldTouches)
        expect(delivered.every((event: { trusted: boolean }) => event.trusted)).toBe(true)
        await test.info().attach('trusted-touch-delivery', { body: JSON.stringify(delivered), contentType: 'application/json' })
        await release(page)
        await expect.poll(() => distance(page)).toBeCloseTo(120, 0)
    } finally { await context.close() }
})

test('retains a touch pull received before the held 20-row page', async ({ page }) => {
    await opening(page)
    // Synthetic touch checks the real application handlers only. It is not
    // evidence about OS touch physics or a replacement for device validation.
    await viewport(page).evaluate(el => {
        const dispatch = (type: string, y: number) => {
            const touch = new Touch({ identifier: 1, target: el, clientX: 190, clientY: y })
            el.dispatchEvent(new TouchEvent(type, { bubbles: true, touches: type === 'touchend' ? [] : [touch], changedTouches: [touch] }))
        }
        dispatch('touchstart', 200); dispatch('touchmove', 320); dispatch('touchend', 320)
    })
    await release(page)
    await expect.poll(() => distance(page)).toBeCloseTo(120, 0)
})

for (const [name, deltas, expected] of [
    ['up then partial down', [-120, 40], 80],
    ['down-clamped then up', [120, -40], 40],
    ['up, through tail, then up', [-120, 300, -40], 40],
    ['equal reversal', [-120, 120], 0],
] as const) {
    test(`keeps ordered relative intent: ${name}`, async ({ page }) => {
        await opening(page)
        for (const delta of deltas) await wheel(page, delta)
        await release(page)
        await expect.poll(() => distance(page)).toBeCloseTo(expected, 0)
    })
}

for (const deltas of [[-1], [-10], [-25], [-26], [-120, 110]]) {
    test(`completes first presentation after small residual intent ${deltas.join(',')}`, async ({ page }) => {
        await opening(page)
        for (const delta of deltas) await wheel(page, delta)
        await release(page)
        const expected = deltas.length === 1 && deltas[0] === -26 ? 26 : 0
        await expect.poll(() => distance(page)).toBeCloseTo(expected, 0)
    })
}
