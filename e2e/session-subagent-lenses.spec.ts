import { expect, test } from '@playwright/test'
import { toSessionSummary } from '../shared/src/sessionSummary'
import type { Session } from '../shared/src/types'

test.use({ serviceWorkers: 'block' })

for (const width of [390, 1440]) {
    test(`Unread counts main conversations and preserves manual child expansion at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        const at = Date.now()
        const session = (id: string, name: string, parent?: string, running = false): Session => ({
            id, namespace: 'fixture', seq: 1, createdAt: at - 1000, updatedAt: at,
            active: running, activeAt: at, thinking: running, thinkingAt: at,
            metadata: { name, path: '/work', host: 'CHRIS', flavor: 'codex',
                machineId: 'machine-chris', codexSessionId: id, codexParentThreadId: parent },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
        })
        const sessions = [session('chat-1', 'Unread main'), session('unread-child', 'Unread child', 'chat-1'),
            session('chat-3', 'Read main'), session('running-child', 'Running child', 'chat-3', true),
            session('orphan-child', 'Orphan child', 'missing-parent', true)]
        await page.addInitScript(() => {
            localStorage.setItem('hapi-lang', 'en')
            localStorage.setItem('hapi.sessionListView', 'recent')
            localStorage.setItem('hapi-session-list-status-mode', 'standard')
        })
        await page.route('**/api/sessions', route => route.fulfill({ json: {
            sessions: sessions.map(toSessionSummary),
            readStates: Object.fromEntries(sessions.map(s => [s.id, {
                version: 1, seenAt: s.id === 'chat-3' ? at : at - 1000, manualUnreadAt: null,
            }])),
        } }))
        await page.goto('/e2e-fixtures/workspace-fixture.html?list&presence&presenceSample')
        const list = page.getByTestId('recent-session-list')
        await expect(list.getByText('Unread main', { exact: true })).toBeVisible()
        await expect(page.getByRole('button', { name: width === 390 ? 'Unread 1' : 'Mark all as read (1)', exact: true })).toBeVisible()
        if (width === 390) {
            await page.getByRole('button', { name: 'Running 0', exact: true }).click()
            await expect(list.getByText('Read main', { exact: true })).toHaveCount(0)
            await expect(list.getByText('Orphan child', { exact: true })).toHaveCount(0)
            await page.getByRole('button', { name: 'Unread 1', exact: true }).click()
        } else {
            await page.locator('[data-list-unread-filter]').click()
        }
        await expect(list.getByText('Unread main', { exact: true })).toBeVisible()
        await expect(list.getByText('Read main', { exact: true })).toHaveCount(0)
        await expect(list.getByText('Unread child', { exact: true })).toHaveCount(0)
        await expect(list.getByText('Running child', { exact: true })).toHaveCount(0)
        await expect(list.getByText('Orphan child', { exact: true })).toHaveCount(0)
        await list.getByRole('button', { name: 'Subagents (1)', exact: true }).click()
        await expect(list.getByText('Unread child', { exact: true })).toBeVisible()
    })
}
