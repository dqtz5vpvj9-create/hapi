import { expect, test } from '@playwright/test'
import type { NativeReplayStatus } from '../web/e2e-fixtures/native-chat-replay'

test('settles a native answer in place and leaves it mounted while the completed process opens and closes', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/e2e-fixtures/history-load-fixture.html?nativeChat=1&nativeReplay=inProgress')
    const answer = page.getByText('The review is underway.', { exact: true })
    await expect(answer).toBeInViewport()
    await answer.evaluate(node => { (window as any).__answerSeat = node.closest('[data-chat-node-key]') })
    await page.evaluate(() => window.__nativeReplay.apply('completed'))
    const final = page.getByText('The native chat upgrade is ready for verification.', { exact: true })
    await expect(final).toBeVisible()
    expect(await final.evaluate(node => node.closest('[data-chat-node-key]') === (window as any).__answerSeat)).toBe(true)
    const process = page.locator('[data-chat-node-key] > button.hapi-native-process')
    await expect(process).toHaveCount(1)
    await expect(process).toHaveAttribute('aria-expanded', 'false')
    await process.click()
    await expect(process).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByText('Checking the affected files.', { exact: true })).toBeVisible()
    expect(await final.evaluate(node => node.closest('[data-chat-node-key]') === (window as any).__answerSeat)).toBe(true)
    await process.click()
    await expect(final).toBeVisible()
    expect(errors).toEqual([])
})

for (const status of ['interrupted', 'failed', 'no-answer', 'unknown'] as NativeReplayStatus[]) {
    test(`keeps ${status} native content flat and its diagnostics reachable`, async ({ page }) => {
        await page.goto(`/e2e-fixtures/history-load-fixture.html?nativeChat=1&nativeReplay=${status}`)
        await expect(page.getByText('Checking the affected files.', { exact: true })).toBeVisible()
        await expect(page.locator('[data-chat-node-key] > button.hapi-native-process')).toHaveCount(0)
        if (status === 'failed') await expect(page.getByText('Codex error: replayed upstream rejection', { exact: true })).toBeVisible()
        if (status === 'interrupted') await expect(page.getByText('Aborted by user', { exact: true })).toBeVisible()
    })
}

test('restores a saved reading point inside an expanded native process after reload', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 600 })
    await page.goto('/e2e-fixtures/history-load-fixture.html?nativeChat=1&nativeReplay=completed&longProcess=1')
    const process = page.locator('[data-chat-node-key] > button.hapi-native-process')
    await expect(process).toBeVisible()
    await process.click()
    const text = page.getByText('Checking the affected files.', { exact: true })
    await text.evaluate(element => {
        const viewport = document.querySelector('.chat-scroll-y')!
        viewport.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 20
        viewport.dispatchEvent(new Event('scroll'))
        viewport.dispatchEvent(new Event('scrollend'))
        window.dispatchEvent(new Event('pagehide'))
    })
    const before = await text.evaluate(element => element.getBoundingClientRect().top)
    await page.reload()
    await expect(page.getByText('Checking the affected files.', { exact: true })).toBeVisible()
    await expect.poll(async () => Math.abs((await page.getByText('Checking the affected files.', { exact: true }).evaluate(element => element.getBoundingClientRect().top)) - before)).toBeLessThanOrEqual(1)
})

test('restores the source position inside a virtualized native code answer after reload', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/e2e-fixtures/history-load-fixture.html?nativeChat=1&nativeReplay=completed&largeCode=1')
    await expect(page.locator('[data-hapi-large-code]')).toBeVisible()
    await page.locator('.chat-scroll-y').evaluate(element => {
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        element.scrollTop -= 13000
        element.dispatchEvent(new Event('scroll'))
    })
    await expect.poll(() => page.evaluate(() => Boolean(window.__readingAnchorTasks.capture()?.code))).toBe(true)
    await page.locator('.chat-scroll-y').evaluate(element => element.dispatchEvent(new Event('scrollend')))
    const anchor = await page.evaluate(() => window.__readingAnchorTasks.capture())
    const point = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor!), anchor)
    expect(anchor!.code!.position).toBeGreaterThan(20000)
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
    await page.reload()
    await expect(page.locator('[data-hapi-large-code]')).toBeVisible()
    await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor!), anchor)).toBeCloseTo(point!, 0)
    const first = await page.evaluate(() => window.__readingAnchorTasks.capture())
    await page.waitForTimeout(600)
    const settled = await page.evaluate(() => window.__readingAnchorTasks.capture())
    expect(settled?.code?.position).toBe(first?.code?.position)
    expect(await page.locator('.cm-line').count()).toBeLessThan(150)
    expect(errors).toEqual([])
})

test('keeps a pending native question and its focused draft while the surrounding turn settles', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/e2e-fixtures/history-load-fixture.html?nativeChat=1&nativeReplay=inProgress&question=1')
    await expect(page.getByText('Which change should be applied?', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /Proceed.*Apply the reviewed change/ }).click()
    const note = page.getByRole('textbox')
    await note.fill('Keep the same native request identity.')
    await note.evaluate(element => { (window as any).__questionInput = element })
    await page.evaluate(() => window.__nativeReplay.apply('completed'))
    await expect(note).toHaveValue('Keep the same native request identity.')
    await expect(note).toBeFocused()
    expect(await note.evaluate(element => element === (window as any).__questionInput)).toBe(true)
    await page.getByRole('button', { name: /Submit/i }).click()
    await expect.poll(() => page.evaluate(() => window.__probe.answers)).toEqual([{
        session: 'history-load-fixture', request: 'native-question', answers: { answers: { review: { answers: ['Proceed', 'user_note: Keep the same native request identity.'] } } },
    }])
})

test('native tool seats retain compact headers when a process is expanded', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/e2e-fixtures/history-load-fixture.html?nativeChat=1&nativeReplay=completed')
    const process = page.locator('.hapi-native-process').first()
    await process.click()
    for (const group of await page.locator('.hapi-native-process[aria-expanded="false"]').all()) await group.click()
    const tools = page.locator('[data-native-tool-row="true"] [data-hapi-tool-message]')
    await expect(tools).toHaveCount(2)
    for (const tool of await tools.all()) {
        await expect(tool).toBeVisible()
        expect((await tool.boundingBox())!.height).toBeLessThanOrEqual(32)
    }
    await tools.first().getByRole('button').first().click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect((await tools.first().boundingBox())!.height).toBeLessThanOrEqual(32)
})
