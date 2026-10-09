import { expect, test, type Page, type Locator } from '@playwright/test'

test.beforeEach(({ page }) => { page.on('console', m => { if (m.type() === 'error') console.error(m.text()) }); page.on('pageerror', e => console.error(e.message)) })
test.use({ viewport: { width: 1600, height: 960 } })
const pane = (page: Page, id: number) => page.locator(`[data-pane-id][data-session-id="chat-${id}"]`)
const input = (root: Locator) => root.locator('[contenteditable]:not([contenteditable="false"])')
async function prefix(page: Page, key: string) { await page.keyboard.press('Control+b'); await page.keyboard.press(key) }
async function createWorkspace(page: Page) {
    await prefix(page, 'c')
    await expect(page.getByRole('dialog')).toHaveCount(0)
}
async function open(page: Page, search = '') {
    await page.goto('/e2e-fixtures/workspace-fixture.html?split' + search, { waitUntil: 'domcontentloaded' })
    await expect(pane(page, 1).locator('.hapi-native-thread')).toBeVisible()
    await expect(pane(page, 2).locator('.hapi-native-thread')).toBeVisible()
    await expect(pane(page, 1).getByText('chat-1 · 记录 320', { exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.unhandled)).toEqual([])
}
async function reading(root: Locator) {
    const viewport = root.locator('.chat-scroll-y')
    await viewport.hover(); await viewport.page().mouse.wheel(0, -1700)
    await expect(root.locator('[data-following-tail="false"]')).toBeVisible()
    // Wait for scroll inertia and the existing bookmark debounce.
    await viewport.page().waitForTimeout(450)
    return viewport.evaluate(e => {
        const top = e.getBoundingClientRect().top
        const row = [...e.querySelectorAll<HTMLElement>('[data-chat-node-key]')].find(r => r.getBoundingClientRect().bottom > top + 10)!
        return { key: row.dataset.chatNodeKey!, offset: row.getBoundingClientRect().top - top }
    })
}
async function assertAnchor(root: Locator, anchor: { key: string; offset: number }) {
    await expect.poll(() => root.locator('.chat-scroll-y').evaluate((e, a) => {
        const row = [...e.querySelectorAll<HTMLElement>('[data-chat-node-key]')].find(r => r.dataset.chatNodeKey === a.key)
        return row ? Math.abs(row.getBoundingClientRect().top - e.getBoundingClientRect().top - a.offset) : 9999
    }, anchor)).toBeLessThanOrEqual(2)
}

test('routes input, live updates, shortcuts and existing-session selection to their own pane', async ({ page }) => {
    await open(page)
    await input(pane(page, 1)).fill('Draft A stays here')
    await input(pane(page, 2)).fill('Send only to B')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.sends.map(s => [s.sessionId, s.text]))).toEqual([['chat-2', 'Send only to B']])
    await expect(input(pane(page, 1))).toHaveText('Draft A stays here')
    await page.evaluate(() => { window.__workspaceFixture.append('chat-1'); window.__workspaceFixture.append('chat-2') })
    await expect(pane(page, 1).getByText('LIVE chat-1 321', { exact: true })).toBeVisible()
    await expect(pane(page, 2).getByText('LIVE chat-2 322', { exact: true })).toBeVisible()
    await prefix(page, 'ArrowLeft')
    await expect(input(pane(page, 1))).toBeFocused()
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.connections().map(url => {
        const params = new URL(url).searchParams
        return params.has('all')
    }))).toEqual([true])
    const sidebar = page.locator('.app-session-sidebar-frame')
    const link = sidebar.getByText('历史阅读优化', { exact: true })
    await link.click()
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(2)
    await expect(pane(page, 1)).toHaveAttribute('data-focused', 'true')
})

