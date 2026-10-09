import { expect, test } from '@playwright/test'
for (const width of [390, 1280]) {
    test(`Codex command remains one line with no output at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 })
        await page.goto('/e2e-fixtures/codex-command-fixture.html')
        const label = page.getByText(/^Ran ls -ld/)
        await expect(label).toBeVisible()
        const geometry = await label.evaluate(el => ({ height: el.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(el).lineHeight), overflow: getComputedStyle(el).textOverflow, whitespace: getComputedStyle(el).whiteSpace }))
        expect(geometry.height).toBeLessThanOrEqual(geometry.lineHeight + 1)
        expect(geometry.overflow).toBe('ellipsis')
        expect(geometry.whitespace).toBe('nowrap')
        await expect(page.getByText('DETAIL_OUTPUT_ONLY')).toHaveCount(0)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.getByRole('button', { name: /Ran ls -ld/ }).click()
        await expect(page.getByRole('dialog')).toContainText('DETAIL_OUTPUT_ONLY')
        await page.getByRole('button', { name: 'Close', exact: true }).click()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(label).toBeVisible()
        await expect(page.getByText('DETAIL_OUTPUT_ONLY')).toHaveCount(0)
    })
}
