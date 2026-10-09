import { expect, test } from '@playwright/test'

for (const [mode, width, appearance] of [
    ['workspace', 320, 'light'], ['workspace', 390, 'light'],
    ['workspace', 1280, 'light'], ['workspace', 390, 'dark'],
    ['single', 390, 'light'],
] as const) test(`keeps ${mode} suggestions readable and selectable at ${width}px in ${appearance}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    // A short viewport exercises the area available above the phone keyboard.
    await page.setViewportSize({ width, height: width < 640 ? 500 : 800 })
    await page.goto(`/e2e-fixtures/workspace-fixture.html?split&workingSet=12&longTitles&appearance=${appearance}${mode === 'single' ? '&single' : ''}`)
    await expect(page.locator('[data-chat-presented="true"]:visible').first()).toBeVisible()
    const composer = page.locator('[data-testid="composer-shell"]:visible').first()
    const input = composer.getByTestId('rich-composer-input')
    await expect(input).toBeVisible()
    await input.pressSequentially('@')
    const rows = composer.locator('[data-suggestion-index]')
    await expect(rows.first()).toBeVisible()
    const geometry = await rows.evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect()
        const spans = [...element.children].map(span => span.getBoundingClientRect())
        return {
            height: rect.height,
            fontSize: parseFloat(getComputedStyle(element).fontSize),
            contained: spans.every(span => span.top >= rect.top && span.bottom <= rect.bottom + 1 && span.left >= rect.left && span.right <= rect.right + 1),
            separate: spans.length < 2 || spans[0].bottom <= spans[1].top,
        }
    }))
    expect(geometry.every(row => row.height >= 44 && row.fontSize >= 14 && row.contained && row.separate), JSON.stringify(geometry)).toBe(true)
    const panel = composer.locator('.app-floating-panel')
    const bounds = (await panel.boundingBox())!
    expect(bounds.y).toBeGreaterThanOrEqual(0)
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual((await input.boundingBox())!.y)
    // Keyboard traversal scrolls only the menu and inserts a mention, not a send.
    for (let index = 1; index < await rows.count(); index++) await input.press('ArrowDown')
    const last = rows.last()
    await expect.poll(async () => {
        const row = (await last.boundingBox())!, box = (await panel.boundingBox())!
        return row.y >= box.y && row.y + row.height <= box.y + box.height + 1
    }).toBe(true)
    await input.press('Enter')
    await expect(rows).toHaveCount(0)
    await expect(input.locator('[data-composer-mention="session"]')).toHaveCount(1)
    await input.fill('')
    await input.pressSequentially('@')
    await expect(rows.first()).toBeVisible()
    const chosen = await rows.first().locator('span').first().textContent()
    await rows.first().click()
    await expect(input.locator('[data-composer-mention="session"]')).toHaveText(chosen!)
    await expect(rows).toHaveCount(0)
    await composer.getByRole('button', { name: /^Permission Mode:/ }).click()
    const settings = composer.locator('.app-floating-panel button')
    await expect(settings.first()).toBeVisible()
    expect(await settings.evaluateAll(buttons => buttons.every(button =>
        button.getBoundingClientRect().height >= 32 && parseFloat(getComputedStyle(button).fontSize) >= 14
    ))).toBe(true)
    expect(await page.evaluate(() => window.__workspaceFixture.sends)).toEqual([])
    expect(errors).toEqual([])
})
