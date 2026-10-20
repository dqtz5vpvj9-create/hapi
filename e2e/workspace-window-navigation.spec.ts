import { expect, test, type Page } from '@playwright/test'

async function prefix(page: Page, key: string) {
    await page.keyboard.press('Control+b')
    await page.keyboard.press(key)
}
const activeWindow = (page: Page) => page.locator('.workspace-tabs .workspace-tab > button[aria-current="page"]')

test('allows navigation beside feature tips but respects modal dialogs', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/e2e-fixtures/workspace-fixture.html?split&unseenFeatures')
    const tip = page.getByRole('dialog', { name: 'New: @mention another session', exact: true })
    await expect(tip).toBeVisible()
    await page.locator('[data-testid="rich-composer-input"]:visible').last().focus()
    await prefix(page, 'w')
    const switcher = page.locator('.workspace-dialog')
    await expect(switcher.getByRole('heading', { name: 'Switch window', exact: true })).toBeVisible()
    await prefix(page, 'c')
    await expect(page.locator('.workspace-tab')).toHaveCount(1)
    await switcher.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(switcher).toHaveCount(0)
    await page.locator('[data-testid="rich-composer-input"]:visible').last().focus()
    await prefix(page, 'c')
    await expect(page.locator('.workspace-tab')).toHaveCount(2)
    await expect(page.locator('.app-session-sidebar-frame input[type="search"]')).toBeFocused()
})

for (const width of [390, 1440]) test(`creates a window without naming, chooses a chat and keeps pane creation separate at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/e2e-fixtures/workspace-fixture.html?split')
    await expect(page.locator('[data-chat-presented="true"]:visible').first()).toBeVisible()
    await expect(activeWindow(page)).toHaveAttribute('aria-label', '1: Windows 终端集成')
    await prefix(page, 'c')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const sidebar = page.locator('.app-session-sidebar-frame')
    await expect(sidebar).toBeVisible()
    if (width > 640) await expect(sidebar.locator('input[type="search"]')).toBeFocused()
    await sidebar.getByText('工作区交互设计', { exact: true }).click()
    await expect(page.locator('[data-pane-id][data-session-id="chat-3"]')).toBeVisible()
    await expect(page.locator('.workspace-tab')).toHaveCount(2)
    await expect(activeWindow(page)).toHaveAttribute('aria-label', '2: 工作区交互设计')
    // Adding a pane does not create another window or route through a new selector.
    await page.getByRole('button', { name: 'New pane', exact: true }).first().click()
    await expect(sidebar).toBeVisible()
    await sidebar.getByText('发布检查', { exact: true }).click()
    await expect(page.locator('[data-pane-id][data-session-id="chat-4"]')).toBeVisible()
    await expect(page.locator('.workspace-tab')).toHaveCount(2)
    // The new pane takes focus, so the window label follows it.
    await expect(activeWindow(page)).toHaveAttribute('aria-label', '2: 发布检查')
    await prefix(page, 'w')
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Switch window', exact: true })).toBeVisible()
    await expect(dialog.locator('.workspace-picker button')).toHaveCount(2)
    await expect(dialog.locator('.workspace-picker button').first()).toContainText('1 · Windows 终端集成')
    await dialog.locator('.workspace-picker button').first().click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(activeWindow(page)).toHaveAttribute('aria-label', '1: Windows 终端集成')
    await expect(page.locator('[data-chat-presented="true"]:visible').first()).toBeVisible()
    expect(await page.evaluate(() => window.__workspaceFixture.sends)).toEqual([])
})

for (const [width, appearance] of [[320, 'light'], [1440, 'dark']] as const) test(`keeps the Chinese window switcher readable at ${width}px in ${appearance}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 700 })
    await page.addInitScript(() => localStorage.setItem('hapi-lang', 'zh-CN'))
    await page.goto(`/e2e-fixtures/workspace-fixture.html?split&appearance=${appearance}`)
    await expect(page.locator('[data-chat-presented="true"]:visible').first()).toBeVisible()
    await prefix(page, 'w')
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: '切换窗口', exact: true })).toBeVisible()
    await expect(dialog).not.toContainText('common.')
    const close = (await dialog.getByRole('button', { name: '关闭', exact: true }).boundingBox())!
    const row = (await dialog.locator('.workspace-picker button').first().boundingBox())!
    const heading = (await dialog.getByRole('heading').boundingBox())!
    expect(row.y).toBeGreaterThanOrEqual(close.y + close.height + 8)
    expect(row.y).toBeGreaterThanOrEqual(heading.y + heading.height + 12)
    expect(row.height).toBeGreaterThanOrEqual(44)
    expect(row.x + row.width).toBeLessThanOrEqual(width - 12)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    // The menu and keyboard share the same immediate creation flow.
    await page.getByRole('button', { name: '窗口操作', exact: true }).click()
    await page.getByRole('button', { name: '新建窗口', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('.workspace-tab')).toHaveCount(2, { timeout: 15_000 })
    await page.locator('.app-session-sidebar-frame').getByText('工作区交互设计', { exact: true }).click()
    await expect(activeWindow(page)).toHaveAttribute('aria-label', '2: 工作区交互设计', { timeout: 15_000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.reload()
    await expect(activeWindow(page)).toHaveAttribute('aria-label', '2: 工作区交互设计', { timeout: 15_000 })
    await expect(page.locator('[data-pane-id][data-session-id="chat-3"]')).toBeVisible()
})

test('scrolls the current window into view when the list overflows', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/e2e-fixtures/workspace-fixture.html?split')
    await expect(page.locator('[data-chat-presented="true"]:visible').first()).toBeVisible()
    const sidebar = page.locator('.app-session-sidebar-frame')
    for (const [index, title] of ['工作区交互设计', '发布检查'].entries()) {
        await prefix(page, 'c')
        await expect(page.locator('.workspace-tab')).toHaveCount(index + 2)
        await sidebar.getByText(title, { exact: true }).click()
        await expect(page.locator('.workspace-tab')).toHaveCount(index + 2)
    }
    // Same layout opened on a phone: the third, current window must be scrolled into view.
    await page.setViewportSize({ width: 390, height: 844 })
    const tabs = page.locator('.workspace-tabs')
    await expect(tabs.locator('.workspace-tab')).toHaveCount(3, { timeout: 15_000 })
    await expect(tabs.locator('.workspace-tab > button[aria-current="page"]')).toHaveAttribute('aria-label', '3: 发布检查', { timeout: 15_000 })
    const strip = (await tabs.boundingBox())!
    const active = (await activeWindow(page).boundingBox())!
    expect(active.x).toBeGreaterThanOrEqual(strip.x - 1)
    expect(active.x + active.width).toBeLessThanOrEqual(strip.x + strip.width + 1)
    await expect.poll(() => tabs.evaluate(e => e.scrollLeft), { timeout: 10_000 }).toBeGreaterThan(0)
    // Renaming only changes the alias shown by Move to; the tab keeps the session label.
    await page.getByRole('button', { name: 'Window actions', exact: true }).click()
    await page.getByRole('button', { name: 'Edit window alias', exact: true }).click()
    const alias = page.getByRole('textbox', { name: 'Edit window alias', exact: true })
    await alias.fill('Release checks')
    await alias.press('Enter')
    await expect(activeWindow(page)).toHaveAttribute('aria-label', '3: 发布检查')
    await expect(activeWindow(page)).toHaveAttribute('title', 'Release checks · 发布检查')
})