test('keeps reading and drafts across workspace switches, temporary zoom and refresh', async ({ page }) => {
    await open(page)
    await input(pane(page, 1)).fill('Unsent workspace draft')
    const anchor = await reading(pane(page, 1))
    await createWorkspace(page)
    await expect(page.locator('.workspace-empty:visible')).toBeVisible()
    await prefix(page, 'p')
    await expect(input(pane(page, 1))).toHaveText('Unsent workspace draft')
    await assertAnchor(pane(page, 1), anchor)
    await prefix(page, 'z')
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1)
    await prefix(page, 'z')
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(2)
    await assertAnchor(pane(page, 1), anchor)
    await page.reload()
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(2)
    await expect(input(pane(page, 1))).toHaveText('Unsent workspace draft')
    await assertAnchor(pane(page, 1), anchor)
})

test('switches single/workspace without losing the saved layout or duplicating chats', async ({ page }) => {
    await open(page)
    await input(pane(page, 2)).fill('Unsent B')
    await page.getByRole('button', { name: 'Single conversation', exact: true }).click()
    await expect(page.locator('.workspace-shell')).toHaveCount(0)
    await expect(page.locator('[contenteditable]:not([contenteditable="false"])')).toHaveText('Unsent B')
    await page.getByRole('button', { name: 'View mode', exact: true }).click()
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(2)
    await expect(input(pane(page, 2))).toHaveText('Unsent B')
})

test('restores a rejected in-flight send after its pane was hidden without sending it again', async ({ page }) => {
    await open(page)
    await page.evaluate(() => window.__workspaceFixture.holdFailedSend())
    await input(pane(page, 1)).fill('Keep this failed draft')
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.sends.length)).toBe(1)
    await createWorkspace(page)
    await page.evaluate(() => window.__workspaceFixture.releaseFailedSend())
    await prefix(page, 'p')
    await expect(input(pane(page, 1))).toHaveText('Keep this failed draft')
    await expect(pane(page, 1).getByTestId('composer-send-error')).toBeVisible()
    expect(await page.evaluate(() => window.__workspaceFixture.sends.length)).toBe(1)
    await expect(input(pane(page, 2))).toBeEmpty()
})

test('projects one mobile pane without rewriting desktop layout or reacting to keyboard height', async ({ page }) => {
    await open(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1)
    const structure = () => page.evaluate(() => {
        const key = Object.keys(localStorage).find(k => k.startsWith('hapi:workspaces:v1:'))!
        return JSON.stringify(JSON.parse(localStorage.getItem(key)!).workspaces)
    })
    const before = await structure()
    await page.getByRole('button', { name: 'P1', exact: true }).click()
    await input(pane(page, 1)).fill('Mobile draft')
    const anchor = await reading(pane(page, 1))
    await page.getByRole('button', { name: 'P2', exact: true }).click()
    await page.getByRole('button', { name: 'P1', exact: true }).click()
    await assertAnchor(pane(page, 1), anchor)
    await expect(input(pane(page, 1))).toHaveText('Mobile draft')
    await page.setViewportSize({ width: 390, height: 500 })
    expect(await structure()).toBe(before)
    await page.setViewportSize({ width: 1600, height: 960 })
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(2)
    expect(await structure()).toBe(before)
})

