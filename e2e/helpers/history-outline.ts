import { expect, type Page } from '@playwright/test'

export async function loadDirectoryThrough(page: Page, seq: number) {
    const panel = page.getByRole('complementary', { name: 'Outline', exact: true })
    const target = panel.getByRole('button', { name: new RegExp(`Fixture message ${seq}$`) })
    for (let attempt = 0; attempt < 13; attempt++) {
        if (await target.count()) return
        const before = await page.evaluate(() => window.__probe.requests.filter(row => row.direction === 'outline').length)
        await panel.getByRole('button', { name: 'Load earlier', exact: true }).click()
        await expect.poll(() => page.evaluate(() => window.__probe.requests.filter(row => row.direction === 'outline').length)).toBeGreaterThan(before)
        await expect(panel.getByRole('button', { name: 'Loading…', exact: true })).toHaveCount(0)
    }
    await expect(target).toBeVisible()
}

