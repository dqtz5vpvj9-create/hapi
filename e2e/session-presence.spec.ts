import { expect, test, type Page } from '@playwright/test'
import { toSessionSummary } from '../shared/src/sessionSummary'
import type { Session } from '../shared/src/types'

const at = Date.now() - 5000
const source = (id: string, machineId: string, name: string): Session => ({
    id, namespace: 'fixture', seq: 320, createdAt: at - 1000, updatedAt: at,
    active: true, activeAt: at, thinking: false, thinkingAt: at, executionVersion: 1,
    metadata: { host: machineId, path: '/mnt/cache/src/hapi', name, machineId,
        flavor: 'codex', codexSessionId: 'same-native-thread', codexStoreId: '/native/store', codexUpdatedAt: at },
    metadataVersion: 1, agentState: null, agentStateVersion: 0,
    execution: { owner: machineId, generation: 'g1', sequence: 1, status: 'idle', waitingOn: [],
        turnId: 'turn', startedAt: null, completedAt: at }
})

test('two clients retain machine identity and state order, and share read/unread changes', async ({ browser }) => {
    const contexts = await Promise.all([browser.newContext({ viewport: { width: 1440, height: 900 } }),
        browser.newContext({ viewport: { width: 390, height: 844 } })])
    const pages = await Promise.all(contexts.map(context => context.newPage()))
    const records = [source('chat-1', 'linux-machine', 'Linux task'), source('chat-2', 'windows-machine', 'Windows task')]
    const readStates: Record<string, { version: number; seenAt: number; manualUnreadAt: number | null }> = {
        'chat-1': { version: 1, seenAt: at, manualUnreadAt: null }, 'chat-2': { version: 1, seenAt: at, manualUnreadAt: null }
    }
    const publish = async (event: unknown) => {
        await Promise.all(pages.map(page => page.evaluate(event => window.__workspaceFixture.presenceEvent(event as never), event)))
    }
    for (const [index, page] of pages.entries()) {
        await page.addInitScript(() => {
            localStorage.setItem('hapi-lang', 'en')
            localStorage.setItem('hapi.sessionListView', 'recent')
            localStorage.setItem('hapi-session-list-status-mode', 'detailed')
        })
        await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: records.map(toSessionSummary), readStates } }))
        await page.route('**/api/sessions/*/read-state', async route => {
            const id = new URL(route.request().url()).pathname.split('/')[3]
            const input = route.request().postDataJSON()
            const current = readStates[id] ?? { version: 0, seenAt: 0, manualUnreadAt: null }
            const applied = input.expectedVersion === current.version
            if (applied) readStates[id] = { version: current.version + 1,
                seenAt: Math.max(current.seenAt, input.seenAt), manualUnreadAt: input.manualUnreadAt }
            await route.fulfill({ json: { applied, state: readStates[id] } })
            if (applied) await publish({ type: 'session-read-state', namespace: 'fixture', userId: 1, sessionId: id, state: readStates[id] })
        })
        await page.goto('/e2e-fixtures/workspace-fixture.html?list&presence')
        await expect(page.getByText('Linux task', { exact: true })).toBeVisible()
        await expect(page.getByText('Windows task', { exact: true })).toBeVisible()
        await expect(page.locator('[data-testid="recent-session-list"] [data-machine-id="windows-machine"]')).toBeVisible()
        if (index === 1) await expect(page.getByRole('button', { name: 'Running 0', exact: true })).toBeVisible()
    }
    const row = (page: Page) => page.locator('[data-testid="recent-session-list"] .session-list-item').filter({ hasText: 'Linux task' })
    const handle = await row(pages[1]).elementHandle()
    await publish({ type: 'session-updated', sessionId: 'chat-1', data: { executionVersion: 3, thinking: false,
        execution: { ...records[0].execution!, sequence: 3, status: 'idle' } } })
    await publish({ type: 'session-updated', sessionId: 'chat-1', data: { executionVersion: 2, thinking: true,
        execution: { ...records[0].execution!, sequence: 2, status: 'active' } } })
    for (const page of pages) await expect(row(page).locator('[data-session-status="running"]')).toHaveCount(0)
    expect(await handle!.evaluate(element => element.isConnected)).toBe(true)

    await row(pages[0]).click({ button: 'right' })
    await pages[0].getByRole('menuitem', { name: /Mark.*unread/i }).click()
    for (const page of pages) await expect(row(page).locator('[data-session-status="unread"]')).toBeVisible()
    expect(readStates['chat-1'].manualUnreadAt).toBe(at)
    // A duplicate old event cannot clear the explicit newer unread state.
    await publish({ type: 'session-read-state', namespace: 'fixture', userId: 1, sessionId: 'chat-1',
        state: { version: 1, seenAt: at, manualUnreadAt: null } })
    await expect(row(pages[1]).locator('[data-session-status="unread"]')).toBeVisible()
    await Promise.all(contexts.map(context => context.close()))
})
