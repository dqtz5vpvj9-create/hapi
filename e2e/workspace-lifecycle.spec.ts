import { expect, test, type Page } from '@playwright/test'
import type { ReadingAnchor } from '../web/src/lib/reading-anchor'

test.use({ viewport: { width: 1600, height: 960 } })
const pane = (page: Page, id: number) => page.locator(`[data-pane-id][data-session-id="chat-${id}"]`)
const editor = (page: Page, id: number) => pane(page, id).locator('[contenteditable]:not([contenteditable="false"])')
const workspace = (page: Page, id: number) => page.locator(`.workspace-tabs button[title="Window ${id}"]`)

for (const size of [2, 4]) test(`bounds the resident cost of ${size}-pane workspaces and keeps the previous layout warm`, async ({ page }) => {
    await page.goto(`/e2e-fixtures/workspace-fixture.html?panes=${size}&workingSet=12&grouped`, { waitUntil: 'domcontentloaded' })
    const residentLimit = size === 2 ? 3 : 2
    for (let id = 1; id <= 12 / size; id++) {
        await workspace(page, id).click()
        await expect(page.locator('[data-workspace-visible=true] [data-chat-presented=true]')).toHaveCount(size)
        await expect(page.locator('.workspace-stage')).toHaveCount(Math.min(id, residentLimit))
        await expect(page.locator('[data-pane-id]')).toHaveCount(Math.min(id, residentLimit) * size)
    }
    await expect(pane(page, 1)).toHaveCount(0)
    const last = 12 / size
    await page.evaluate(() => window.__workspaceFixture.holdHistory())
    for (const id of [last - 1, last, last - 1]) {
        await workspace(page, id).click()
        await expect(page.locator('[data-workspace-visible=true] [data-chat-presented=true]')).toHaveCount(size)
        await expect(page.locator('[data-chat-opening]:visible')).toHaveCount(0)
    }
    await page.evaluate(() => window.__workspaceFixture.releaseHistory())
    // Mobile shows one reader but reserves all panes in each retained layout,
    // so repeatedly opening phone panes cannot bypass the resident budget.
    await page.setViewportSize({ width: 390, height: 844 })
    for (let id = 1; id <= last; id++) {
        await workspace(page, id).click()
        await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1)
    }
    await expect(page.locator('.workspace-stage')).toHaveCount(residentLimit)
    await page.setViewportSize({ width: 1600, height: 960 })
    await expect(page.locator('.workspace-stage')).toHaveCount(residentLimit)
    await expect(page.locator('[data-pane-id]')).toHaveCount(residentLimit * size)
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(size)
    expect(await page.evaluate(() => window.__workspaceFixture.sends)).toEqual([])
    expect(await page.evaluate(() => window.__workspaceFixture.unhandled)).toEqual([])
})

test('restores reading and drafts after visiting more workspaces than the presentation and history caches hold', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/e2e-fixtures/workspace-fixture.html?panes=1&workingSet', { waitUntil: 'domcontentloaded' })
    await expect(pane(page, 1).getByText('chat-1 · 记录 320', { exact: true })).toBeVisible()
    await editor(page, 1).fill('Retain this draft beyond the working-set cache')
    const viewport = pane(page, 1).locator('.chat-scroll-y')
    await viewport.hover(); await page.mouse.wheel(0, -1700)
    await expect(pane(page, 1).locator('[data-following-tail=false]')).toBeVisible()
    await page.waitForTimeout(500)
    const anchor = await viewport.evaluate(element => {
        const top = element.getBoundingClientRect().top
        const row = [...element.querySelectorAll<HTMLElement>('[data-chat-node-key]')].find(row => row.getBoundingClientRect().bottom > top + 10)!
        return { key: row.dataset.chatNodeKey!, top: row.getBoundingClientRect().top - top }
    })
    for (let id = 2; id <= 12; id++) {
        await workspace(page, id).click()
        await expect(pane(page, id).getByText(`chat-${id} · 记录 320`, { exact: true })).toBeVisible()
        await editor(page, id).fill(`Draft owned by chat-${id}`)
        await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1)
        // At most five single-pane views; every reader still virtualizes its rows.
        const residents = page.locator('.workspace-stage')
        expect(await residents.count()).toBeLessThanOrEqual(5)
        for (const resident of await residents.all()) {
            expect(await resident.locator('[data-chat-node-key]').count()).toBeLessThan(25)
        }
    }
    const windows = await page.evaluate(() => window.__workspaceFixture.messageWindows())
    expect(windows.filter(window => window.rows > 0)).toHaveLength(5)
    expect(windows.find(window => window.id === 'chat-1')!.rows).toBe(0)
    await workspace(page, 1).click()
    await expect(editor(page, 1)).toHaveText('Retain this draft beyond the working-set cache')
    await expect(pane(page, 1).locator('[data-chat-presented=true]')).toBeVisible()
    await expect.poll(() => viewport.evaluate((element, saved) => {
        const row = [...element.querySelectorAll<HTMLElement>('[data-chat-node-key]')].find(row => row.dataset.chatNodeKey === saved.key)
        return row ? Math.abs(row.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.top) : Infinity
    }, anchor)).toBeLessThanOrEqual(2)
    await page.reload()
    await expect(editor(page, 1)).toHaveText('Retain this draft beyond the working-set cache')
    await expect(pane(page, 1).locator('[data-chat-presented=true]')).toBeVisible()
    for (const id of [12, 6, 2]) {
        await workspace(page, id).click()
        await expect(editor(page, id)).toHaveText(`Draft owned by chat-${id}`)
    }
    expect(await page.evaluate(() => window.__workspaceFixture.unhandled)).toEqual([])
    expect(await page.evaluate(() => window.__workspaceFixture.sends)).toEqual([])
    expect(errors).toEqual([])
})