test('resizes actual panes without remounting the visible editor', async ({ page }) => {
    await open(page)
    await input(pane(page, 1)).fill('Keep the mounted editor')
    await input(pane(page, 1)).evaluate(e => { (window as any).__originalEditor = e })
    const splitter = page.locator('.flexlayout__splitter').first()
    const box = (await splitter.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down(); await page.mouse.move(box.x + 110, box.y + box.height / 2, { steps: 8 }); await page.mouse.up()
    await expect.poll(() => input(pane(page, 1)).evaluate(e => e === (window as any).__originalEditor)).toBe(true)
    const width = (await pane(page, 1).boundingBox())!.width
    await page.reload()
    await expect(pane(page, 1)).toBeVisible()
    expect(Math.abs((await pane(page, 1).boundingBox())!.width - width)).toBeLessThan(2)
})

test('drags a pane to an edge while retaining its live editor', async ({ page }) => {
    await open(page)
    await input(pane(page, 2)).fill('Do not remount on drag')
    await input(pane(page, 2)).evaluate(e => { (window as any).__draggedEditor = e })
    const source = (await page.getByRole('tab').filter({ hasText: 'Windows 终端集成' }).boundingBox())!
    const target = (await pane(page, 1).boundingBox())!
    await page.mouse.move(source.x + 30, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(source.x + 20, source.y + 70, { steps: 5 })
    await page.mouse.move(target.x + target.width / 2, target.y + 8, { steps: 12 })
    await page.mouse.up()
    await expect.poll(() => pane(page, 2).evaluate(e => e.clientHeight)).toBeLessThan(650)
    expect(await input(pane(page, 2)).evaluate(e => e === (window as any).__draggedEditor)).toBe(true)
    await expect(input(pane(page, 2))).toHaveText('Do not remount on drag')
})

test('runs four chats and closes a pane as a view operation', async ({ page }) => {
    await open(page)
    await prefix(page, '"')
    const sidebar = page.locator('.app-session-sidebar-frame')
    await expect(sidebar.locator('input[type="search"]')).toBeFocused()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await sidebar.getByText('工作区交互设计', { exact: true }).click()
    await expect(pane(page, 3)).toBeVisible()
    await input(pane(page, 1)).click()
    await prefix(page, '"')
    await sidebar.getByText('发布检查', { exact: true }).click()
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(4)
    for (let i = 1; i <= 4; i++) {
        await input(pane(page, i)).fill(`Draft ${i}`)
        await page.evaluate(id => window.__workspaceFixture.append(`chat-${id}`), i)
        await expect(pane(page, i).getByText(`LIVE chat-${i} 321`, { exact: true })).toBeVisible()
    }
    expect(await page.evaluate(() => window.__workspaceFixture.connections().length)).toBe(1)
    await prefix(page, 'x')
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(3)
    for (let i = 1; i <= 3; i++) await expect(input(pane(page, i))).toHaveText(`Draft ${i}`)
    expect(await page.evaluate(() => window.__workspaceFixture.requests.filter(r => /abort|stop|DELETE/.test(r)))).toEqual([])
})

test('moves a live chat between workspaces, switches with the bottom wheel and restores a closed workspace', async ({ page }) => {
    await open(page)
    await input(pane(page, 1)).fill('Draft follows its conversation')
    await createWorkspace(page)
    await page.locator('.app-session-sidebar-frame').getByText('工作区交互设计', { exact: true }).click()
    await expect(pane(page, 3)).toBeVisible()
    await page.locator('.workspace-bottom').hover()
    await page.mouse.wheel(0, -120)
    await expect(pane(page, 1)).toBeVisible()
    await page.getByRole('button', { name: 'Pane actions', exact: true }).first().click()
    await page.getByRole('menuitem', { name: 'Move to Window 2', exact: true }).click()
    await expect(pane(page, 3)).toBeVisible()
    await expect(input(pane(page, 1))).toHaveText('Draft follows its conversation')
    await page.getByRole('button', { name: 'Window actions', exact: true }).click()
    await page.getByRole('button', { name: 'Close window', exact: true }).click()
    await expect(pane(page, 2)).toBeVisible()
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(input(pane(page, 1))).toHaveText('Draft follows its conversation')
    await expect(pane(page, 3)).toBeVisible()
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    expect(await page.evaluate(() => window.__workspaceFixture.requests.filter(r => /abort|stop|DELETE/.test(r)))).toEqual([])
})

test('keeps legacy history reading independent beside a native conversation', async ({ page }) => {
    await page.goto('/e2e-fixtures/workspace-fixture.html?split&mixed', { waitUntil: 'domcontentloaded' })
    await expect(pane(page, 1).locator('.hapi-native-thread')).toBeVisible()
    const legacy = pane(page, 2)
    await expect(legacy.locator('.happy-thread-messages')).toBeVisible()
    await expect(legacy.getByText('chat-2 · 记录 320', { exact: true })).toBeVisible()
    await input(legacy).fill('Legacy draft')
    const viewport = legacy.locator('.chat-scroll-y')
    await viewport.hover(); await page.mouse.wheel(0, -1700)
    await page.waitForTimeout(450)
    const anchor = await viewport.evaluate(e => {
        const top = e.getBoundingClientRect().top
        const row = [...e.querySelectorAll<HTMLElement>('[data-hapi-virtual-message]')].find(r => r.getBoundingClientRect().bottom > top + 10)!
        return { id: row.dataset.hapiVirtualMessage!, offset: row.getBoundingClientRect().top - top }
    })
    await createWorkspace(page); await prefix(page, 'p')
    await expect(input(legacy)).toHaveText('Legacy draft')
    await expect.poll(() => viewport.evaluate((e, a) => {
        const row = [...e.querySelectorAll<HTMLElement>('[data-hapi-virtual-message]')].find(r => r.dataset.hapiVirtualMessage === a.id)
        return row ? Math.abs(row.getBoundingClientRect().top - e.getBoundingClientRect().top - a.offset) : 9999
    }, anchor)).toBeLessThanOrEqual(2)
    await page.evaluate(() => window.__workspaceFixture.append('chat-1'))
    await expect(pane(page, 1).getByText('LIVE chat-1 321', { exact: true })).toBeVisible()
    await input(legacy).click(); await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.sends.map(s => [s.sessionId, s.text]))).toEqual([['chat-2', 'Legacy draft']])
})


