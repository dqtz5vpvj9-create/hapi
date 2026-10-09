import { expect, test } from '@playwright/test'

for (const width of [390, 1280]) {
    test(`media fetch and decode preserve layout at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 1000 })
        let releaseAttachment!: () => void
        const hold = new Promise<void>(resolve => { releaseAttachment = resolve })
        await page.route('**/delayed-attachment.svg', async route => {
            await hold
            await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="1600"><rect width="40" height="1600" fill="blue"/></svg>' })
        })
        await page.goto('/e2e-fixtures/media-layout-fixture.html', { waitUntil: 'domcontentloaded' })
        await expect(page.locator('[data-media-frame]')).toHaveCount(3)
        await expect.poll(() => page.evaluate(() => (window as any).pendingMediaCount())).toBe(2)
        const initial = await page.evaluate(() => {
            const frames: number[][] = []
            const measure = () => ['[data-test-anchor]', '[data-test-after-attachment]'].map(selector => document.querySelector(selector)!.getBoundingClientRect().top)
            const before = measure()
            let remaining = 120
            const sample = () => { frames.push(measure()); if (--remaining) requestAnimationFrame(sample) }
            requestAnimationFrame(sample)
            Object.assign(window, { mediaFrames: frames })
            for (const id of ['portrait', 'landscape']) (window as any).releaseMedia(id)
            return before
        })
        releaseAttachment()
        for (const id of ['portrait', 'landscape']) {
            await expect(page.locator(`[data-test-media="${id}"] [data-media-state]`)).toHaveAttribute('data-media-state', 'ready')
        }
        await expect(page.locator('[data-media-frame="attachment"]')).toHaveAttribute('data-media-state', 'ready')
        await expect.poll(() => page.evaluate(() => (window as any).mediaFrames.length)).toBe(120)
        const samples: number[][] = await page.evaluate(() => (window as any).mediaFrames)
        expect(Math.max(...samples.flatMap(frame => frame.map((top, index) => Math.abs(top - initial[index]))))).toBeLessThanOrEqual(1)
        await page.locator('[data-test-media="portrait"] [data-image-preview-trigger]').click()
        await expect(page.getByRole('dialog')).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)

        await page.locator('[data-test-media="document"]').getByRole('button', { name: 'Open preview / prepare download' }).click()
        const beforeDocument = await page.locator('[data-test-after-document]').boundingBox()
        await page.evaluate(() => (window as any).releaseMedia('document'))
        await expect(page.getByText('Preview content', { exact: false }).first()).toBeAttached()
        const afterDocument = await page.locator('[data-test-after-document]').boundingBox()
        expect(Math.abs(afterDocument!.y - beforeDocument!.y)).toBeLessThanOrEqual(1)
    })
}
