import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

for (const width of [1440, 390]) {
    test(`image preview covers the viewport and keeps its gallery in the initiating pane (${width}px)`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.addInitScript(() => localStorage.setItem('hapi-lang', 'en'))
        await page.goto('/e2e-fixtures/workspace-fixture.html?panes=2')
        const left = page.locator('[data-pane-id][data-session-id="chat-1"]')
        const right = page.locator('[data-pane-id][data-session-id="chat-2"]')
        if (width < 640) await page.getByRole('button', { name: 'P1', exact: true }).click()
        await left.getByTestId('rich-composer-input').waitFor()
        for (const [index, pane] of [left, right].entries()) {
            if (index === 1 && width < 640) await page.getByRole('button', { name: 'P2', exact: true }).click()
            const picker = page.waitForEvent('filechooser')
            await pane.getByRole('button', { name: 'Attach file', exact: true }).click()
            await (await picker).setFiles(Array.from({ length: index === 0 ? 2 : 1 }, (_, n) => ({
                name: `pane-${index + 1}-image-${n + 1}.svg`, mimeType: 'image/svg+xml',
                buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#2186db"/></svg>'),
            })))
            await expect(pane.locator('[data-image-preview-trigger]')).toHaveCount(index === 0 ? 2 : 1)
        }
        await expect.poll(() => page.evaluate(() => window.__workspaceFixture.uploads.filter(upload => upload.complete).length)).toBe(3)
        if (width < 640) await page.getByRole('button', { name: 'P1', exact: true }).click()
        const trigger = left.locator('[data-image-preview-trigger]').first()
        await expect.poll(() => trigger.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
        await trigger.click()
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        await expect.poll(() => dialog.boundingBox()).toEqual({ x: 0, y: 0, width, height: 900 })
        await expect(dialog).toContainText('1 / 2')
        await dialog.getByRole('button', { name: 'Next image' }).click()
        await expect(dialog).toHaveAttribute('aria-label', 'pane-1-image-2.svg')
        const next = page.getByRole('dialog', { name: 'pane-1-image-2.svg', exact: true })
        await expect(next.getByRole('button', { name: 'Next image' })).toBeDisabled()
        for (let i = 0; i < 8; i++) {
            await page.keyboard.press('Tab')
            await expect(next.locator(':focus')).toHaveCount(1)
        }
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(trigger).toBeFocused()
        expect(await page.evaluate(() => window.__workspaceFixture.sends.length)).toBe(0)
    })
}