test('keeps independent source positions when four long code answers are resized, projected to mobile and reopened', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/e2e-fixtures/workspace-fixture.html?panes=4&rich', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-chat-presented=true]')).toHaveCount(4)
    for (let id = 1; id <= 4; id++) await expect(pane(page, id).locator('[data-hapi-large-code]')).toBeVisible()
    const readers = new Map<number, { anchor: ReadingAnchor; top: number }>()
    for (let id = 1; id <= 4; id++) {
        await editor(page, id).fill(`Draft stays with code reader ${id}`)
        await pane(page, id).locator('.chat-scroll-y').evaluate((element, distance) => {
            element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
            element.scrollTop -= distance
            element.dispatchEvent(new Event('scroll'))
        }, 13000 + id * 1000)
        await expect.poll(() => page.evaluate(id => Boolean(window.__workspaceFixture.captureReading(`chat-${id}`)?.code), id)).toBe(true)
        await pane(page, id).locator('.chat-scroll-y').evaluate(element => element.dispatchEvent(new Event('scrollend')))
        const anchor = await page.evaluate(id => window.__workspaceFixture.captureReading(`chat-${id}`), id)
        expect(anchor!.code!.position).toBeGreaterThan(20000)
        const top = await page.evaluate(({ id, anchor }) => window.__workspaceFixture.codePoint(`chat-${id}`, anchor), { id, anchor: anchor! })
        expect(top).not.toBeNull()
        readers.set(id, { anchor: anchor!, top: top! })
    }
    // Resizing changes the hit-test column. Observe the same source character,
    // rather than requiring a new capture at a different width to pick it again.
    const position = (id: number) => page.evaluate(({ id, anchor }) => window.__workspaceFixture.codePoint(`chat-${id}`, anchor), { id, anchor: readers.get(id)!.anchor })
    await editor(page, 1).click()
    await page.keyboard.press('Control+b'); await page.keyboard.press('z')
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1)
    await expect.poll(() => position(1)).toBeCloseTo(readers.get(1)!.top, 0)
    await page.keyboard.press('Control+b'); await page.keyboard.press('z')
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(4)
    for (const [id, reader] of readers) await expect.poll(() => position(id)).toBeCloseTo(reader.top, 0)
    await page.setViewportSize({ width: 390, height: 844 })
    for (const [number, id] of [[1, 1], [2, 3], [3, 2], [4, 4], [1, 1]]) {
        await page.getByRole('button', { name: `P${number}`, exact: true }).click()
        await expect(pane(page, id).locator('[data-chat-presented=true]')).toBeVisible()
        await expect.poll(() => position(id)).toBeCloseTo(readers.get(id)!.top, 0)
        await expect(editor(page, id)).toHaveText(`Draft stays with code reader ${id}`)
    }
    // Returning to a phone pane retains its reader; each code viewport must
    // still virtualize instead of mounting the entire source document.
    for (let id = 1; id <= 4; id++) {
        expect(await pane(page, id).locator('.cm-line').count()).toBeLessThan(150)
    }
    await page.reload()
    await expect(pane(page, 1).locator('[data-chat-presented=true]')).toBeVisible()
    await expect.poll(() => position(1)).toBeCloseTo(readers.get(1)!.top, 0)
    expect(await page.evaluate(() => window.__workspaceFixture.unhandled)).toEqual([])
    expect(await page.evaluate(() => window.__workspaceFixture.sends)).toEqual([])
    expect(errors).toEqual([])
})

