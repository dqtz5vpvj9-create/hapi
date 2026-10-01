import { loadDirectoryThrough } from './helpers/history-outline'
import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
    page.on('pageerror', error => { console.error('History fixture page error:', error.stack ?? error.message) })
    page.on('console', message => { if (message.type() === 'error') console.error('History fixture console error:', message.text()) })
})

test.afterEach(async ({ page }, info) => {
    if (info.status !== info.expectedStatus) {
        console.error('History fixture failure state:', await page.evaluate(() => {
            const viewport = document.querySelector<HTMLElement>('.chat-scroll-y')
            const list = document.querySelector<HTMLElement>('.happy-thread-messages')
            return { state: window.__probe?.windowState(), requests: window.__probe?.requests,
                viewport: viewport ? { height: viewport.clientHeight, scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight } : null,
                list: list?.innerHTML.slice(0, 500), mounted: document.querySelectorAll('[data-hapi-virtual-message]').length }
        }))
    }
})

async function startReading(page: Page, extraQuery = '') {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/e2e-fixtures/history-load-fixture.html?readingAnchor=1${extraQuery}`)
    const viewport = page.locator('.chat-scroll-y')
    await expect(page.getByText(/^Anchor paragraph 090:/)).toBeVisible()
    // Let cold-open settling finish before the user's history gesture.
    await page.waitForTimeout(2000)
    const box = (await viewport.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -2200)
    await expect.poll(() => page.evaluate(() => {
        const anchor = window.__readingAnchorTasks.capture()
        return Boolean(anchor?.text && anchor.id.includes('agent-text:m-1195'))
    })).toBe(true)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('history')
    const anchor = await page.evaluate(() => window.__readingAnchorTasks.capture())
    if (!anchor?.text) throw new Error('Expected visible text inside the long message')
    return anchor
}

test('keeps the actual visible character in a long message after an offscreen image grows', async ({ page }) => {
    const anchor = await startReading(page)
    const initial = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)
    const image = page.getByRole('img', { name: 'reading-anchor.svg', exact: true })
    expect(await image.evaluate(image => image.getBoundingClientRect().bottom
        < document.querySelector('.chat-scroll-y')!.getBoundingClientRect().top)).toBe(true)
    await image.evaluate(image => { image.style.maxHeight = 'none'; image.style.height = `${image.getBoundingClientRect().height + 80}px` })
    await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)).toBeCloseTo(initial!, 0)
    const remaining = await page.locator('.chat-scroll-y').evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)
    expect(remaining).toBeGreaterThan(500)
})

test('keeps the same character at the same height when the mobile viewport becomes narrower', async ({ page }) => {
    const anchor = await startReading(page)
    const initial = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)
    await page.setViewportSize({ width: 330, height: 844 })
    await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)).toBeCloseTo(initial!, 0)
})

test('keeps native text selection intact while earlier layout changes', async ({ page }) => {
    const anchor = await startReading(page)
    const selected = await page.evaluate(anchor => {
        const row = document.getElementById(anchor.id)!
        let node: Node | undefined = row
        for (const index of anchor.text!.path) node = node?.childNodes[index]
        if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error('Selected passage missing')
        const range = document.createRange()
        range.setStart(node, anchor.text!.offset)
        range.setEnd(node, Math.min((node as Text).length, anchor.text!.offset + 24))
        const selection = window.getSelection()!
        selection.removeAllRanges(); selection.addRange(range)
        return selection.toString()
    }, anchor)
    await page.getByRole('img', { name: 'reading-anchor.svg', exact: true }).evaluate(image => {
        image.style.maxHeight = 'none'; image.style.height = `${image.getBoundingClientRect().height + 80}px`
    })
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(selected)
})


test('keeps the original text occurrence when identical text is inserted above it', async ({ page }) => {
    const anchor = await startReading(page)
    const initial = await page.evaluate(anchor => {
        let node: Node = document.getElementById(anchor.id)!
        for (const index of anchor.text!.path) node = node.childNodes[index]
        const range = document.createRange()
        range.setStart(node, anchor.text!.offset); range.setEnd(node, anchor.text!.offset + 1)
        ;(window as Window & { __originalReadingRange?: Range }).__originalReadingRange = range
        const y = range.getBoundingClientRect().top - document.querySelector('.chat-scroll-y')!.getBoundingClientRect().top
        const paragraph = (node as Text).parentElement!
        const inserted = document.createElement('div')
        inserted.textContent = node.textContent
        inserted.style.height = '80px'
        paragraph.before(inserted)
        return y
    }, anchor)
    await expect.poll(() => page.evaluate(() => {
        const range = (window as Window & { __originalReadingRange?: Range }).__originalReadingRange!
        return range.getBoundingClientRect().top - document.querySelector('.chat-scroll-y')!.getBoundingClientRect().top
    })).toBeCloseTo(initial, 0)
})


for (const failure of [false, true]) {
    test(`preserves reading during a held older request and its ${failure ? 'failure' : 'prepend'}`, async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto(`/e2e-fixtures/history-load-fixture.html?readingAnchor=1&readingPending=1${failure ? '&failBefore=1' : ''}`)
        await expect(page.getByText(/^Anchor paragraph 090:/)).toBeVisible()
        await page.waitForTimeout(2000)
        await page.evaluate(() => window.__probe.holdBefore())
        const viewport = page.locator('.chat-scroll-y')
        const box = (await viewport.boundingBox())!
        const delta = await viewport.evaluate(e => {
            const row = Array.from(e.querySelectorAll<HTMLElement>('.happy-thread-messages [id^="hapi-message-"]')).find(row => row.id.includes('agent-text:m-1195'))!
            return row.getBoundingClientRect().top - e.getBoundingClientRect().top + 8
        })
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.wheel(0, delta)
        await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('history')
        await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(true)
        const anchor = await page.evaluate(() => window.__readingAnchorTasks.capture())
        if (!anchor?.text || !anchor.id.includes('agent-text:m-1195')) throw new Error('Expected long-message reading point')
        const y = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)
        expect(y).toBeGreaterThanOrEqual(0)
        await page.getByRole('img', { name: 'reading-anchor.svg', exact: true }).evaluate(image => {
            image.style.maxHeight = 'none'; image.style.height = `${image.getBoundingClientRect().height + 80}px`
        })
        await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)).toBeCloseTo(y!, 0)
        expect(await page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(true)
        await page.evaluate(() => window.__probe.releaseBefore())
        await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(false)
        await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)).toBeCloseTo(y!, 0)
        if (!failure) expect(await page.evaluate(() => window.__probe.windowState().messageCount)).toBeGreaterThan(7)
    })
}

for (let attempt = 1; attempt <= 3; attempt++) {
    test(`does not reclaim history when an upward wheel coincides with image growth (${attempt})`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto('/e2e-fixtures/history-load-fixture.html?readingAnchor=1')
        await expect(page.getByText(/^Anchor paragraph 090:/)).toBeVisible()
        await page.waitForTimeout(2000)
        const viewport = page.locator('.chat-scroll-y')
        const box = (await viewport.boundingBox())!
        await page.evaluate(() => {
            const viewport = document.querySelector<HTMLElement>('.chat-scroll-y')!
            const trace: unknown[] = []
            const sample = (event: string) => {
                trace.push({ event, top: viewport.scrollTop,
                    remaining: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
                    mode: window.__probe.windowState().viewMode })
            }
            const state = { trace, anchor: null as ReturnType<typeof window.__readingAnchorTasks.capture>, beforeY: null as number | null }
            ;(window as Window & { __wheelResizeRace?: typeof state }).__wheelResizeRace = state
            viewport.addEventListener('scroll', () => sample('scroll'), { passive: true })
            viewport.addEventListener('wheel', () => {
                sample('wheel')
                {
                    sample('before-grow')
                    state.anchor = window.__readingAnchorTasks.capture()
                    state.beforeY = state.anchor ? window.__readingAnchorTasks.point(state.anchor) : null
                    const image = viewport.querySelector<HTMLImageElement>('img[alt="reading-anchor.svg"]')!
                    image.style.maxHeight = 'none'
                    image.style.height = `${image.getBoundingClientRect().height + 80}px`
                    sample('after-grow')
                }
            }, { once: true, passive: true })
        })
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.wheel(0, -2200)
        try {
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))))
            await expect.poll(() => viewport.evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)).toBeGreaterThan(1500)
            await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('history')
            const point = await page.evaluate(() => {
                const state = (window as Window & { __wheelResizeRace?: {
                    anchor: ReturnType<typeof window.__readingAnchorTasks.capture>; beforeY: number | null
                } }).__wheelResizeRace!
                return { before: state.beforeY, after: state.anchor ? window.__readingAnchorTasks.point(state.anchor) : null }
            })
            expect(point.before).toBeGreaterThanOrEqual(0)
            expect(point.after).toBeCloseTo(point.before!, 0)
        } finally {
            const result = await page.evaluate(() => {
                const state = (window as Window & { __wheelResizeRace?: {
                    trace: unknown[]; anchor: ReturnType<typeof window.__readingAnchorTasks.capture>; beforeY: number | null
                } }).__wheelResizeRace!
                return { ...state, afterY: state.anchor ? window.__readingAnchorTasks.point(state.anchor) : null,
                    finalMode: window.__probe.windowState().viewMode }
            })
            await testInfo.attach('wheel-resize-observation', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
        }
    })
}


for (const growImage of [false, true]) {
    test(`outline navigation wins over a prior reading anchor ${growImage ? 'with image growth' : 'without layout intervention'}`, async ({ page }) => {
        await startReading(page)
        await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
        await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 1197')
        const destination = page.getByRole('button', { name: /Fixture message 1197$/ })
        await expect(destination).toBeVisible()
        if (growImage) await page.evaluate(() => {
            const destination = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('Fixture message 1197'))!
            destination.addEventListener('click', () => {
                setTimeout(() => {
                    const image = document.querySelector<HTMLImageElement>('img[alt="reading-anchor.svg"]')!
                    image.style.maxHeight = 'none'
                    image.style.height = `${image.getBoundingClientRect().height + 80}px`
                }, 0)
            }, { once: true })
        })
        await destination.click()
        await expect(destination).toHaveCount(0)
        await expect(page.getByText('Fixture message 1197', { exact: true })).toBeInViewport({ ratio: 0.9 })
    })
}


for (const continueReading of [false, true]) {
    test(`closing a held cross-page outline lookup ${continueReading ? 'and continuing to read' : 'using keyboard activation alone'} cancels stale navigation`, async ({ page }) => {
        await startReading(page, '&outlineArchive=1')
        await page.evaluate(() => window.__probe.holdContext())
        await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
        await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 700')
        await page.getByRole('button', { name: /Fixture message 700$/ }).click()
        await expect.poll(() => page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'context').length)).toBe(1)
        const close = page.getByRole('complementary', { name: 'Outline', exact: true }).getByRole('button', { name: 'Close', exact: true })
        if (continueReading) {
            await close.click()
            const viewport = page.locator('.chat-scroll-y')
            const box = (await viewport.boundingBox())!
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            await page.mouse.wheel(0, -300)
        } else {
            await close.press('Enter')
        }
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))))
        const anchor = await page.evaluate(() => window.__readingAnchorTasks.capture())
        if (!anchor?.text) throw new Error('Expected a current visible passage')
        const y = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)
        await page.evaluate(() => window.__probe.releaseContext())
        await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(false)
        // A late context can settle, but a cancelled lookup must neither replace
        // the current reading window nor navigate after the user moved on.
        await page.waitForTimeout(500)
        expect(await page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'context').length)).toBe(1)
        expect(await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)).toBeCloseTo(y!, 0)
    })
}

test('an active cross-page outline lookup loads the target and navigates to it', async ({ page }, testInfo) => {
    await startReading(page, '&outlineArchive=1')
    await page.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>('.chat-scroll-y')!
        const trace: unknown[] = []
        ;(window as Window & { __outlineTrace?: unknown[] }).__outlineTrace = trace
        const sample = (event: string, id?: string) => {
            const target = document.getElementById('hapi-message-user-text:m-700')
            trace.push({ event, id, at: performance.now(), top: viewport.scrollTop,
                targetY: target ? target.getBoundingClientRect().top - viewport.getBoundingClientRect().top : null,
                state: window.__probe.windowState() })
        }
        const original = Element.prototype.scrollIntoView
        Element.prototype.scrollIntoView = function(options) {
            sample('scrollIntoView', this.id)
            original.call(this, options)
        }
        viewport.addEventListener('scroll', () => sample('scroll'), { passive: true })
        viewport.addEventListener('scrollend', () => sample('scrollend'), { passive: true })
    })
    try {
        await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
        await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 700')
        await page.getByRole('button', { name: /Fixture message 700$/ }).click()
        await expect.poll(() => page.evaluate(() => window.__probe.requests.filter(r => r.direction === 'context').length)).toBe(1)
        await expect(page.getByRole('complementary', { name: 'Outline', exact: true })).toHaveCount(0)
        await expect(page.locator('.chat-scroll-y').getByText('Fixture message 700', { exact: true })).toBeInViewport({ ratio: 0.9 })
    } finally {
        const trace = await page.evaluate(() => (window as Window & { __outlineTrace?: unknown[] }).__outlineTrace)
        await testInfo.attach('outline-observation', { body: JSON.stringify(trace, null, 2), contentType: 'application/json' })
    }
})

test('a held directory page completes without replacing the selected reading interval', async ({ page }) => {
    test.setTimeout(90_000)
    await startReading(page)
    const reader = await page.evaluate(() => window.__probe.windowState())
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Outline', exact: true })
    for (const oldest of [801, 601, 401]) {
        await loadDirectoryThrough(page, oldest)
        await expect(panel.getByRole('button', { name: new RegExp(`Fixture message ${oldest}$`) })).toHaveCount(1)
        await expect(panel.getByRole('button', { name: 'Load earlier', exact: true })).toBeEnabled()
    }
    await page.evaluate(() => window.__probe.holdOutline())
    await panel.getByRole('button', { name: 'Load earlier', exact: true }).click()
    await expect(panel.getByRole('button', { name: 'Loading…', exact: true })).toBeDisabled()
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 1170')
    await panel.getByRole('button', { name: /Fixture message 1170$/ }).click()
    await expect(panel).toHaveCount(0)
    await expect(page.getByText('Fixture message 1170', { exact: true })).toBeInViewport({ ratio: 0.9 })
    const finished = await page.evaluate(() => window.__probe.finishedOutlineRequests)
    await page.evaluate(() => window.__probe.releaseOutline())
    await expect.poll(() => page.evaluate(() => window.__probe.finishedOutlineRequests)).toBe(finished + 1)
    const state = await page.evaluate(() => window.__probe.windowState())
    expect({ oldest: state.oldestSeq, newest: state.newestSeq, count: state.messageCount })
        .toEqual({ oldest: reader.oldestSeq, newest: reader.newestSeq, count: reader.messageCount })
    await expect(page.getByText('Fixture message 1170', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    await loadDirectoryThrough(page, 201)
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 250')
    await expect(panel.getByRole('button', { name: /Fixture message 250$/ })).toHaveCount(1)
})


test('a remotely removed outline destination stops being commanded after the history refresh', async ({ page }, testInfo) => {
    await startReading(page, '&threadHeader=1')
    await page.evaluate(() => {
        const calls: { id: string; connected: boolean; at: number }[] = []
        ;(window as Window & { __removedTargetCalls?: typeof calls }).__removedTargetCalls = calls
        const original = Element.prototype.scrollIntoView
        Element.prototype.scrollIntoView = function(options) {
            calls.push({ id: this.id, connected: this.isConnected, at: performance.now() })
            original.call(this, options)
        }
        const viewport = document.querySelector<HTMLElement>('.chat-scroll-y')!
        // Model a second client rewinding while the local native animation starts.
        // The API returns a new epoch and reset page through the real useMessages path.
        const destination = 'hapi-message-user-text:m-1197'
        const originalCall = Element.prototype.scrollIntoView
        Element.prototype.scrollIntoView = function(options) {
            originalCall.call(this, options)
            if (this.id === destination && this.isConnected) {
                Element.prototype.scrollIntoView = originalCall
                void window.__probe.remoteRewindTo(1196)
            }
        }
        if (viewport.getBoundingClientRect().top < 40) throw new Error('Expected normal session header offset')
    })
    try {
        await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
        await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 1197')
        await page.getByRole('button', { name: /Fixture message 1197$/ }).click()
        await expect(page.getByText('Fixture message 1197', { exact: true })).toHaveCount(0)
        await expect.poll(() => page.evaluate(() => window.__probe.windowState().newestSeq)).toBe(1196)
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))))
        await page.getByRole('img', { name: 'reading-anchor.svg', exact: true }).evaluate(image => {
            image.style.maxHeight = 'none'
            image.style.height = `${image.getBoundingClientRect().height + 80}px`
        })
        // Include late native animation completion and another layout change,
        // rather than accepting only the first two frames after replacement.
        await page.waitForTimeout(800)
        const staleCalls = await page.evaluate(() => (window as Window & { __removedTargetCalls?: { id: string; connected: boolean }[] }).__removedTargetCalls!.filter(call => !call.connected))
        expect(staleCalls).toEqual([])
    } finally {
        const result = await page.evaluate(() => ({ calls: (window as Window & { __removedTargetCalls?: unknown[] }).__removedTargetCalls, state: window.__probe.windowState() }))
        await testInfo.attach('removed-target-observation', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
    }
})

test('loading more outline entries after reaching a history destination does not evict the reader', async ({ page }) => {
    test.setTimeout(90_000)
    await startReading(page)
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    for (const oldest of [801, 601, 401]) {
        await loadDirectoryThrough(page, oldest)
        await expect(page.getByRole('complementary', { name: 'Outline', exact: true }).getByRole('button', { name: new RegExp(`Fixture message ${oldest}$`) })).toHaveCount(1)
        await expect(page.getByRole('button', { name: 'Load earlier', exact: true })).toBeEnabled()
    }
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 1170')
    await page.getByRole('button', { name: /Fixture message 1170$/ }).click()
    await expect(page.getByRole('complementary', { name: 'Outline', exact: true })).toHaveCount(0)
    await expect(page.getByText('Fixture message 1170', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    await loadDirectoryThrough(page, 201)
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 250')
    await expect(page.getByRole('complementary', { name: 'Outline', exact: true }).getByRole('button', { name: /Fixture message 250$/ })).toHaveCount(1)
    await page.getByRole('complementary', { name: 'Outline', exact: true }).getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByText('Fixture message 1170', { exact: true })).toBeInViewport({ ratio: 0.9 })
})


test('failed directory paging can be retried while the same character stays visible', async ({ page }) => {
    const anchor = await startReading(page, '&failOutline=1')
    const initial = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Outline', exact: true })
    await panel.getByRole('button', { name: 'Load earlier', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('outline page failed')
    await loadDirectoryThrough(page, 801)
    await expect(panel.getByRole('button', { name: /Fixture message 801$/ })).toHaveCount(1)
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await panel.getByRole('button', { name: 'Close', exact: true }).click()
    await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)).toBeCloseTo(initial!, 0)
    expect(await page.evaluate(() => window.__probe.windowState().oldestSeq)).toBe(1001)
})

test('a remote history reset clears stale directory entries and restarts from the new cursor', async ({ page }) => {
    await startReading(page)
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Outline', exact: true })
    await panel.getByRole('button', { name: 'Load earlier', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 1100')
    await expect(panel.getByRole('button', { name: /Fixture message 1100$/ })).toHaveCount(1)
    await page.evaluate(() => window.__probe.remoteRewindTo(1000))
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().newestSeq)).toBe(1000)
    await expect(panel.getByRole('button', { name: /Fixture message 1100$/ })).toHaveCount(0)
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('')
    await loadDirectoryThrough(page, 601)
    await expect(panel.getByRole('button', { name: /Fixture message 601$/ })).toHaveCount(1)
    expect(await page.evaluate(() => window.__probe.windowState().oldestSeq)).toBe(801)
})


test('revoked directory access clears its cached labels and stops paging', async ({ page }) => {
    const anchor = await startReading(page, '&directoryDenied=1')
    const initial = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Outline', exact: true })
    await expect(panel.getByRole('alert')).toContainText('directory forbidden')
    await expect(panel.getByRole('button', { name: /Fixture message/ })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Load earlier', exact: true })).toHaveCount(0)
    await panel.getByRole('button', { name: 'Close', exact: true }).click()
    await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)).toBeCloseTo(initial!, 0)
})

test('a failed refresh after directory history reset can recover through the same control', async ({ page }) => {
    await startReading(page, '&outlineEpochReset=1')
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Outline', exact: true })
    await panel.getByRole('button', { name: 'Load earlier', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('reset refresh failed')
    await panel.getByRole('button', { name: 'Load earlier', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().newestSeq)).toBe(1000)
    await expect(panel.getByRole('alert')).toHaveCount(0)
    await expect(panel.getByRole('button', { name: /Fixture message 1100$/ })).toHaveCount(0)
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('')
    await loadDirectoryThrough(page, 601)
    await expect(panel.getByRole('button', { name: /Fixture message 601$/ })).toHaveCount(1)
})


test('revoked access during reset refresh clears the directory and stops retrying', async ({ page }) => {
    await startReading(page, '&outlineEpochReset=1&resetRefreshDenied=1')
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Outline', exact: true })
    await panel.getByRole('button', { name: 'Load earlier', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('reset refresh forbidden')
    await expect(panel.getByRole('button', { name: /Fixture message/ })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: 'Load earlier', exact: true })).toHaveCount(0)
    const requests = await page.evaluate(() => window.__probe.requests.length)
    await panel.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    await expect(panel.getByRole('button', { name: /Fixture message/ })).toHaveCount(0)
    expect(await page.evaluate(() => window.__probe.requests.length)).toBe(requests)
})


test('directory metadata paging ignores an isolated old reasoning row retained by the reader', async ({ page }) => {
    await startReading(page, '&cachedReentry=1&holdLatest=1&orphanReasoning=1')
    try {
        expect(await page.evaluate(() => window.__probe.windowState().oldestSeq)).toBe(1)
        await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
        const panel = page.getByRole('complementary', { name: 'Outline', exact: true })
        await loadDirectoryThrough(page, 801)
        await expect(panel.getByRole('button', { name: /Fixture message 801$/ })).toHaveCount(1)
        expect(await page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'before'))).toEqual([])
        expect(await page.evaluate(() => window.__probe.windowState().messageCount)).toBe(201)
    } finally { await page.evaluate(() => window.__probe.releaseLatest()) }
})

test('directory entries follow sequence order when timestamps are equal across pages', async ({ page }) => {
    await startReading(page, '&sameAt=1')
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Outline', exact: true })
    await loadDirectoryThrough(page, 801)
    await expect(panel.getByRole('button', { name: /Fixture message 801$/ })).toHaveCount(1)
    const ids = await panel.locator('[data-outline-id]').evaluateAll(rows => rows.map(row => Number(row.getAttribute('data-outline-id')!.split('m-')[1])))
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
})


test('selecting an archived metadata entry fetches context without sequential body paging', async ({ page }) => {
    await startReading(page)
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Outline', exact: true })
    for (const oldest of [801, 601]) {
        await loadDirectoryThrough(page, oldest)
        await expect(panel.getByRole('button', { name: new RegExp(`Fixture message ${oldest}$`) })).toHaveCount(1)
    }
    const reads = await page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'before').length)
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 700')
    await panel.getByRole('button', { name: /Fixture message 700$/ }).click()
    await expect(panel).toHaveCount(0)
    await expect(panel).toHaveCount(0)
    await expect(page.locator('.chat-scroll-y').getByText('Fixture message 700', { exact: true })).toBeInViewport({ ratio: 0.9 })
    expect(await page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'before').length)).toBe(reads)
})


test('a live edit received during an uncached directory read stays fresh when that page is opened', async ({ page }) => {
    await startReading(page, '&snapshotBefore=1')
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Outline', exact: true })
    await loadDirectoryThrough(page, 1000)
    const earlierReads = await page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'outline' && request.beforeSeq !== null).length)
    await page.evaluate(() => window.__probe.holdOutline())
    await panel.getByRole('button', { name: 'Load earlier', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'outline' && request.beforeSeq !== null).length)).toBe(earlierReads + 1)
    await page.evaluate(() => window.__probe.remoteEditMessage(900, 'Fixture message 900 updated live'))
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 900')
    await expect(panel.getByRole('button', { name: /Fixture message 900 updated live$/ })).toHaveCount(1)
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('')
    await page.evaluate(() => window.__probe.releaseOutline())
    await loadDirectoryThrough(page, 801)
    await expect(panel.getByRole('button', { name: /Fixture message 801$/ })).toHaveCount(1)
    await loadDirectoryThrough(page, 601)
    await expect(panel.getByRole('button', { name: /Fixture message 601$/ })).toHaveCount(1)
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 700')
    await panel.getByRole('button', { name: /Fixture message 700$/ }).click()
    await expect(panel).toHaveCount(0)
    await expect(page.locator('.chat-scroll-y').getByText('Fixture message 700', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 900')
    await panel.getByRole('button', { name: /Fixture message 900/ }).click()
    await expect(panel).toHaveCount(0)
    const transcript = page.locator('.chat-scroll-y')
    await expect(transcript.getByText('Fixture message 900 updated live', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await expect(transcript.getByText('Fixture message 900', { exact: true })).toHaveCount(0)
})


test('opens an evicted far message in one context request, reads forward, and returns to latest', async ({ page }) => {
    await startReading(page)
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Outline', exact: true })
    for (const oldest of [801, 601]) {
        await loadDirectoryThrough(page, oldest)
        await expect(panel.getByRole('button', { name: new RegExp(`Fixture message ${oldest}$`) })).toHaveCount(1)
    }
    await page.evaluate(() => window.__probe.evictHistoryPayloads())
    const beforeReads = await page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'before').length)
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 700')
    await panel.getByRole('button', { name: /Fixture message 700$/ }).click()
    await expect(panel).toHaveCount(0)
    await expect(page.locator('.chat-scroll-y').getByText('Fixture message 700', { exact: true })).toBeInViewport({ ratio: 0.9 })
    expect(await page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'context').length)).toBe(1)
    expect(await page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'before').length)).toBe(beforeReads)
    const viewport = page.locator('.chat-scroll-y')
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')) })
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().newestSeq)).toBeGreaterThanOrEqual(999)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('history')
    await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click()
    await expect(page.getByText('Fixture message 1200', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('tail')
})


test('returns to latest after first reaching the old window edge while its request is held', async ({ page }) => {
    await startReading(page, '&outlineArchive=1')
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 700')
    const panel = page.getByRole('complementary', { name: 'Outline', exact: true })
    await panel.getByRole('button', { name: /Fixture message 700$/ }).click()
    await expect(panel).toHaveCount(0)
    const viewport = page.locator('.chat-scroll-y')
    await expect(viewport.getByText('Fixture message 700', { exact: true })).toBeInViewport({ ratio: 0.9 })

    await page.evaluate(() => window.__probe.holdLatest())
    await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'latest').length)).toBe(2)
    await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThan(1)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('tail')

    await page.evaluate(() => window.__probe.releaseLatest())
    await expect(viewport.getByText('Fixture message 1200', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('tail')
})

test('upward input interrupts latest and preserves the passage when its held response arrives', async ({ page }) => {
    await startReading(page, '&outlineArchive=1')
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 700')
    const panel = page.getByRole('complementary', { name: 'Outline', exact: true })
    await panel.getByRole('button', { name: /Fixture message 700$/ }).click()
    await expect(panel).toHaveCount(0)
    const viewport = page.locator('.chat-scroll-y')
    await expect(viewport.getByText('Fixture message 700', { exact: true })).toBeInViewport({ ratio: 0.9 })

    await page.evaluate(() => window.__probe.holdLatest())
    await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'latest').length)).toBe(2)
    await viewport.hover()
    await page.mouse.wheel(0, -500)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('history')
    await page.waitForTimeout(500)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('history')
    const anchor = await page.evaluate(() => window.__readingAnchorTasks.capture())
    if (!anchor?.text) throw new Error('Expected a visible reading passage after interrupting latest')
    const point = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)
    expect(typeof point).toBe('number')

    await page.evaluate(() => window.__probe.releaseLatest())
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().isSyncingTail)).toBe(false)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)).toBeCloseTo(point!, 0)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('history')
    await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click()
    await expect(viewport.getByText('Fixture message 1200', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('tail')
})

test('returning to latest includes a live message arriving during the final forward page', async ({ page }) => {
    await startReading(page)
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Outline', exact: true })
    for (const oldest of [801, 601]) {
        await loadDirectoryThrough(page, oldest)
        await expect(panel.getByRole('button', { name: new RegExp(`Fixture message ${oldest}$`) })).toHaveCount(1)
    }
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 700')
    await panel.getByRole('button', { name: /Fixture message 700$/ }).click()
    await expect(panel).toHaveCount(0)
    await expect(page.locator('.chat-scroll-y').getByText('Fixture message 700', { exact: true })).toBeInViewport({ ratio: 0.9 })
    const bottom = async () => {
        const viewport = page.locator('.chat-scroll-y')
        await viewport.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' })
        await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')) })
        await viewport.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' })
    }
    const nextHead = (await page.evaluate(() => window.__probe.windowState().newestSeq))! + 200
    await page.evaluate(head => window.__probe.holdAfter(head), nextHead)
    await bottom()
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().newestSeq)).toBe(nextHead)
    // Forward publication preserves the old passage; the newly loaded end is
    // virtualized until the next deliberate scroll reaches it.
    await bottom()
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(true)
    await expect(page.getByText(`Fixture message ${nextHead}`, { exact: true })).toBeInViewport()
    await page.evaluate(() => window.__probe.appendRemoteMessage())
    await expect(page.getByText('Fixture message 1201', { exact: true })).toHaveCount(0)
    await page.evaluate(() => window.__probe.releaseAfter())
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().isLoadingMore)).toBe(false)
    await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click()
    await expect(page.getByText('Fixture message 1201', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('tail')
})


test('restores the same visible character after switching from A to B and back', async ({ page }) => {
    const anchor = await startReading(page)
    const initial = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)
    await page.getByRole('button', { name: 'Switch to session B', exact: true }).click()
    await expect(page.getByText('Fixture message 1200', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await page.getByRole('button', { name: 'Switch to session A', exact: true }).click()
    await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)).toBeCloseTo(initial!, 0)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('history')
})

test('restores the saved visible character after refreshing the page', async ({ page }) => {
    const anchor = await startReading(page)
    const initial = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)
    await page.reload()
    await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)).toBeCloseTo(initial!, 0)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('history')
    expect(await page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'latest').length)).toBe(0)
})

test('refreshing a directly located archived message preserves its reading window and forward cursor', async ({ page }) => {
    await startReading(page, '&outlineArchive=1')
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 700')
    await page.getByRole('complementary', { name: 'Outline', exact: true }).getByRole('button', { name: /Fixture message 700$/ }).click()
    await expect(page.getByRole('complementary', { name: 'Outline', exact: true })).toHaveCount(0)
    await expect(page.locator('.chat-scroll-y').getByText('Fixture message 700', { exact: true })).toBeInViewport({ ratio: 0.9 })
    // Finish native smooth navigation before defining the saved reading point.
    await expect.poll(() => page.locator('[id="hapi-message-user-text:m-700"]').evaluate(element => Math.abs(element.getBoundingClientRect().top - document.querySelector('.chat-scroll-y')!.getBoundingClientRect().top - parseFloat(getComputedStyle(element).scrollMarginTop)))).toBeLessThan(2)
    const anchor = await page.evaluate(() => window.__readingAnchorTasks.capture())
    if (!anchor) throw new Error('Expected archived reading anchor')
    const initial = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)
    await page.reload()
    await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)).toBeCloseTo(initial!, 0)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('history')
    const viewport = page.locator('.chat-scroll-y')
    await viewport.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' })
    await viewport.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')) })
    await viewport.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' })
    await expect.poll(() => page.evaluate(() => window.__probe.requests.some(request => request.direction === 'after'))).toBe(true)
    await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click()
    await expect(page.getByText('Fixture message 1200', { exact: true })).toBeInViewport({ ratio: 0.9 })
})


test('keeps the reading character through live append and reconnect, then clears restoration on explicit latest', async ({ page }) => {
    const anchor = await startReading(page)
    const initial = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)
    await page.evaluate(() => window.__probe.appendRemoteMessage())
    await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)).toBeCloseTo(initial!, 0)
    await page.evaluate(() => window.__probe.refetch())
    await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)).toBeCloseTo(initial!, 0)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('history')
    await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click()
    await expect(page.getByText('Fixture message 1201', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('tail')
    await page.reload()
    await expect(page.getByText('Fixture message 1201', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('tail')
})


test('an explicit latest intent survives refresh while the latest request is still pending', async ({ page }) => {
    await startReading(page, '&outlineArchive=1')
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 700')
    await page.getByRole('complementary', { name: 'Outline', exact: true }).getByRole('button', { name: /Fixture message 700$/ }).click()
    await expect(page.getByRole('complementary', { name: 'Outline', exact: true })).toHaveCount(0)
    await expect(page.locator('.chat-scroll-y').getByText('Fixture message 700', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await page.evaluate(() => window.__probe.holdLatest())
    await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'latest').length)).toBe(2)
    await page.reload()
    await expect(page.getByText('Fixture message 1200', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await expect(page.locator('.chat-scroll-y').getByText('Fixture message 700', { exact: true })).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('tail')
})

test('revalidates an archived reading identity after an epoch change and selects its neighbor after rewind', async ({ page }) => {
    await startReading(page, '&outlineArchive=1')
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 700')
    await page.getByRole('complementary', { name: 'Outline', exact: true }).getByRole('button', { name: /Fixture message 700$/ }).click()
    await expect(page.getByRole('complementary', { name: 'Outline', exact: true })).toHaveCount(0)
    await expect(page.locator('.chat-scroll-y').getByText('Fixture message 700', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await expect.poll(() => page.locator('[id="hapi-message-user-text:m-700"]').evaluate(element => Math.abs(element.getBoundingClientRect().top - document.querySelector('.chat-scroll-y')!.getBoundingClientRect().top - parseFloat(getComputedStyle(element).scrollMarginTop)))).toBeLessThan(2)
    const anchor = await page.evaluate(() => window.__readingAnchorTasks.capture())
    if (!anchor) throw new Error('Expected saved archive position')
    const initial = await page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)
    await page.evaluate(() => window.__probe.remoteRewindTo(1100))
    await expect.poll(() => page.evaluate(anchor => window.__readingAnchorTasks.point(anchor), anchor)).toBeCloseTo(initial!, 0)
    await expect.poll(() => page.evaluate(() => window.__probe.windowState().viewMode)).toBe('history')
    await page.evaluate(() => window.__probe.remoteRewindTo(650))
    await expect(page.getByText('Fixture message 650', { exact: true })).toBeInViewport({ ratio: 0.9 })
    await expect(page.locator('.chat-scroll-y').getByText('Fixture message 700', { exact: true })).toHaveCount(0)
    await expect(page.getByText('The message you were reading was removed. Restored a nearby message.', { exact: true })).toBeVisible()
})


test('virtual history mounts a bounded viewport and reveals an already loaded offscreen message without a context GET', async ({ page }) => {
    await startReading(page)
    expect(await page.evaluate(() => window.__probe.windowState().messageCount)).toBe(200)
    expect(await page.locator('[data-hapi-virtual-message]').count()).toBeLessThanOrEqual(40)
    await expect(page.getByText('Fixture message 1100', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Open conversation outline', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 1100')
    await page.getByRole('complementary', { name: 'Outline', exact: true }).getByRole('button', { name: /Fixture message 1100$/ }).click()
    await expect(page.getByText('Fixture message 1100', { exact: true })).toBeInViewport({ ratio: 0.9 })
    expect(await page.evaluate(() => window.__probe.requests.filter(request => request.direction === 'context').length)).toBe(0)
    expect(await page.locator('[data-hapi-virtual-message]').count()).toBeLessThanOrEqual(40)
})