test('matches the accepted compact workspace and keeps menus available on mobile', async ({ page }) => {
    await open(page)
    const composer = pane(page, 1).getByTestId('composer-shell')
    const height = (await composer.boundingBox())!.height
    expect(height).toBeLessThanOrEqual(64)
    expect(await composer.locator('.app-composer-surface').evaluate(e => getComputedStyle(e).borderRadius)).toBe('0px')
    const separators = await page.locator('.flexlayout__splitter').evaluateAll(rows => rows.map(e => {
        const r = e.getBoundingClientRect(); return Math.min(r.width, r.height)
    }))
    expect(separators.every(size => size <= 1)).toBe(true)
    await input(pane(page, 1)).fill('first line\nsecond line\nthird line')
    expect((await composer.boundingBox())!.height).toBeGreaterThan(height)
    await prefix(page, 'l')
    await expect(input(pane(page, 2))).toBeFocused()
    await prefix(page, 'h')
    await expect(input(pane(page, 1))).toBeFocused()
    await prefix(page, 'w')
    await expect(page.getByRole('dialog')).toContainText('Switch window')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Pane actions', exact: true }).first().click()
    await expect(page.getByRole('menuitem', { name: 'Move to new window', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Split below', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1)
    await page.getByRole('button', { name: 'P2', exact: true }).click()
    expect((await pane(page, 2).boundingBox())!.y).toBe(0)
    expect((await page.locator('.workspace-bottom').boundingBox())!.height).toBeLessThanOrEqual(36)
    await page.getByRole('button', { name: 'Pane actions', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Split below', exact: true })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Open a conversation', exact: true }).click()
    await expect(page.locator('.app-session-sidebar-frame')).toBeVisible()
    await expect(page.locator('.workspace-shell')).toBeHidden()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.unhandled)).toEqual([])
})

test('returns to the existing mobile session list and preserves drafts and reading when cancelling or focusing an open chat', async ({ page }) => {
    await open(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'P1', exact: true }).click()
    await input(pane(page, 1)).fill('Keep this mobile draft')
    const anchor = await reading(pane(page, 1))
    const layout = await page.evaluate(() => {
        const key = Object.keys(localStorage).find(k => k.startsWith('hapi:workspaces:v1:'))!
        return JSON.stringify(JSON.parse(localStorage.getItem(key)!).workspaces)
    })
    const back = page.getByRole('button', { name: 'Back to sessions', exact: true })
    const sidebar = page.locator('.app-session-sidebar-frame')
    await back.click()
    await expect(sidebar).toBeVisible()
    await expect(page.locator('.workspace-shell')).toBeHidden()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
    await expect(input(pane(page, 1))).toHaveText('Keep this mobile draft')
    await assertAnchor(pane(page, 1), anchor)
    await back.click()
    await sidebar.getByText('Windows 终端集成', { exact: true }).click()
    await expect(pane(page, 2)).toBeVisible()
    await page.getByRole('button', { name: 'P1', exact: true }).click()
    await expect(input(pane(page, 1))).toHaveText('Keep this mobile draft')
    await assertAnchor(pane(page, 1), anchor)
    expect(await page.evaluate(() => {
        const key = Object.keys(localStorage).find(k => k.startsWith('hapi:workspaces:v1:'))!
        return JSON.stringify(JSON.parse(localStorage.getItem(key)!).workspaces)
    })).toBe(layout)
    await page.setViewportSize({ width: 1600, height: 960 })
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(2)
    expect(await page.evaluate(() => window.__workspaceFixture.sends)).toEqual([])
})

