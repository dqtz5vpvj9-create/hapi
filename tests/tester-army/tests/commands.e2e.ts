import { test } from '@e2e-dev/web'
import { expect } from 'e2e'

test('command summary previews output and expands inline before opening the full details', async ({ app, browser, screen }) => {
    await app.open('/e2e-fixtures/codex-command-fixture.html')
    const header = screen.getByRole('button', /Ran ls -ld/)
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(screen.getByRole('region', 'Output preview')).toContainText('API acceptance saved: True')
    await expect(screen.getByText('DETAIL_OUTPUT_ONLY')).toHaveCount(0)
    expect(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

    await screen.getByRole('button', /Show details/).tap()
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await expect(screen.getByRole('region', 'Command details')).toContainText('DETAIL_OUTPUT_ONLY')
    await expect(screen.getByRole('dialog')).toHaveCount(0)
    await app.screenshot('command-inline-details')

    await screen.getByRole('button', 'Open full details').tap()
    await expect(screen.getByRole('dialog')).toContainText('DETAIL_OUTPUT_ONLY')
    await app.screenshot('command-full-details')
    await screen.getByRole('button', 'Close').tap()
    await expect(screen.getByRole('dialog')).toHaveCount(0)
    await expect(screen.getByRole('region', 'Command details')).toBeVisible()
    await screen.getByRole('button', 'Hide details').tap()
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(screen.getByText('DETAIL_OUTPUT_ONLY')).toHaveCount(0)
    await expect(screen.getByRole('region', 'Output preview')).toBeVisible()
})
