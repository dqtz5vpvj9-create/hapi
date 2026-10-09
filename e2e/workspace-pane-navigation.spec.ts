import { expect, test, type Page } from '@playwright/test'

async function zoom(page: Page) {
    await page.keyboard.press('Control+b')
    await page.keyboard.press('z')
}

test('desktop pane titles focus the right editor and remain available while zoomed', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/e2e-fixtures/workspace-fixture.html?split')
    const tabs = page.locator('.workspace-pane-tabs')
    const first = tabs.getByRole('button', { name: 'P1: 历史阅读优化', exact: true })
    const second = tabs.getByRole('button', { name: 'P2: Windows 终端集成', exact: true })
    await expect(first).toBeVisible()
    await expect(second).toBeVisible()
    await expect(page.locator('[data-chat-presented=true]')).toHaveCount(2)
    const pane = (id: number) => page.locator(`[data-pane-id][data-session-id="chat-${id}"]`)
    const editor = (id: number) => pane(id).locator('[data-testid="rich-composer-input"]')
    await first.click()
    await expect(editor(1)).toBeFocused()
    await editor(1).fill('Keep this draft in P1')
    await second.click()
    await expect(editor(2)).toBeFocused()
    await editor(2).fill('Keep this draft in P2')
    await page.evaluate(() => {
        ;(window as any).__paneReaders = [...document.querySelectorAll('[data-pane-id] .chat-scroll-y')]
    })
    await zoom(page)
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1)
    for (const id of [1, 2, 1, 2]) {
        await (id === 1 ? first : second).click()
        await expect(editor(id)).toBeFocused()
        await expect(editor(id)).toHaveText(`Keep this draft in P${id}`)
        await expect(pane(id)).toHaveAttribute('data-focused', 'true')
        await expect(id === 1 ? first : second).toHaveAttribute('aria-pressed', 'true')
        await expect(pane(id).locator('[data-chat-presented=true]')).toBeVisible()
    }
    await zoom(page)
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(2)
    expect(await page.evaluate(() => (window as any).__paneReaders.every((node: Element) => node.isConnected))).toBe(true)
    expect(await page.evaluate(() => window.__workspaceFixture.sends)).toEqual([])
})

test('long desktop titles scroll within the pane strip without switching windows or hiding creation', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 })
    await page.goto('/e2e-fixtures/workspace-fixture.html?panes=4&longTitles&workingSet=8&grouped')
    const tabs = page.locator('.workspace-pane-tabs')
    await expect(tabs.locator('button')).toHaveCount(4)
    const selectedWindow = page.locator('.workspace-tab > button[aria-current=page]')
    const before = await selectedWindow.textContent()
    await tabs.locator('button').first().click()
    await expect.poll(() => tabs.evaluate(e => e.scrollLeft)).toBe(0)
    await tabs.hover()
    await page.mouse.wheel(0, 250)
    await expect.poll(() => tabs.evaluate(e => e.scrollLeft)).toBeGreaterThan(0)
    await expect(selectedWindow).toHaveText(before!)
    await tabs.locator('button').last().click()
    // Keyboard focus also brings the selected pane's title back into view.
    await page.keyboard.press('Control+b'); await page.keyboard.press('o')
    await expect(tabs.locator('button').first()).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => tabs.evaluate(e => e.scrollLeft)).toBe(0)
    const title = tabs.locator('.workspace-pane-title').nth(1)
    expect(await title.evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true)
    for (const control of [page.getByRole('button', { name: 'New pane', exact: true }), selectedWindow]) {
        const bounds = (await control.boundingBox())!
        expect(bounds.width).toBeGreaterThan(30)
        expect(bounds.x).toBeGreaterThanOrEqual(0)
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(900)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('mobile keeps compact pane numbers when moving between desktop and phone layouts', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/e2e-fixtures/workspace-fixture.html?split')
    await expect(page.locator('.workspace-pane-title')).toHaveCount(2)
    for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 })
        await expect(page.locator('.workspace-pane-title')).toHaveCount(0)
        await page.getByRole('button', { name: 'P1', exact: true }).click()
        await expect(page.locator('[data-pane-id][data-session-id="chat-1"]')).toBeVisible()
        await page.getByRole('button', { name: 'P2', exact: true }).click()
        await expect(page.locator('[data-pane-id][data-session-id="chat-2"]')).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await expect(page.locator('.workspace-pane-title')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'P2: Windows 终端集成', exact: true })).toHaveAttribute('aria-pressed', 'true')
})
