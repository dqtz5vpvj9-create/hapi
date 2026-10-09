import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.HAPI_REPLAY_DATA!
const sessions = JSON.parse(readFileSync(join(root, 'session-list.json'), 'utf8')).sessions as {
    id: string; metadata: { name: string }
}[]
const primary = sessions.find(session => session.id === process.env.HAPI_REPLAY_PRIMARY_SESSION)!
if (!primary) throw new Error('HAPI_REPLAY_PRIMARY_SESSION must identify a captured session')
const secondary = sessions.find(session => session.id !== primary.id
    && JSON.parse(readFileSync(join(root, session.id + '.json'), 'utf8')).pages.length > 7)!
if (!secondary) throw new Error('Session switching needs a second captured session with more than seven history pages')

test('A to B to A keeps each session disclosure and unsent draft', async ({ app, browser, screen }) => {
    const remembered = new Map<string, string>()
    const visit = async (session: typeof primary) => {
        const sidebarVisible = await browser.evaluate(() =>
            (document.querySelector('.app-session-sidebar-frame')?.getClientRects().length ?? 0) > 0)
        if (!sidebarVisible) await screen.getByRole('button', 'Back', { exact: true }).tap()
        await screen.getByRole('button').filter({ hasText: session.metadata.name }).tap()
        await expect(browser.locator('[data-chat-node-key]').first()).toBeVisible()
    }
    await app.open(`/sessions/${primary.id}`)
    for (const session of [primary, secondary]) {
        if (session !== primary) await visit(session)
        const group = screen.getByRole('button', /^Process \(/).first()
        await group.tap()
        await expect(group).toHaveAttribute('aria-expanded', 'true')
        const key = await browser.evaluate(() => document.querySelector('.hapi-native-process[aria-expanded=true]')!
            .closest<HTMLElement>('[data-chat-node-key]')!.dataset.chatNodeKey!)
        remembered.set(session.id, key)
        await screen.getByTestId('rich-composer-input').fill(`Local draft ${session === primary ? 'A' : 'B'} — never send`)
    }
    for (let round = 0; round < 3; round++) {
        for (const session of [primary, secondary]) {
            await visit(session)
            await expect(screen.getByTestId('rich-composer-input')).toHaveValue(`Local draft ${session === primary ? 'A' : 'B'} — never send`)
            await expect(browser.locator(`[data-chat-node-key="${remembered.get(session.id)}"] .hapi-native-process`))
                .toHaveAttribute('aria-expanded', 'true')
        }
    }
})

test('A updates while B is selected and switching back opens the latest cached content', async ({ app, browser, screen }) => {
    const capture = JSON.parse(readFileSync(join(root, primary.id + '.json'), 'utf8'))
    const original = capture.pages[0]
    const head = original.page.snapshotHeadSeq + 1
    const at = original.page.snapshotHeadAt + 1
    const marker = 'E2E: loaded in the background before switching back'
    const message = { id: 'e2e-background-message', localId: null, seq: head, createdAt: at, invokedAt: at,
        content: { role: 'user', content: { type: 'text', text: marker } } }
    await browser.addInitScript(() => {
        const sources: EventSource[] = []
        const NativeEventSource = window.EventSource
        window.EventSource = class extends NativeEventSource {
            constructor(url: string | URL, init?: EventSourceInit) { super(url, init); sources.push(this) }
        }
        ;(window as unknown as { replaySources: EventSource[] }).replaySources = sources
    })
    let changed = false, hold = false, backgroundReads = 0, pending = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const pattern = `**/api/sessions/${primary.id}/messages?**`
    await browser.route(pattern, async route => {
        const url = new URL(route.request.url)
        if (!changed || url.searchParams.has('beforeSeq')) return route.continue()
        pending++
        try {
            if (hold) await gate
            else backgroundReads++
            const incremental = url.searchParams.has('afterSeq')
            await route.fulfill({ json: {
                messages: incremental ? (Number(url.searchParams.get('afterSeq')) < head ? [message] : []) : [...original.messages, message],
                page: { ...original.page, direction: incremental ? 'after' : 'latest', hasMore: !incremental && original.page.hasMore,
                    nextAfterAt: at, nextAfterSeq: head, snapshotHeadAt: at, snapshotHeadSeq: head }
            } })
        } finally { pending-- }
    })
    try {
        await app.open(`/sessions/${primary.id}`)
        await expect(browser.locator('[data-chat-node-key]').first()).toBeVisible()
        const view = browser.locator('.chat-scroll-y'), bounds = (await view.boundingBox())!
        await browser.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        for (let i = 0; i < 7; i++) {
            const first = await browser.evaluate(() => document.querySelector('[data-chat-node-key]')?.getAttribute('data-chat-node-key') ?? '')
            await browser.mouse.wheel(0, -4000)
            await expect.poll(() => browser.evaluate(() => document.querySelector('[data-chat-node-key]')?.getAttribute('data-chat-node-key') ?? ''), { timeout: 15000 }).not.toBe(first)
        }
        await screen.getByRole('button', 'Back', { exact: true }).tap()
        await screen.getByRole('button').filter({ hasText: secondary.metadata.name }).tap()
        await expect(browser.locator('[data-chat-node-key]').first()).toBeVisible()
        changed = true
        await browser.evaluate(id => {
            const sources = (window as unknown as { replaySources: EventSource[] }).replaySources
            for (const source of sources) if (new URL(source.url).searchParams.get('all') === 'true' && source.readyState !== EventSource.CLOSED) {
                source.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'messages-invalidated', sessionId: id, reason: 'native-history' }) }))
            }
        }, primary.id)
        await expect.poll(() => backgroundReads, { timeout: 15000 }).toBeGreaterThan(0)
        await expect.poll(() => pending).toBe(0)
        await browser.evaluate(() => new Promise<null>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))))
        await expect(browser).toHaveURL(`/sessions/${secondary.id}`)
        hold = true
        await screen.getByRole('button', 'Back', { exact: true }).tap()
        await browser.evaluate(({ id, marker }) => {
            const probe = { done: false, frames: 0, blank: 0, missingLatest: 0, maxTailDistance: 0 }
            ;(window as unknown as { warmProbe: typeof probe }).warmProbe = probe
            const frame = () => {
                if (location.pathname !== `/sessions/${id}`) { requestAnimationFrame(frame); return }
                probe.frames++
                const view = document.querySelector('.chat-scroll-y')
                if (!view?.querySelector('[data-chat-node-key]')) probe.blank++
                if (!view?.textContent?.includes(marker)) probe.missingLatest++
                if (view) probe.maxTailDistance = Math.max(probe.maxTailDistance, view.scrollHeight - view.clientHeight - view.scrollTop)
                if (probe.frames === 90) probe.done = true
                else requestAnimationFrame(frame)
            }
            requestAnimationFrame(frame)
        }, { id: primary.id, marker })
        await screen.getByRole('button').filter({ hasText: primary.metadata.name }).tap()
        await expect.poll(() => browser.evaluate(() => (window as unknown as { warmProbe: { done: boolean } }).warmProbe.done), { timeout: 15000 }).toBe(true)
        const probe = await browser.evaluate(() => (window as unknown as { warmProbe: { blank: number; missingLatest: number; maxTailDistance: number } }).warmProbe)
        console.log('Background update and return to latest:', JSON.stringify({ backgroundReads, ...probe }))
        expect(probe.blank).toBe(0)
        expect(probe.missingLatest).toBe(0)
        expect(probe.maxTailDistance).toBeLessThanOrEqual(1)
    } finally {
        release()
        await expect.poll(() => pending).toBe(0)
        await browser.unroute(pattern)
    }
})
