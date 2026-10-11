import { expect, test } from '@playwright/test'
import { toSessionSummary } from '../shared/src/sessionSummary'
import type { Session } from '../shared/src/types'
import type { SessionReadState } from '../shared/src/schemas'

// Keep the simulated Hub boundary visible to Playwright routes.
test.use({ serviceWorkers: 'block' })

for (const width of [390, 1440]) {
    test(`Standard mode keeps a finished result unread behind the list at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        const at = Date.now() + 10000
        const session: Session = {
            id: 'chat-2', namespace: 'fixture', seq: 320, createdAt: at - 1000, updatedAt: at,
            active: true, activeAt: at, thinking: true, thinkingAt: at, executionVersion: 1,
            metadata: { name: 'Finished result', path: '/mnt/cache/src/hapi', host: 'CHRIS',
                flavor: 'codex', machineId: 'machine-chris', codexSessionId: 'native-2', codexNativeSession: true, codexUpdatedAt: at },
            metadataVersion: 1, agentState: null, agentStateVersion: 0,
            execution: { owner: 'machine-chris', generation: 'g1', sequence: 1, status: 'active', waitingOn: [], turnId: 'turn', startedAt: at, completedAt: null },
        }
        let state: SessionReadState = { version: 1, seenAt: at, manualUnreadAt: null }
        const acknowledgements: number[] = []
        await page.addInitScript(() => {
            localStorage.setItem('hapi-lang', 'en')
            localStorage.setItem('hapi.sessionListView', 'recent')
            localStorage.setItem('hapi-session-list-status-mode', 'standard')
        })
        await page.route('**/api/sessions', route => route.fulfill({ json: { sessions: [toSessionSummary(session)], readStates: { [session.id]: state } } }))
        await page.route('**/api/sessions/*/read-state', async route => {
            const input = route.request().postDataJSON()
            acknowledgements.push(input.seenAt)
            const applied = input.expectedVersion === state.version
            if (applied) state = { version: state.version + 1, seenAt: Math.max(state.seenAt, input.seenAt), manualUnreadAt: input.manualUnreadAt }
            await route.fulfill({ json: { applied, state } })
        })
        await page.goto('/e2e-fixtures/workspace-fixture.html?split&list&presence&presenceSample')
        const row = page.locator('[data-testid="recent-session-list"] .session-list-item').filter({ hasText: 'Finished result' })
        await expect(row).toBeVisible()
        await expect(row.locator('[data-session-status="unread"]')).toHaveCount(0)
        const title = row.locator('.app-session-row-title')
        const titlePosition = await title.boundingBox()
        const baseline = acknowledgements.length
        session.thinking = false
        session.updatedAt = at + 1000
        session.executionVersion = 2
        session.execution = { ...session.execution!, sequence: 2, status: 'idle', completedAt: session.updatedAt }
        session.metadata = { ...session.metadata!, codexUpdatedAt: session.updatedAt }
        session.metadataVersion++
        await page.evaluate(session => window.__workspaceFixture.presenceEvent({ type: 'session-updated', sessionId: session.id, data: session }), session)
        const dot = row.locator('[data-session-status="unread"] > span[aria-hidden="true"]')
        await expect(dot).toBeVisible()
        await expect(dot).toHaveCSS('background-color', 'rgb(59, 130, 246)')
        await expect(dot).toHaveCSS('width', '10px')
        expect(Math.abs((await title.boundingBox())!.x - titlePosition!.x)).toBeLessThanOrEqual(1)
        await expect(page.getByRole('button', { name: width === 390 ? 'Unread 1' : 'Mark all as read (1)', exact: true })).toBeVisible()
        await expect(row.locator('[data-machine-id="machine-chris"]')).toHaveAttribute('aria-label', 'CHRIS (Linux)')
        if (width === 390) await expect(row.locator('.app-session-row-mobile-meta')).not.toContainText('CHRIS')
        expect(acknowledgements).toHaveLength(baseline)
        await page.waitForTimeout(250) // Let retained-pane effects settle while the list remains visible.
        expect(acknowledgements).toHaveLength(baseline)
        await expect(dot).toBeVisible()
        await row.click()
        await expect(page.locator('[data-session-id="chat-2"] .chat-scroll-y').first()).toBeVisible()
        await expect.poll(() => state.seenAt).toBeGreaterThanOrEqual(session.updatedAt)
        await page.evaluate(() => window.__workspaceFixture.navigate('/sessions?view=list'))
        await expect(row.locator('[data-session-status="unread"]')).toHaveCount(0)
    })
}