test('uses the mobile list to replace only the focused pane and to fill a new split', async ({ page }) => {
    await open(page)
    await page.setViewportSize({ width: 390, height: 844 })
    const original = await pane(page, 2).getAttribute('data-pane-id')
    await page.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    const sidebar = page.locator('.app-session-sidebar-frame')
    await sidebar.getByText('工作区交互设计', { exact: true }).click()
    await expect(pane(page, 3)).toHaveAttribute('data-pane-id', original!)
    await expect(page.getByRole('button', { name: /^P\d$/, exact: true })).toHaveCount(2)
    await page.getByRole('button', { name: 'New pane', exact: true }).click()
    await expect(sidebar).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
    await expect(page.getByRole('button', { name: /^P\d$/, exact: true })).toHaveCount(3)
    // Reopening the picker from the new empty pane must not create another one.
    await page.getByRole('button', { name: 'New pane', exact: true }).click()
    await sidebar.getByText('发布检查', { exact: true }).click()
    await expect(pane(page, 4)).toBeVisible()
    await page.setViewportSize({ width: 1600, height: 960 })
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(3)
    await expect(pane(page, 1)).toBeVisible()
    await expect(pane(page, 3)).toHaveAttribute('data-pane-id', original!)
    expect(await page.evaluate(() => window.__workspaceFixture.requests.filter(r => /abort|stop|DELETE/.test(r)))).toEqual([])
})

