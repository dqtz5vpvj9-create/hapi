import { expect, test as base, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { WorkspaceSnapshot } from '@hapi/protocol/workspaces'

type Hub = { url: string; token: string }
const test = base.extend<{ hub: Hub; other: Page }>({
    hub: async ({}, use) => {
        const process = spawn('bun', [join(__dirname, '../hub/scripts/workspace-sync-test-server.ts')], { stdio: ['ignore', 'pipe', 'pipe'] })
        const lines = createInterface({ input: process.stdout })
        let errors = ''
        process.stderr.on('data', chunk => { errors += chunk.toString() })
        try {
            const hub = await new Promise<Hub>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`Workspace fixture did not start: ${errors}`)), 15_000)
                lines.once('line', line => { clearTimeout(timer); resolve(JSON.parse(line)) })
                process.once('exit', code => { clearTimeout(timer); reject(new Error(`Workspace fixture exited ${code}: ${errors}`)) })
            })
            await use(hub)
        } finally {
            lines.close()
            if (process.exitCode === null) {
                const stopped = new Promise(resolve => process.once('exit', resolve))
                process.kill('SIGTERM')
                await stopped
            }
        }
    },
    other: async ({ browser }, use) => {
        const context = await browser.newContext({ viewport: { width: 1600, height: 960 } })
        try { await use(await context.newPage()) } finally { await context.close() }
    },
})
test.use({ viewport: { width: 1600, height: 960 } })
const pane = (page: Page, id: number) => page.locator(`[data-pane-id][data-session-id="chat-${id}"]`)
const editor = (page: Page, id: number) => pane(page, id).locator('[contenteditable]:not([contenteditable="false"])')
async function prefix(page: Page, key: string) { await page.keyboard.press('Control+b'); await page.keyboard.press(key) }
async function state(page: Page) {
    return page.evaluate(() => {
        const key = Object.keys(localStorage).find(k => k.startsWith('hapi:workspaces:v1:'))!
        return JSON.parse(localStorage.getItem(key)!)
    })
}
async function settled(page: Page) {
    try { await expect.poll(async () => (await state(page))?.sync).toMatchObject({ status: 'synced', pending: 0 }) }
    catch (error) {
        console.error('Unsettled layout', JSON.stringify(await state(page)))
        console.error('Recent API calls', await page.evaluate(() => window.__workspaceFixture.requests.slice(-20)))
        throw error
    }
}
async function open(page: Page, hub: Hub, join = false) {
    await page.goto(`/e2e-fixtures/workspace-fixture.html?${new URLSearchParams({ split: '', ...(join ? { join: '' } : {}), remoteWorkspaces: hub.url, workspaceToken: hub.token })}`, { waitUntil: 'domcontentloaded' })
    await expect(pane(page, 1)).toBeVisible(); await expect(pane(page, 2)).toBeVisible()
    await settled(page)
}
async function read(page: Page, hub: Hub): Promise<WorkspaceSnapshot> {
    const response = await page.request.get(`${hub.url}/api/workspaces`, { headers: { authorization: `Bearer ${hub.token}` } })
    expect(response.ok()).toBe(true)
    return response.json()
}
async function rename(page: Page, name: string) {
    await page.locator('.workspace-tab > button[aria-current="page"]').dblclick()
    await page.getByRole('textbox', { name: 'Rename window', exact: true }).fill(name)
    await page.keyboard.press('Enter')
}
async function create(page: Page, name: string) {
    await prefix(page, 'c')
    await rename(page, name)
}

test('shares real Hub layouts across desktop/mobile while preserving independent focus, drafts and zoom', async ({ page, other, hub }) => {
    await open(page, hub); await open(other, hub, true)
    await editor(page, 1).fill('Desktop draft stays local')
    await prefix(page, 'z')
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1)
    await other.setViewportSize({ width: 390, height: 844 })
    await other.getByRole('button', { name: 'P2', exact: true }).click()
    await editor(other, 2).fill('Phone draft stays local')
    const revision = (await read(page, hub)).revision
    await rename(other, 'Shared development')
    await settled(other)
    await expect(page.locator('.workspace-tab')).toContainText('Shared development')
    await expect(editor(page, 1)).toHaveText('Desktop draft stays local')
    await expect(page.locator('[data-pane-id]:visible')).toHaveCount(1)
    expect((await read(page, hub)).revision).toBe(revision + 1)
    await expect(editor(other, 2)).toHaveText('Phone draft stays local')
    await page.reload(); await other.reload()
    await expect(editor(page, 1)).toHaveText('Desktop draft stays local')
    await expect(editor(other, 2)).toHaveText('Phone draft stays local')
    await prefix(page, 'z')
    await expect(editor(page, 2)).toBeEmpty()
    await other.getByRole('button', { name: 'P1', exact: true }).click()
    await expect(editor(other, 1)).toBeEmpty()
})

