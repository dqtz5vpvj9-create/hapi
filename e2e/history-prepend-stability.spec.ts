import { test, expect } from '@playwright/test'

test.use({ hasTouch: true })

for (const gesture of ['wheel', 'touch', 'keyboard'] as const) {
    test(`keeps the passage while fast ${gesture} loads six pages through regrouping and cache eviction`, async ({ page }, info) => {
        test.setTimeout(90_000)
        await page.setViewportSize({ width: 390, height: 844 })
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto('/e2e-fixtures/history-load-fixture.html?coldInitial=1&groupedHistory=1')
        const viewport = page.locator('.chat-scroll-y')
        await expect(page.getByText(/^History passage 1200.2:/)).toBeVisible()
        await page.waitForTimeout(2000)
        const box = (await viewport.boundingBox())!
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        const cdp = gesture === 'touch' ? await page.context().newCDPSession(page) : null
        const observations = []
        for (let load = 1; load <= 6; load++) {
            await page.evaluate(() => { window.__probe.evictHistoryPayloads(); window.__probe.holdBefore() })
            if (cdp) {
                // Explicit reader positioning releases any retained pagination
                // anchor before this test sets up the next native gesture.
                await viewport.dispatchEvent('pointerdown')
                // Start near the page boundary, then cross it with native finger input.
                await viewport.evaluate(element => { element.scrollTop = 1200 })
                await page.waitForTimeout(200)
                await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
                for (let swipe = 0; swipe < 4; swipe++) {
                    const x = box.x + box.width / 2
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: box.y + 60, id: 1 }] })
                    for (let y = box.y + 110; y < box.y + box.height - 60; y += 50) {
                        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] })
                        await page.waitForTimeout(16)
                    }
                    await page.waitForTimeout(120)
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
                    await page.waitForTimeout(80)
                    if (await viewport.evaluate(element => element.scrollTop === 0)) break
                }
            } else if (gesture === 'keyboard') {
                await viewport.dispatchEvent('pointerdown')
                await viewport.evaluate(element => { element.scrollTop = 1200; element.tabIndex = 0; element.focus() })
                await page.waitForTimeout(200)
                for (let press = 0; press < 4; press++) {
                    await page.keyboard.press('PageUp')
                    await page.waitForTimeout(180)
                }
            } else {
                await page.mouse.wheel(0, -1_000_000)
            }
            await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(true)
            await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0)
            const before = await page.evaluate(() => {
                const viewport = document.querySelector<HTMLElement>('.chat-scroll-y')!
                const top = viewport.getBoundingClientRect().top
                const paragraph = Array.from(viewport.querySelectorAll('p')).find(p => p.getBoundingClientRect().bottom > top + 10)!
                return { text: paragraph.textContent!, y: paragraph.getBoundingClientRect().top - top }
            })
            await page.evaluate(() => window.__probe.releaseBefore())
            await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(false)
            const passage = page.getByText(before.text, { exact: true })
            const point = () => passage.evaluate(element => element.getBoundingClientRect().top
                - document.querySelector('.chat-scroll-y')!.getBoundingClientRect().top)
            await expect.poll(point).toBeCloseTo(before.y, 0)
            // Observe the settling frames too: a later measurement or idle
            // callback must not send the reader to the new page's beginning.
            const frames = await passage.evaluate(async element => {
                const points: number[] = []
                for (let frame = 0; frame < 16; frame++) {
                    await new Promise(requestAnimationFrame)
                    points.push(element.getBoundingClientRect().top - document.querySelector('.chat-scroll-y')!.getBoundingClientRect().top)
                }
                return points
            })
            expect(Math.max(...frames.map(y => Math.abs(y - before.y)))).toBeLessThanOrEqual(1)
            observations.push({ load, before, frames, state: await page.evaluate(() => window.__probe.windowState()) })
            if (load === 2 && gesture === 'keyboard') {
                const anchor = await page.evaluate(() => window.__readingAnchorTasks.capture())
                expect(anchor?.id).toMatch(/^hapi-reading-/)
                const pointBefore = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor!), anchor)
                await page.waitForTimeout(300)
                await page.reload()
                await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor!), anchor)).toBeCloseTo(pointBefore!, 0)
            }
        }
        expect(observations.at(-1)!.state.messageCount).toBe(800)
        expect(observations.at(-1)!.state.oldestSeq).toBe(1)
        expect(errors).toEqual([])
        await info.attach('reading-passage-trajectories', { body: JSON.stringify(observations), contentType: 'application/json' })
    })
}