test('releases unmounted chat DOM while retaining its code bookmark', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Garbage collection requires the Chromium CDP test boundary')
    await page.goto('/e2e-fixtures/workspace-fixture.html?panes=1&workingSet&rich', { waitUntil: 'domcontentloaded' })
    await expect(pane(page, 1).locator('[data-chat-presented=true]')).toBeVisible()
    await expect(pane(page, 1).locator('[data-hapi-large-code]')).toBeVisible()
    await pane(page, 1).locator('.chat-scroll-y').evaluate(element => {
        ;(window as Window & { detachedReader?: WeakRef<Element> }).detachedReader = new WeakRef(element)
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        element.scrollTop -= 15000
        element.dispatchEvent(new Event('scroll'))
    })
    await expect.poll(() => page.evaluate(() => Boolean(window.__workspaceFixture.captureReading('chat-1')?.code))).toBe(true)
    await pane(page, 1).locator('.chat-scroll-y').evaluate(element => element.dispatchEvent(new Event('scrollend')))
    const anchor = await page.evaluate(() => window.__workspaceFixture.captureReading('chat-1'))
    const top = await page.evaluate(anchor => window.__workspaceFixture.codePoint('chat-1', anchor!), anchor)
    for (let id = 2; id <= 12; id++) {
        await workspace(page, id).click()
        await expect(pane(page, id).locator('[data-chat-presented=true]')).toBeVisible()
    }
    const client = await page.context().newCDPSession(page)
    await client.send('HeapProfiler.collectGarbage')
    const collected = await page.evaluate(() => !(window as Window & { detachedReader?: WeakRef<Element> }).detachedReader?.deref())
    await client.detach()
    expect(collected, 'The old pane must be collectable without a route change or discarding its bookmark').toBe(true)
    await workspace(page, 1).click()
    await expect(pane(page, 1).locator('[data-chat-presented=true]')).toBeVisible()
    await expect.poll(() => page.evaluate(anchor => window.__workspaceFixture.codePoint('chat-1', anchor!), anchor)).toBeCloseTo(top!, 0)
})

for (const renderer of ['native', 'mixed']) test(`keeps mobile pane returns warm with ${renderer} history while requests are held`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/e2e-fixtures/workspace-fixture.html?split&${renderer === 'native' ? 'rich' : 'mixed'}`, { waitUntil: 'domcontentloaded' })
    for (const id of [2, 1]) {
        await page.getByRole('button', { name: `P${id}`, exact: true }).click()
        await expect(pane(page, id).locator('[data-chat-presented=true]')).toBeVisible()
        await editor(page, id).fill(`Mobile draft ${id}`)
        await pane(page, id).locator('.chat-scroll-y').hover()
        await page.mouse.wheel(0, -600)
        await page.waitForTimeout(450)
        await page.evaluate(id => {
            const root = document.querySelector(`[data-session-id="chat-${id}"][data-pane-id]`)!
            const reader = root.querySelector('.chat-scroll-y')!
            const saved = ((window as any).__mobileViews ??= {})
            saved[id] = { reader, composer: root.querySelector('[contenteditable]'), top: reader.scrollTop }
        }, id)
    }
    await page.evaluate(() => window.__workspaceFixture.holdHistory())
    const samples = []
    for (let iteration = 0; iteration < 12; iteration++) {
        const id = iteration % 2 === 0 ? 2 : 1
        const sample = await page.evaluate(async id => {
            const saved = (window as any).__mobileViews[id]
            const started = performance.now()
            document.querySelector<HTMLButtonElement>(`.workspace-mobile-panes button[aria-label="P${id}"]`)!.click()
            const frames: { ready: boolean; opening: boolean; sameReader: boolean; sameComposer: boolean; drift: number; ms: number }[] = []
            for (let frame = 0; frame < 6; frame++) {
                await new Promise(requestAnimationFrame)
                const root = document.querySelector(`[data-session-id="chat-${id}"][data-pane-id]`)
                const reader = root?.querySelector('.chat-scroll-y')
                frames.push({ ready: !!root?.querySelector('[data-chat-presented=true]') && getComputedStyle(root!).visibility === 'visible',
                    opening: !!root?.querySelector('[data-chat-opening]'), sameReader: reader === saved.reader,
                    sameComposer: root?.querySelector('[contenteditable]') === saved.composer,
                    drift: Math.abs((reader?.scrollTop ?? -9999) - saved.top), ms: performance.now() - started })
            }
            return { id, frames }
        }, id)
        samples.push(sample)
        expect(sample.frames.every(f => f.ready && !f.opening && f.sameReader && f.sameComposer && f.drift <= 2), JSON.stringify(sample)).toBe(true)
        await expect(editor(page, id)).toHaveText(`Mobile draft ${id}`)
        await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1)
        const other = pane(page, id === 1 ? 2 : 1)
        await expect(other).toHaveCount(1)
        await expect(other).toBeHidden()
        expect(await other.locator('.chat-scroll-y').evaluate(e => e.clientWidth)).toBeGreaterThan(0)
    }
    console.log('MOBILE_WARM_SWITCH', renderer, JSON.stringify(samples))
    await page.evaluate(() => window.__workspaceFixture.releaseHistory())
    expect(await page.evaluate(() => window.__workspaceFixture.sends)).toEqual([])
    expect(await page.evaluate(() => window.__workspaceFixture.unhandled)).toEqual([])
})
