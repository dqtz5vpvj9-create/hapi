import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
    await page.goto('/e2e-fixtures/exceptional-workflows-fixture.html')
    await expect(page.getByRole('button', { name: 'Fork conversation' })).toBeVisible()
})
for (const mobile of [false, true]) {
    test(`scratchlist cleanup never resends after reopen (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
        if (mobile) await page.setViewportSize({ width: 390, height: 844 })
        await page.getByRole('button', { name: 'Send to queue', exact: true }).click()
        await expect(page.getByRole('alert')).toContainText('Already sent')
        await page.getByRole('button', { name: 'Toggle scratchlist' }).click()
        await page.getByRole('button', { name: 'Toggle scratchlist' }).click()
        await expect(page.getByRole('button', { name: 'Retry cleanup' })).toBeVisible()
        await page.evaluate(() => { (window as any).exceptional.cleanupFails = false })
        await page.getByRole('button', { name: 'Retry cleanup' }).click()
        await expect(page.getByTestId('scratchlist-drawer')).toHaveCount(0)
        expect(await page.evaluate(() => (window as any).exceptional.sends)).toBe(1)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
}
test('fork cancels safely and reopens the confirmed child after navigation failure', async ({ page }) => {
    await page.getByRole('button', { name: 'Fork conversation' }).click()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(await page.evaluate(() => (window as any).exceptional.forks)).toBe(0)
    await page.getByRole('button', { name: 'Fork conversation' }).click()
    await page.getByRole('button', { name: 'Create fork', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('Navigation failed')
    await page.evaluate(() => { (window as any).exceptional.navigationFails = false })
    await page.getByRole('button', { name: 'Create fork', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByTestId('destination')).toHaveText('forked-session')
    expect(await page.evaluate(() => (window as any).exceptional.forks)).toBe(1)
})
test('steering recovers its visible status without any SSE event', async ({ page }) => {
    await page.getByRole('button', { name: 'Steer queued message' }).click()
    await expect(page.getByRole('list', { name: 'Queued messages' })).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).exceptional.steers)).toBe(1)
    expect(await page.evaluate(() => (window as any).exceptional.reads)).toBeGreaterThan(0)
})
test('steering network failure preserves the queued message and does not resubmit', async ({ page }) => {
    await page.evaluate(() => { (window as any).exceptional.steerFails = true })
    await page.getByRole('button', { name: 'Steer queued message' }).click()
    await expect(page.getByRole('alert')).toContainText('Steering not confirmed')
    await expect(page.getByText('Change the approach')).toBeVisible()
    expect(await page.evaluate(() => (window as any).exceptional.steers)).toBe(1)
})
