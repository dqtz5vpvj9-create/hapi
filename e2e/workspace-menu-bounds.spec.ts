import { expect, test } from '@playwright/test'

for (const theme of ['default', 'codex']) {
    for (const width of [1440, 390]) {
        test(`pane action menu stays inside the viewport in ${theme} at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 844 })
            await page.goto(`/e2e-fixtures/workspace-fixture.html?split&theme=${theme}`)
            const triggers = page.getByRole('button', { name: 'Pane actions', exact: true })
            await expect(triggers.last()).toBeVisible()
            // The rightmost desktop pane exposed the original containing-block
            // bug; mobile uses the focused pane's toolbar.
            const indices = width >= 920 ? [0, 1] : [0]
            for (const index of indices) {
                await triggers.nth(index).click()
                const menu = page.getByRole('menu')
                await expect(menu).toBeVisible()
                const panel = menu.locator('..')
                await panel.evaluate(async element => {
                    await Promise.all(element.getAnimations().map(animation => animation.finished))
                })
                const bounds = (await panel.boundingBox())!
                expect(bounds.x).toBeGreaterThanOrEqual(7)
                expect(bounds.y).toBeGreaterThanOrEqual(7)
                expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 7)
                expect(bounds.y + bounds.height).toBeLessThanOrEqual(844 - 7)
                const first = menu.getByRole('menuitem').first()
                const last = menu.getByRole('menuitem').last()
                for (const item of [first, last]) {
                    await item.scrollIntoViewIfNeeded()
                    // Visibility alone accepts elements clipped by an ancestor.
                    // Hit testing proves the actual action can be reached.
                    expect(await item.evaluate(element => {
                        const rect = element.getBoundingClientRect()
                        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                        return !!hit && element.contains(hit)
                    })).toBe(true)
                }
                await page.setViewportSize({ width, height: 400 })
                await expect.poll(async () => (await panel.boundingBox())!.height).toBeLessThanOrEqual(384)
                await page.setViewportSize({ width, height: 844 })
                await expect.poll(async () => {
                    const rect = (await panel.boundingBox())!
                    return rect.y + rect.height
                }).toBeLessThanOrEqual(837)
                await page.keyboard.press('Escape')
                await expect(menu).toHaveCount(0)
            }
            await triggers.first().click()
            await expect(page.getByRole('menu')).toBeVisible()
            if (width < 920) await page.getByRole('button', { name: 'P2', exact: true }).click()
            else {
                await page.keyboard.press('Control+b')
                await page.keyboard.press('l')
            }
            await expect(page.getByRole('menu')).toHaveCount(0)
            if (width < 920) await page.getByRole('button', { name: 'P1', exact: true }).click()
            await expect(page.getByRole('menu')).toHaveCount(0)
        })
    }
}