test('shows each mobile session destination and updates its workspace name and pane number', async ({ page }) => {
    await open(page)
    await createWorkspace(page)
    await page.locator('.app-session-sidebar-frame').getByText('工作区交互设计', { exact: true }).click()
    await expect(pane(page, 3)).toBeVisible()
    const tabs = page.locator('.workspace-tabs')
    await tabs.getByTitle('Window 2', { exact: true }).dblclick()
    await tabs.getByRole('textbox').fill('Review workspace with a long name')
    await tabs.getByRole('textbox').press('Enter')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    const row = (title: string) => page.locator('.session-list-item').filter({ has: page.getByText(title, { exact: true }) })
    const location = (title: string) => row(title).locator('.app-session-workspace-location')
    await expect(location('历史阅读优化')).toHaveAttribute('title', 'Window 1 · P1')
    await expect(location('Windows 终端集成')).toHaveAttribute('title', 'Window 1 · P2')
    await expect(location('工作区交互设计')).toHaveAttribute('title', 'Review workspace with a long name · P1')
    await expect(location('发布检查')).toHaveCount(0)
    const lastPart = location('工作区交互设计').locator('span').last()
    expect((await lastPart.boundingBox())!.width).toBeGreaterThan(15)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await row('Windows 终端集成').click()
    await expect(pane(page, 2)).toBeVisible()
    await expect(page.getByRole('button', { name: 'P2', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'P1', exact: true }).click()
    await prefix(page, 'x')
    await expect(pane(page, 2)).toBeVisible()
    await page.getByRole('button', { name: 'Back to sessions', exact: true }).click()
    await expect(location('历史阅读优化')).toHaveCount(0)
    await expect(location('Windows 终端集成')).toHaveAttribute('title', 'Window 1 · P1')
    await page.reload()
    await expect(location('Windows 终端集成')).toHaveAttribute('title', 'Window 1 · P1')
    await expect(location('工作区交互设计')).toHaveAttribute('title', 'Review workspace with a long name · P1')
    expect(await page.evaluate(() => window.__workspaceFixture.unhandled)).toEqual([])
})

test('hands keyboard focus from the desktop pane menu to the existing sidebar search', async ({ page }) => {
    await open(page)
    await input(pane(page, 1)).fill('Keep the first pane draft')
    await page.getByRole('button', { name: 'Pane actions', exact: true }).first().click()
    await page.getByRole('menuitem', { name: 'Open a conversation', exact: true }).click()
    const search = page.locator('.app-session-sidebar-frame input[type="search"]')
    await expect(search).toBeFocused()
    await page.keyboard.insertText('工作区交互设计')
    await expect(search).toHaveValue('工作区交互设计')
    await page.locator('.app-session-sidebar-frame').getByText('工作区交互设计', { exact: true }).click()
    await expect(pane(page, 3)).toBeVisible()
    await expect(pane(page, 2)).toBeVisible()
    await expect(pane(page, 1)).toHaveCount(0)
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(2)
    await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('selects a conversation through the full list when a narrow desktop hides the sidebar', async ({ page }) => {
    await open(page)
    await page.setViewportSize({ width: 820, height: 960 })
    await expect(page.locator('.app-session-sidebar-frame')).toBeHidden()
    const original = await pane(page, 2).getAttribute('data-pane-id')
    await page.getByRole('button', { name: 'Pane actions', exact: true }).last().click()
    await page.getByRole('menuitem', { name: 'Open a conversation', exact: true }).click()
    await expect(page.locator('.app-session-sidebar-frame')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.locator('.app-session-sidebar-frame').getByText('工作区交互设计', { exact: true }).click()
    await expect(pane(page, 3)).toHaveAttribute('data-pane-id', original!)
    await expect(pane(page, 1)).toBeVisible()
    await expect(page.locator('.app-session-sidebar-frame')).toBeHidden()
})

for (const reload of [false, true]) test(`keeps an attachment with its originating chat when its upload completes in a hidden workspace${reload ? ' across reload' : ''}`, async ({ page }) => {
    await open(page)
    await input(pane(page, 2)).fill('Other pane draft')
    await input(pane(page, 1)).fill('Read this attached file')
    await page.evaluate(() => window.__workspaceFixture.holdUpload())
    const picker = page.waitForEvent('filechooser')
    await pane(page, 1).getByRole('button', { name: 'Attach file', exact: true }).click()
    await (await picker).setFiles({ name: 'workspace-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Attachment for the first conversation only.') })
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.uploads.length)).toBe(1)
    await expect(pane(page, 1).getByText('workspace-notes.txt', { exact: true })).toBeVisible()
    await expect(pane(page, 2).getByText('workspace-notes.txt', { exact: true })).toHaveCount(0)
    await createWorkspace(page)
    await page.evaluate(() => window.__workspaceFixture.finishUpload())
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.uploads[0].complete)).toBe(true)
    const uploadPath = await page.evaluate(() => window.__workspaceFixture.uploads[0].path)
    if (reload) {
        // Verify durable completion while the originating composer is absent.
        await expect.poll(() => page.evaluate(() => new Promise<string | undefined>((resolve, reject) => {
            const request = indexedDB.open('hapi-composer-drafts', 1)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => {
                const db = request.result
                const transaction = db.transaction('attachments', 'readonly')
                const draft = transaction.objectStore('attachments').get('chat-1')
                transaction.oncomplete = () => { resolve(draft.result?.files[0]?.path); db.close() }
                transaction.onerror = () => { reject(transaction.error); db.close() }
            }
        }))).toBe(uploadPath)
        await page.reload()
        await expect(page.locator('.workspace-empty:visible')).toBeVisible()
    }
    await prefix(page, 'p')
    await expect(input(pane(page, 1))).toHaveText('Read this attached file')
    await expect(pane(page, 1).getByText('workspace-notes.txt', { exact: true })).toBeVisible()
    await expect(input(pane(page, 2))).toHaveText('Other pane draft')
    await expect(pane(page, 2).getByRole('button', { name: 'Remove attachment', exact: true })).toHaveCount(0)
    await input(pane(page, 1)).click()
    await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.sends.length)).toBe(1)
    const sent = await page.evaluate(() => window.__workspaceFixture.sends[0])
    expect(sent.sessionId).toBe('chat-1')
    expect(sent.text).toBe('Read this attached file')
    expect((sent as any).attachments).toHaveLength(1)
    expect((sent as any).attachments[0].path).toBe(uploadPath)
    expect(await page.evaluate(() => window.__workspaceFixture.uploads.length)).toBe(reload ? 0 : 1)
    await expect(input(pane(page, 2))).toHaveText('Other pane draft')
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.unhandled)).toEqual([])
    await test.info().attach('upload-lifecycle.json', {
        body: JSON.stringify(await page.evaluate(() => ({ uploads: window.__workspaceFixture.uploads, sends: window.__workspaceFixture.sends })), null, 2),
        contentType: 'application/json',
    })
})

