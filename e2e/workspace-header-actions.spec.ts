import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

for (const width of [1440, 390]) {
    test(`pane header opens its file tree and closes only its pane at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.addInitScript(() => localStorage.setItem('hapi-lang', 'en'))
        await page.goto('/e2e-fixtures/workspace-fixture.html?panes=2')
        const pane = page.locator('[data-pane-id][data-session-id="chat-2"]')
        await pane.getByTestId('rich-composer-input').waitFor()
        const id = await pane.getAttribute('data-pane-id')
        const header = page.locator(`[data-workspace-header="${id}"]`)
        await header.getByRole('button', { name: 'Project files', exact: true }).click()
        await expect(pane.locator('.session-workspace-panel')).toBeVisible()
        await expect(header.getByRole('button', { name: 'Project files', exact: true })).toHaveAttribute('aria-pressed', 'true')
        await header.getByRole('button', { name: 'Project files', exact: true }).click()
        await expect(pane.locator('.session-workspace-panel')).toHaveCount(0)
        await expect(pane.getByTestId('rich-composer-input')).toBeVisible()
        await header.getByRole('button', { name: 'Close pane', exact: true }).click()
        await expect(pane).toHaveCount(0)
        await expect(page.locator('[data-pane-id][data-session-id="chat-1"]')).toBeVisible()
        expect(await page.evaluate(() => window.__workspaceFixture.sends.length)).toBe(0)
    })
}
