import { expect, test, type Page } from '@playwright/test'

async function expectActionInViewport(page: Page) {
    const action = page.getByRole('button', { name: /Connect and open|连接并打开|Import$/ })
    await expect(action).toBeEnabled()
    const geometry = await action.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const viewport = window.visualViewport!
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
            visibleTop: viewport.offsetTop, visibleBottom: viewport.offsetTop + viewport.height,
            visibleRight: viewport.width, reachable: !!hit && element.contains(hit) }
    })
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.visibleTop)
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.visibleBottom)
    expect(geometry.left).toBeGreaterThanOrEqual(0)
    expect(geometry.right).toBeLessThanOrEqual(geometry.visibleRight)
    expect(geometry.reachable).toBe(true)
    return action
}

for (const scenario of [
    { name: 'mobile', width: 390, height: 844, query: '' },
    { name: 'small phone', width: 320, height: 568, query: '' },
    { name: 'landscape', width: 844, height: 390, query: '' },
    { name: 'large text', width: 390, height: 844, query: 'font=24&lang=zh-CN' },
    { name: 'small phone with large English text', width: 320, height: 568, query: 'font=24' },
    { name: 'default theme', width: 390, height: 844, query: 'theme=default' },
    { name: 'desktop', width: 1440, height: 900, query: '' },
    { name: 'import', width: 390, height: 844, query: 'mode=import' },
]) {
    test(`selected session action remains reachable: ${scenario.name}`, async ({ page }) => {
        await page.setViewportSize({ width: scenario.width, height: scenario.height })
        await page.goto(`/e2e-fixtures/codex-session-dialog-fixture.html?${scenario.query}`)
        const action = await expectActionInViewport(page)
        const scroll = page.getByTestId('codex-session-scroll')
        await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
        await expect(page.getByRole(scenario.name === 'import' ? 'checkbox' : 'radio')).toHaveCount(60)
        await expectActionInViewport(page)
        await scroll.evaluate(element => { element.scrollTop = 0 })
        await expectActionInViewport(page)
        await action.focus()
        await page.keyboard.press('Enter')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(page.getByTestId('confirmed-session-ids')).toHaveText('native-thread-1')
    })
}

for (const theme of ['codex', 'default']) {
    test(`keyboard viewport keeps actions above the keyboard: ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto(`/e2e-fixtures/codex-session-dialog-fixture.html?theme=${theme}`)
        await expectActionInViewport(page)
        await page.getByRole('searchbox').focus()
        await page.evaluate(() => {
            Object.defineProperties(window.visualViewport!, {
                height: { configurable: true, value: 390 },
                offsetTop: { configurable: true, value: 90 },
            })
            window.visualViewport!.dispatchEvent(new Event('resize'))
            window.visualViewport!.dispatchEvent(new Event('scroll'))
        })
        await expectActionInViewport(page)
        await page.getByRole('button', { name: 'Connect and open' }).click()
        await expect(page.getByTestId('confirmed-session-ids')).toHaveText('native-thread-1')
    })
}

test('the fixed actions respect asymmetric safe-area margins', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/e2e-fixtures/codex-session-dialog-fixture.html')
    const dialog = page.getByRole('dialog')
    await expectActionInViewport(page)
    await dialog.evaluate(element => {
        element.style.setProperty('--dialog-top-margin', '44px')
        element.style.setProperty('--dialog-bottom-margin', '20px')
    })
    const rect = await dialog.boundingBox()
    expect(rect!.y).toBeGreaterThanOrEqual(44)
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(824)
    await expectActionInViewport(page)
})
