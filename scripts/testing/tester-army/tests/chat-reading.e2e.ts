import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const capture = process.env.HAPI_REPLAY_DATA!
const listed = JSON.parse(readFileSync(join(capture, 'session-list.json'), 'utf8')).sessions as {
    id: string; metadata?: { name?: string }
}[]
const captured = listed.filter(session => existsSync(join(capture, session.id + '.json')))
const sessions = captured.map((session, index) => [`Captured session ${index + 1}`, session.id] as const)
const primary = captured.find(session => session.id === process.env.HAPI_REPLAY_PRIMARY_SESSION)
if (!primary?.metadata?.name) throw new Error('Set HAPI_REPLAY_PRIMARY_SESSION to a captured long Codex session with tools and a unique title')
const primaryId = primary.id
const primaryTitle = primary.metadata.name

for (const [name, id] of sessions) {
    test(`${name}: open chat, resize editor, keep the draft and reload history`, async ({ app, browser, screen }) => {
        await app.open(`/sessions/${id}`)
        await expect(browser.locator('[data-chat-node-key]').first()).toBeVisible()
        const editor = screen.getByTestId('rich-composer-input')
        await editor.fill('E2E local draft — do not send')
        await browser.setViewport({ width: 390, height: 580 })
        await expect(editor).toHaveValue('E2E local draft — do not send')
        await browser.setViewport({ width: 390, height: 844 })
        await expect(editor).toHaveValue('E2E local draft — do not send')
        await editor.fill('')
        await browser.reload()
        await expect(browser.locator('[data-chat-node-key]').first()).toBeVisible()
        await expect(screen.getByRole('alert')).not.toBeVisible()
    })
}

test('tool details show actual results without a hidden history error', async ({ app, browser, screen }) => {
    await app.open(`/sessions/${primaryId}`)
    await screen.getByRole('button', /^Process \(/).first().tap()
    const tool = screen.getByRole('button', /^CodexBash completed/).first()
    await expect(tool).toBeVisible()
    const height = (await tool.boundingBox())!.height
    expect(height).toBeLessThanOrEqual(32)
    // A visible dialog alone cannot prove that its content loaded successfully.
    const result = browser.waitForResponse('**/messages/dependencies?**')
    await tool.tap()
    const dialog = screen.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Input', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Result', { exact: true })).toBeVisible()
    await expect(dialog.getByText(/^exit \d+$/)).toBeVisible()
    const response = await result
    expect(response.status).toBe(200)
    expect((await response.json() as { reset?: boolean }).reset).toBe(false)
    await expect(screen.getByRole('alert')).not.toBeVisible()
    await browser.keyboard.press('Escape')
    await expect(screen.getByRole('dialog')).not.toBeVisible()
})

test('reading a real partial turn survives reload at the same position', async ({ app, browser, screen }) => {
    await app.open(`/sessions/${primaryId}`)
    await expect(browser.locator('[data-chat-node-key]').first()).toBeVisible()
    const view = browser.locator('.chat-scroll-y')
    const bounds = (await view.boundingBox())!
    await browser.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    // Each action must actually reveal an earlier page; no assumed one-page gesture.
    for (let i = 0; i < 7; i++) {
        const previous = await browser.evaluate(() => document.querySelector('[data-chat-node-key]')?.getAttribute('data-chat-node-key') ?? '')
        await browser.mouse.wheel(0, -4000)
        await expect.poll(() => browser.evaluate(() => document.querySelector('[data-chat-node-key]')?.getAttribute('data-chat-node-key') ?? ''), { timeout: 15000 }).not.toBe(previous)
    }
    await browser.mouse.wheel(0, 350)
    // Sample actual frames until input and pending layout have settled.
    await browser.evaluate(() => new Promise<void>(resolve => {
        const view = document.querySelector('.chat-scroll-y')!
        let last = view.scrollTop, stable = 0
        const frame = () => { const top = view.scrollTop; stable = Math.abs(top - last) < 0.5 ? stable + 1 : 0; last = top; if (stable >= 60) resolve(); else requestAnimationFrame(frame) }
        requestAnimationFrame(frame)
    }))
    const before = await browser.evaluate(() => {
        const view = document.querySelector('.chat-scroll-y')!, bounds = view.getBoundingClientRect()
        const padding = parseFloat(getComputedStyle(view).scrollPaddingTop) || 0
        const row = [...view.querySelectorAll<HTMLElement>('[data-chat-node-key]')].find(row => { const b = row.getBoundingClientRect(); return b.height > 0 && b.bottom > bounds.top + padding && b.top < bounds.bottom })!
        return { key: row.dataset.chatNodeKey!, top: row.getBoundingClientRect().top - bounds.top }
    })
    await browser.reload()
    await expect(browser.locator('[data-chat-node-key]').first()).toBeVisible()
    await expect.poll(() => browser.evaluate(before => {
        const view = document.querySelector('.chat-scroll-y')
        const row = [...document.querySelectorAll<HTMLElement>('[data-chat-node-key]')].find(row => row.dataset.chatNodeKey === before.key)
        return view && row ? Math.abs(row.getBoundingClientRect().top - view.getBoundingClientRect().top - before.top) : 1e9
    }, before), { timeout: 15000 }).toBeLessThanOrEqual(1)
    await expect(screen.getByRole('alert')).not.toBeVisible()
})

test('cached re-entry keeps loaded content while the tail request is held', async ({ app, browser, screen }) => {
    const id = primaryId
    await app.open(`/sessions/${id}`)
    await expect(browser.locator('[data-chat-node-key]').first()).toBeVisible()
    await screen.getByRole('button', 'Back', { exact: true }).tap()
    await expect(browser).toHaveURL('/sessions')
    let release!: () => void
    let held = false
    let inFlight = 0
    const gate = new Promise<void>(resolve => { release = resolve })
    await browser.route(`**/api/sessions/${id}/messages?**`, async route => {
        if (route.request.url.includes('beforeSeq=')) return route.continue()
        held = true
        inFlight++
        try { await gate; await route.continue() }
        finally { inFlight-- }
    })
    try {
        await screen.getByRole('button').filter({ hasText: primaryTitle }).tap()
        await expect.poll(() => held).toBe(true)
        await expect(browser.locator('[data-chat-node-key]').first()).toBeVisible()
        const frames = await browser.evaluate(() => new Promise<{ frames: number; blank: number }>(resolve => {
            let count = 0, blank = 0
            const tick = () => { count++; if (!document.querySelector('[data-chat-node-key]')) blank++; if (count === 90) resolve({ frames: count, blank }); else requestAnimationFrame(tick) }
            requestAnimationFrame(tick)
        }))
        expect(frames.blank).toBe(0)
    } finally {
        release()
        await expect.poll(() => inFlight).toBe(0)
        await browser.unroute(`**/api/sessions/${id}/messages?**`)
    }
    await expect(browser.locator('[data-chat-node-key]').first()).toBeVisible()
})
