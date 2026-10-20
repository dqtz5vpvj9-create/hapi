import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

for (const [width, owner] of [[1440, 'linux'], [390, 'windows']] as const) {
    test(`live compaction explains delivery without accepting the message (${owner}, ${width}px)`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.addInitScript(() => localStorage.setItem('hapi-lang', 'en'))
        await page.goto('/e2e-fixtures/workspace-fixture.html?panes=1')
        await page.getByTestId('rich-composer-input').first().waitFor()
        await expect(page.locator('.hapi-native-thread')).toBeVisible()
        const execution = { owner, generation: 'g1', sequence: 1, status: 'active', waitingOn: [],
            turnId: 'turn', startedAt: Date.now(), completedAt: null }
        const publish = (event: unknown) => page.evaluate(event => window.__workspaceFixture.presenceEvent(event as never), event)
        await publish({ type: 'session-updated', sessionId: 'chat-1', data: { active: true, thinking: true, executionVersion: 1, execution } })
        await publish({ type: 'message-received', sessionId: 'chat-1', message: {
            id: 'compaction-queue-message', localId: 'compaction-queue-local', seq: null, createdAt: Date.now(), invokedAt: null,
            deliveryState: 'dispatching', content: { role: 'user', content: { type: 'text', text: 'Compaction delivery fixture' } },
        } })
        const queue = page.getByRole('status', { name: '1 queued message pending invocation', exact: true })
        await expect(queue).toContainText('Confirming delivery…')
        await publish({ type: 'session-updated', sessionId: 'chat-1', data: { executionVersion: 2,
            execution: { ...execution, sequence: 2, compacting: true } } })
        await expect(page.locator('[data-execution-state="compacting"]')).toHaveText('Compacting context…')
        await expect(queue).toContainText('Confirming delivery · Codex is compacting context')
        await expect(page.locator('.workspace-activity').first()).toHaveAttribute('aria-label', 'Compacting context…')
        // A stale completion packet must not erase the more recent live start.
        await publish({ type: 'session-updated', sessionId: 'chat-1', data: { executionVersion: 1, execution } })
        await expect(page.locator('[data-execution-state="compacting"]')).toBeVisible()
        await publish({ type: 'session-updated', sessionId: 'chat-1', data: { executionVersion: 3,
            execution: { ...execution, sequence: 3 } } })
        await expect(page.locator('[data-execution-state="compacting"]')).toHaveCount(0)
        await expect(queue).toContainText('Compaction delivery fixture')
        await expect(queue).toContainText('Confirming delivery…')
        await publish({ type: 'messages-consumed', sessionId: 'chat-1', localIds: ['compaction-queue-local'], invokedAt: Date.now() })
        await expect(queue).toHaveCount(0)
    })
}