for (const cancel of [false, true]) test(`reuses a pending upload after reopening its workspace${cancel ? ' and cleans it up when removed' : ''}`, async ({ page }) => {
    await open(page)
    await input(pane(page, 1)).fill('Keep this draft')
    await page.evaluate(() => window.__workspaceFixture.holdUpload())
    const picker = page.waitForEvent('filechooser')
    await pane(page, 1).getByRole('button', { name: 'Attach file', exact: true }).click()
    await (await picker).setFiles({ name: 'pending-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Pending upload') })
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.uploads.length)).toBe(1)
    await createWorkspace(page)
    await prefix(page, 'p')
    await expect(pane(page, 1).getByText('pending-notes.txt', { exact: true })).toBeVisible()
    if (cancel) await pane(page, 1).getByRole('button', { name: 'Remove attachment', exact: true }).click()
    await page.evaluate(() => window.__workspaceFixture.finishUpload())
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.uploads.every(u => u.complete))).toBe(true)
    if (cancel) {
        await expect.poll(() => page.evaluate(() => window.__workspaceFixture.deletedUploads)).toEqual([
            { sessionId: 'chat-1', path: await page.evaluate(() => window.__workspaceFixture.uploads[0].path) },
        ])
        await expect(pane(page, 1).getByText('pending-notes.txt', { exact: true })).toHaveCount(0)
    } else {
        await input(pane(page, 1)).click()
        await page.keyboard.press('Enter')
        await expect.poll(() => page.evaluate(() => window.__workspaceFixture.sends.length)).toBe(1)
        const sent = await page.evaluate(() => window.__workspaceFixture.sends[0])
        expect((sent as any).attachments[0].path).toBe(await page.evaluate(() => window.__workspaceFixture.uploads[0].path))
    }
    expect(await page.evaluate(() => window.__workspaceFixture.uploads.length)).toBe(1)
    await createWorkspace(page)
    await prefix(page, 'p')
    await expect(pane(page, 1).getByRole('button', { name: 'Remove attachment', exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => window.__workspaceFixture.sends.length)).toBe(cancel ? 0 : 1)
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.unhandled)).toEqual([])
})