test('keeps the live editor on remote close, persists its draft, and shares it again only on request', async ({ page, other, hub }) => {
    await open(page, hub); await open(other, hub, true)
    await editor(page, 1).fill('Must survive the other device closing this workspace')
    await editor(page, 1).evaluate(e => { (window as any).__protectedEditor = e })
    await other.getByRole('button', { name: 'Window actions', exact: true }).click()
    await other.getByRole('button', { name: 'Close window', exact: true }).click()
    await settled(other)
    await expect(page.getByText('Changed on another device. Your local view and draft are kept.', { exact: true })).toBeVisible()
    expect(await editor(page, 1).evaluate(e => e === (window as any).__protectedEditor)).toBe(true)
    expect((await read(page, hub)).workspaces).toHaveLength(0)
    await page.reload()
    await expect(editor(page, 1)).toHaveText('Must survive the other device closing this workspace')
    await page.getByRole('button', { name: 'Save as a window', exact: true }).click()
    await settled(page)
    await expect(pane(other, 1)).toBeVisible()
    await expect(editor(other, 1)).toBeEmpty()
    expect((await read(page, hub)).workspaces).toHaveLength(1)
    await expect(page.locator('.workspace-temporary')).toHaveCount(0)
})

test('replays a workspace created offline after refresh alongside another device rename', async ({ page, other, hub }) => {
    await open(page, hub); await open(other, hub, true)
    let offline = true
    await page.route(`${hub.url}/api/workspaces**`, route => offline ? route.abort('internetdisconnected') : route.continue())
    await create(page, 'Offline research')
    await page.locator('.app-session-sidebar-frame').getByText('工作区交互设计', { exact: true }).click()
    await expect(pane(page, 3)).toBeVisible()
    await editor(page, 3).fill('Unsent offline draft')
    await expect(page.getByRole('button', { name: 'Saved locally · Retry', exact: true })).toBeVisible()
    await rename(other, 'Renamed remotely'); await settled(other)
    await page.reload()
    await expect(editor(page, 3)).toHaveText('Unsent offline draft')
    offline = false
    await page.getByRole('button', { name: 'Saved locally · Retry', exact: true }).click()
    await settled(page)
    await expect(other.locator('.workspace-tabs')).toContainText('Offline research')
    expect((await read(page, hub)).workspaces.map(w => w.name)).toEqual(['Renamed remotely', 'Offline research'])
    await expect(editor(page, 3)).toHaveText('Unsent offline draft')
    expect(await page.evaluate(() => window.__workspaceFixture.sends)).toEqual([])
})

test('does not duplicate a workspace after the Hub commits but the acknowledgement is lost', async ({ page, other, hub }) => {
    await open(page, hub); await open(other, hub, true)
    let lose = true, offline = false
    await page.route(`${hub.url}/api/workspaces**`, async route => {
        if (offline) { await route.abort('internetdisconnected'); return }
        if (lose && route.request().method() === 'POST') {
            lose = false; await route.fetch(); offline = true
            await route.abort('connectionreset'); return
        }
        await route.continue()
    })
    await prefix(page, 'c')
    await expect(other.locator('.workspace-tabs')).toContainText('Window 2')
    await expect(page.getByRole('button', { name: 'Saved locally · Retry', exact: true })).toBeVisible()
    const revision = (await read(page, hub)).revision
    await page.reload()
    await expect(page.getByRole('button', { name: 'Saved locally · Retry', exact: true })).toBeVisible()
    offline = false
    await page.getByRole('button', { name: 'Saved locally · Retry', exact: true }).click()
    await settled(page)
    const snapshot = await read(page, hub)
    expect(snapshot.revision).toBe(revision)
    expect(snapshot.workspaces.filter(w => w.name === 'Window 2')).toHaveLength(1)
})
