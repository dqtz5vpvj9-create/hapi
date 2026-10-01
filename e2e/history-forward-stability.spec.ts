import { expect, test } from '@playwright/test'

for (const mode of ['held', 'held-moved', 'cached'] as const) {
    const moveWhileWaiting = mode === 'held-moved'
    test(`forward publication preserves the passage after End${mode === 'cached' ? ' with a cached page' : moveWhileWaiting ? ' and further upward reading' : ''}`, async ({ page }, info) => {
        test.setTimeout(60_000)
        await page.setViewportSize({ width: 390, height: 844 })
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto('/e2e-fixtures/history-load-fixture.html?coldInitial=1&groupedHistory=1')
        await expect(page.getByText(/^History passage 1200.2:/)).toBeVisible()
        await page.waitForTimeout(2000)
        const viewport = page.locator('.chat-scroll-y')
        const box = (await viewport.boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        for (const oldest of [981, 781, 581, 381, 181, 1]) {
            await page.mouse.wheel(0, -1_000_000)
            await expect.poll(() => page.evaluate(() => window.__probe.windowState().oldestSeq)).toBe(oldest)
            await page.waitForTimeout(250)
        }
        expect(await page.evaluate(() => window.__probe.windowState().newestSeq)).toBe(800)
        if (mode === 'cached') {
            await viewport.evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight - 3000 })
            await page.waitForTimeout(200)
            await page.mouse.wheel(0, 700)
            await page.waitForTimeout(500)
            expect(await page.evaluate(() => window.__probe.windowState().newestSeq)).toBe(800)
            await page.mouse.wheel(0, -1_000_000)
            await page.waitForTimeout(400)
        }
        const requestsBeforeEnd = await page.evaluate(() => window.__probe.requests.length)
        if (mode !== 'cached') await page.evaluate(() => { window.__probe.evictHistoryPayloads(); window.__probe.holdAfter() })
        await viewport.evaluate(element => {
            element.tabIndex = 0
            element.focus()
            let endStarted = false
            element.addEventListener('keydown', event => { if (event.key === 'End') endStarted = true }, { once: true })
            const finished = () => {
                if (!endStarted) return
                element.dataset.endFinished = 'true'
                element.removeEventListener('scrollend', finished)
            }
            element.addEventListener('scrollend', finished)
        })
        await page.keyboard.press('End')
        if (mode === 'cached') {
            await expect.poll(() => page.evaluate(() => window.__probe.windowState().newestSeq)).toBeGreaterThan(800)
            const boundary = page.getByText(/^History passage 797.0:/)
            await expect(boundary).toBeInViewport()
            await expect(viewport).toHaveAttribute('data-end-finished', 'true')
            const points = await boundary.evaluate(async element => {
                const values: number[] = []
                for (let frame = 0; frame < 30; frame++) {
                    await new Promise(requestAnimationFrame)
                    values.push(element.getBoundingClientRect().top - document.querySelector('.chat-scroll-y')!.getBoundingClientRect().top)
                }
                return values
            })
            expect(Math.max(...points) - Math.min(...points)).toBeLessThanOrEqual(1)
            await expect(boundary).toBeInViewport()
            await info.attach('cached-forward-reading-trajectory', { body: JSON.stringify({ points }), contentType: 'application/json' })
            expect(await page.evaluate(() => window.__probe.windowState())).toMatchObject({ messageCount: 800, viewMode: 'history' })
            expect(await page.evaluate(() => window.__probe.requests.length)).toBe(requestsBeforeEnd)
            expect(errors).toEqual([])
            return
        }
        await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(true)
        await expect(page.getByText(/^History passage 800.2:/)).toBeInViewport()
        // End's native animation must finish before observing publication alone.
        await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(1)
        await expect(viewport).toHaveAttribute('data-end-finished', 'true')
        await page.waitForTimeout(250)
        if (moveWhileWaiting) {
            await page.mouse.wheel(0, -3000)
            await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(2500)
            await page.waitForTimeout(200)
        }
        const anchor = await page.evaluate(() => window.__readingAnchorTasks.capture())
        expect(anchor?.text).toBeTruthy()
        const before = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor!), anchor)
        await page.evaluate(() => window.__probe.releaseAfter())
        await expect.poll(() => page.evaluate(() => window.__probe.windowState().newestSeq)).toBe(1000)
        const frames = await page.evaluate(async anchor => {
            const points: Array<number | null> = []
            for (let i = 0; i < 30; i++) {
                await new Promise(requestAnimationFrame)
                points.push(window.__readingAnchorTasks.point(anchor!))
            }
            return points
        }, anchor)
        expect(frames.every(point => point !== null && Math.abs(point - before!) <= 1)).toBe(true)
        expect(await page.evaluate(() => window.__probe.windowState())).toMatchObject({ oldestSeq: 201, messageCount: 800, viewMode: 'history' })
        expect(errors).toEqual([])
        await info.attach('forward-reading-trajectory', { body: JSON.stringify({ anchor, before, frames }), contentType: 'application/json' })
    })
}
