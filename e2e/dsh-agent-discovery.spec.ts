import { expect, test, type Locator, type Page } from '@playwright/test'
import type { AgentAvailabilityEntry } from '@hapi/protocol'

type DiscoveryProbe = {
    agents: AgentAvailabilityEntry[]
    checks: number
    spawns: { machineId: string; body: Record<string, unknown> }[]
}

declare global {
    interface Window { __dshDiscoveryFixture: DiscoveryProbe }
}

async function openNewTask(page: Page, locale = 'en') {
    await page.addInitScript(locale => {
        localStorage.setItem('hapi-lang', locale)
        localStorage.setItem('hapi:newSession:agent', 'codex')
        localStorage.setItem('hapi:newSession:yolo', 'true')
    }, locale)
    await page.goto('/e2e-fixtures/workspace-fixture.html?presenceSample&theme=codex')
    await page.waitForFunction(() => Boolean(window.__workspaceFixture))
    await page.evaluate(() => {
        const fixtureFetch = window.fetch.bind(window)
        const probe: DiscoveryProbe = {
            agents: [
                { agent: 'claude', available: true },
                { agent: 'codex', available: true },
                { agent: 'dsh', available: false, reason: 'not_found' },
                { agent: 'grok', available: false, reason: 'invalid_configuration' },
            ],
            checks: 0,
            spawns: [],
        }
        window.__dshDiscoveryFixture = probe
        // Keep the production router, API client, form, query and delivery code.
        // Extend only the existing simulated Hub's machine endpoints.
        window.fetch = async (input, init) => {
            const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
            if (url.pathname === '/api/codex/sessions') return Response.json({ success: true, sessions: [], nextCursor: null })
            const match = url.pathname.match(/^\/api\/machines\/([^/]+)(.*)$/)
            if (match?.[2] === '/agent-availability') {
                probe.checks++
                return Response.json({ agents: probe.agents })
            }
            if (match?.[2] === '/paths/exists') {
                const { paths } = JSON.parse(String(init?.body)) as { paths: string[] }
                return Response.json({ exists: Object.fromEntries(paths.map(path => [path, true])) })
            }
            if (match?.[2] === '/spawn') {
                probe.spawns.push({ machineId: match[1], body: JSON.parse(String(init?.body)) })
                // Use a session already served by the Hub fixture to exercise
                // initial-task delivery and navigation after the spawn response.
                return Response.json({ type: 'success', sessionId: 'chat-1' })
            }
            return fixtureFetch(input, init)
        }
        return window.__workspaceFixture.navigate('/sessions/new?machineId=machine-chris&directory=%2Fmnt%2Fcache%2Fsrc%2Fhapi')
    })
    const task = page.getByTestId('new-task-composer')
    await expect(task).toBeVisible()
    await task.getByRole('button', { name: /More settings|更多设置/ }).click()
    await expect(task.getByRole('radio', { name: 'Codex', exact: true })).toBeEnabled()
    await expect(task.getByRole('radio', { name: 'Codex', exact: true })).toBeChecked()
    return task
}

async function expectReachable(locator: Locator) {
    await expect(locator).toBeVisible()
    const geometry = await locator.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            width: innerWidth, height: innerHeight, hit: Boolean(hit && element.contains(hit)) }
    })
    expect(geometry.left).toBeGreaterThanOrEqual(0)
    expect(geometry.right).toBeLessThanOrEqual(geometry.width)
    expect(geometry.top).toBeGreaterThanOrEqual(0)
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.height)
    expect(geometry.hit).toBe(true)
}