test('edits goals for the initiating pane without disturbing either chat draft', async ({ page }) => {
    await open(page, '&controls')
    await input(pane(page, 1)).fill('First chat stays a message')
    await input(pane(page, 2)).fill('Second chat stays a message')
    await pane(page, 1).getByRole('button', { name: 'Goal controls', exact: true }).click()
    await page.getByRole('button', { name: 'Set a goal', exact: true }).click()
    await page.getByRole('textbox', { name: 'Goal', exact: true }).fill('Finish the first conversation task')
    await page.getByRole('button', { name: 'Save goal', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.goals)).toEqual([{ sessionId: 'chat-1', action: 'set', objective: 'Finish the first conversation task' }])
    await pane(page, 2).getByRole('button', { name: 'Goal controls', exact: true }).click()
    await page.getByRole('button', { name: 'Set a goal', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Goal', exact: true })).toBeEmpty()
    await page.getByRole('textbox', { name: 'Goal', exact: true }).fill('Do not save this second goal')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await createWorkspace(page)
    await prefix(page, 'p')
    await expect(input(pane(page, 1))).toHaveText('First chat stays a message')
    await expect(input(pane(page, 2))).toHaveText('Second chat stays a message')
    await pane(page, 1).getByRole('button', { name: 'Goal controls', exact: true }).click()
    await expect(page.getByText('Finish the first conversation task', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.__workspaceFixture.goals.length)).toBe(1)
    expect(await page.evaluate(() => window.__workspaceFixture.sends)).toEqual([])
})

for (const warmCount of [2, 5]) test(`returns among ${warmCount} warm workspaces without rebuilding readers and editors while history is held`, async ({ page }) => {
    await page.goto('/e2e-fixtures/workspace-fixture.html?panes=1&workingSet=7&rich', { waitUntil: 'domcontentloaded' })
    const samples: { ms: number; skeletonFrames: number; blankFrames: number; sameReader: boolean; sameComposer: boolean; sameCode: boolean }[] = []
    for (let id = 1; id <= warmCount; id++) {
        await page.locator(`.workspace-tabs button[title="Window ${id}"]`).click()
        await expect(pane(page, id).locator('[data-chat-presented=true]')).toBeVisible()
        await expect(pane(page, id).locator('.cm-editor')).toBeVisible()
        await input(pane(page, id)).fill(`Hot draft ${id}`)
        await page.evaluate(id => {
            const root = document.querySelector(`[data-pane-id][data-session-id="chat-${id}"]`)!
            const saved = ((window as any).__warmViews ??= {})
            saved[id] = { reader: root.querySelector('.chat-scroll-y'), composer: root.querySelector('[contenteditable]:not([contenteditable="false"]), textarea'), code: root.querySelector('.cm-editor') }
        }, id)
    }
    await page.evaluate(() => window.__workspaceFixture.holdHistory())
    for (let i = 0; i < Math.max(12, warmCount * 3); i++) {
        const id = i % warmCount + 1
        const sample = await page.evaluate(async id => {
            const button = document.querySelector<HTMLButtonElement>(`.workspace-tabs button[title="Window ${id}"]`)!
            const started = performance.now()
            button.click()
            let skeletonFrames = 0, blankFrames = 0
            return await new Promise<{ ms: number; skeletonFrames: number; blankFrames: number; sameReader: boolean; sameComposer: boolean; sameCode: boolean }>(resolve => {
                function tick() {
                    const stage = document.querySelector('[data-workspace-visible=true]')!
                    if (stage.querySelector('[data-chat-opening]')) skeletonFrames++
                    const root = stage.querySelector(`[data-pane-id][data-session-id="chat-${id}"]`)
                    const ready = root?.querySelector('[data-chat-presented=true]')
                    if (!ready) blankFrames++
                    const ms = performance.now() - started
                    if (!ready && ms < 2000) { requestAnimationFrame(tick); return }
                    const saved = (window as any).__warmViews[id]
                    resolve({ ms, skeletonFrames, blankFrames, sameReader: !!saved.reader && saved.reader === root?.querySelector('.chat-scroll-y'), sameComposer: !!saved.composer && saved.composer === root?.querySelector('[contenteditable]:not([contenteditable="false"]), textarea'), sameCode: !!saved.code && saved.code === root?.querySelector('.cm-editor') })
                }
                requestAnimationFrame(tick)
            })
        }, id)
        samples.push(sample)
        expect(sample.skeletonFrames).toBe(0)
        expect(sample.blankFrames).toBe(0)
        expect(sample.sameReader && sample.sameComposer && sample.sameCode).toBe(true)
        await expect(input(pane(page, id))).toHaveText(`Hot draft ${id}`)
    }
    // First-frame content and DOM identity are deterministic gates. Keep wall
    // time as benchmark evidence; it also includes scheduling on the test host.
    console.log('WARM_SWITCH', JSON.stringify(samples))
    await page.evaluate(() => window.__workspaceFixture.releaseHistory())
    for (let id = warmCount + 1; id <= 7; id++) {
        await page.locator(`.workspace-tabs button[title="Window ${id}"]`).click()
        await expect(pane(page, id).locator('[data-chat-presented=true]')).toBeVisible()
        await expect(page.locator('.workspace-stage')).toHaveCount(Math.min(5, id))
    }
    await expect(pane(page, 1)).toHaveCount(0)
    expect(await page.evaluate(() => window.__workspaceFixture.sends)).toEqual([])
})