test('discovers DSH through refresh, preserves selection, and creates a task with DSH launch semantics', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 960 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const task = await openNewTask(page)
    const otherAgents = task.getByRole('button', { name: /Other agents/ })
    await expect(task.locator('input[name="agent"]')).toHaveCount(2)
    await expect(task.getByRole('radio', { name: 'DeepSeek Harness' })).toHaveCount(0)
    await otherAgents.click()
    const dialog = page.getByRole('dialog', { name: 'Other supported agents' })
    const dsh = dialog.getByRole('listitem').filter({ hasText: 'DeepSeek Harness (DSH)' })
    await expect(dsh).toContainText('Launch command not found in the runner’s PATH.')
    await expect(dialog.getByRole('listitem').filter({ hasText: 'Grok' })).toContainText('configuration for this agent is invalid')
    await expect(dialog.getByRole('listitem').filter({ hasText: 'OpenCode' })).toContainText('This runner did not report this agent')
    await page.evaluate(() => {
        window.__dshDiscoveryFixture.agents = window.__dshDiscoveryFixture.agents.map(entry => entry.agent === 'dsh' ? { agent: 'dsh', available: true } : entry)
    })
    const previousChecks = await page.evaluate(() => window.__dshDiscoveryFixture.checks)
    await dialog.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.__dshDiscoveryFixture.checks)).toBeGreaterThan(previousChecks)
    await expect(dsh).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(otherAgents).toBeFocused()
    await expect(task.locator('input[name="agent"]')).toHaveCount(3)
    await expect(task.getByRole('radio', { name: 'Codex', exact: true })).toBeChecked()
    await task.getByRole('radio', { name: 'DeepSeek Harness', exact: true }).check()
    await expect(task.getByText('Configured by DSH', { exact: true })).toBeVisible()
    await expect(task.getByRole('button', { name: 'Permission Mode', exact: true })).toContainText('Managed by agent')
    await expect(task.getByRole('button', { name: /auto · auto/ })).toHaveCount(0)
    await task.getByRole('textbox', { name: 'Initial task' }).fill('Inspect the project with DeepSeek Harness.')
    const send = task.getByRole('button', { name: 'Send', exact: true })
    await expect(send).toBeEnabled()
    await expectReachable(send)
    await page.screenshot({ path: testInfo.outputPath('dsh-available-desktop.png') })
    await send.click()
    await expect.poll(() => page.evaluate(() => window.__dshDiscoveryFixture.spawns.length)).toBe(1)
    const [spawn] = await page.evaluate(() => window.__dshDiscoveryFixture.spawns)
    expect(spawn).toMatchObject({ machineId: 'machine-chris', body: { agent: 'dsh', directory: '/mnt/cache/src/hapi', sessionType: 'simple' } })
    for (const key of ['model', 'effort', 'modelReasoningEffort', 'yolo', 'permissionMode']) {
        expect(spawn.body).not.toHaveProperty(key)
    }
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.sends.length)).toBe(1)
    expect(await page.evaluate(() => window.__workspaceFixture.sends[0])).toMatchObject({ sessionId: 'chat-1', text: 'Inspect the project with DeepSeek Harness.' })
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.pathname())).toBe('/sessions/chat-1')
    expect(await page.evaluate(() => window.__workspaceFixture.unhandled)).toEqual([])
    expect(errors).toEqual([])
})

for (const scenario of [
    { name: 'phone', width: 390, height: 844, locale: 'en', fontSize: 16 },
    { name: 'small phone with large text', width: 320, height: 568, locale: 'en', fontSize: 20 },
    { name: 'Chinese phone', width: 390, height: 844, locale: 'zh-CN', fontSize: 20 },
]) {
    test(`agent diagnostics fit and remain keyboard-scrollable: ${scenario.name}`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: scenario.width, height: scenario.height })
        const task = await openNewTask(page, scenario.locale)
        await page.evaluate(fontSize => { document.documentElement.style.fontSize = `${fontSize}px` }, scenario.fontSize)
        const trigger = task.getByRole('button', { name: /Other agents|其他代理/ })
        await trigger.click()
        const dialog = page.getByRole('dialog', { name: /Other supported agents|其他受支持的代理/ })
        await expectReachable(dialog.getByRole('button', { name: /Refresh|刷新/ }))
        await page.screenshot({ path: testInfo.outputPath('dsh-unavailable-phone.png') })
        const list = dialog.getByRole('list')
        await page.keyboard.press('Tab')
        await expect(list).toBeFocused()
        await page.keyboard.press('End')
        await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
        await page.keyboard.press('Home')
        await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0)
        const dialogRect = await dialog.boundingBox()
        expect(dialogRect!.x).toBeGreaterThanOrEqual(0)
        expect(dialogRect!.x + dialogRect!.width).toBeLessThanOrEqual(scenario.width)
        expect(dialogRect!.y).toBeGreaterThanOrEqual(0)
        expect(dialogRect!.y + dialogRect!.height).toBeLessThanOrEqual(scenario.height)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        await expect(trigger).toBeFocused()
        await page.evaluate(() => {
            window.__dshDiscoveryFixture.agents = window.__dshDiscoveryFixture.agents.map(entry => entry.agent === 'dsh' ? { agent: 'dsh', available: true } : entry)
        })
        await trigger.click()
        await dialog.getByRole('button', { name: /Refresh|刷新/ }).click()
        await expect(dialog.getByText('DeepSeek Harness (DSH)', { exact: true })).toHaveCount(0)
        await page.keyboard.press('Escape')
        await task.getByRole('radio', { name: 'DeepSeek Harness', exact: true }).check()
        await expect(task.getByText(/Configured by DSH|由 DSH 配置/, { exact: true })).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: testInfo.outputPath('dsh-available-phone.png') })
        expect(await page.evaluate(() => window.__dshDiscoveryFixture.spawns)).toEqual([])
        expect(await page.evaluate(() => window.__workspaceFixture.unhandled)).toEqual([])
    })
}
