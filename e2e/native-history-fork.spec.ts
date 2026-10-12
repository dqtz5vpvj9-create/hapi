import { expect, test } from '@playwright/test'

const nativeBoundary = { threadId: 'fixture-native-thread', turnId: 'fixture-native-turn', itemId: 'request' }

for (const mobile of [false, true]) {
    test(`forks a first native user input through the production action (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
        if (mobile) await page.setViewportSize({ width: 390, height: 844 })
        const errors: string[] = []
        const requests: unknown[] = []
        let rejectBoundary = false
        page.on('pageerror', error => errors.push(error.message))
        await page.route('**/api/sessions/history-load-fixture/fork', async route => {
            requests.push(route.request().postDataJSON())
            await route.fulfill(rejectBoundary
                ? { status: 409, json: { error: 'Native boundary rejected by the source thread' } }
                : { status: 200, json: { sessionId: 'native-fork-child' } })
        })
        await page.goto('/e2e-fixtures/history-load-fixture.html?nativeChat=1&nativeFork=1')
        const firstInput = page.locator('[data-hapi-message-role="user"]').filter({ hasText: 'Review the native chat upgrade.' })
        await expect(firstInput).toBeVisible()
        await firstInput.hover()
        await firstInput.getByRole('button', { name: 'Fork', exact: true }).click()
        await page.screenshot({ path: test.info().outputPath(`native-fork-confirm-${mobile ? 'mobile' : 'desktop'}.png`) })
        await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
        expect(requests).toEqual([])

        await page.evaluate(() => { window.__probe.failForkNavigation = true })
        await firstInput.hover()
        await firstInput.getByRole('button', { name: 'Fork', exact: true }).click()
        await page.getByRole('dialog').getByRole('button', { name: 'Fork', exact: true }).click()
        await expect(page.getByRole('alert')).toHaveText('Fixture navigation failed')
        expect(requests).toEqual([{ nativeBoundary }])

        // Replay source data before retrying navigation.
        await page.evaluate(() => {
            window.__probe.failForkNavigation = false
            window.__nativeReplay.apply('completed', 'The original conversation remains unchanged.')
        })
        await page.getByRole('dialog').getByRole('button', { name: 'Fork', exact: true }).click()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect.poll(() => page.evaluate(() => window.__probe.forkDestination)).toBe('native-fork-child')
        expect(await page.evaluate(() => window.__probe.forkNavigations)).toBe(2)
        expect(requests).toEqual([{ nativeBoundary }])
        await expect(firstInput).toBeVisible()

        rejectBoundary = true
        await firstInput.hover()
        await firstInput.getByRole('button', { name: 'Fork', exact: true }).click()
        await page.getByRole('dialog').getByRole('button', { name: 'Fork', exact: true }).click()
        await expect(page.getByRole('alert')).toHaveText('Native boundary rejected by the source thread')
        expect(await page.evaluate(() => window.__probe.forkNavigations)).toBe(2)
        await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()

        rejectBoundary = false
        await page.goto('/e2e-fixtures/history-load-fixture.html?nativeChat=1&nativeFork=1&currentFork=1')
        const answer = page.locator('[data-hapi-message-role="assistant"]').filter({ hasText: 'The native chat upgrade is ready for verification.' })
        await answer.hover()
        await answer.getByRole('button', { name: 'Fork', exact: true }).click()
        await page.getByRole('dialog').getByRole('button', { name: 'Fork', exact: true }).click()
        await expect.poll(() => page.evaluate(() => window.__probe.forkDestination)).toBe('native-fork-child')
        expect(requests).toEqual([{ nativeBoundary }, { nativeBoundary }, {}])

        await page.goto('/e2e-fixtures/history-load-fixture.html?nativeChat=1&nativeFork=1&steeredFork=1')
        await expect(firstInput).toBeVisible()
        await expect(firstInput.getByRole('button', { name: 'Fork', exact: true })).toHaveCount(0)
        await page.screenshot({ path: test.info().outputPath(`native-fork-steered-${mobile ? 'mobile' : 'desktop'}.png`) })
        expect(requests).toEqual([{ nativeBoundary }, { nativeBoundary }, {}])

        await page.goto('/e2e-fixtures/history-load-fixture.html?nativeChat=1&nativeFork=1&steeredFork=1&currentFork=1')
        await firstInput.hover()
        await firstInput.getByRole('button', { name: 'Fork', exact: true }).click()
        await page.getByRole('dialog').getByRole('button', { name: 'Fork', exact: true }).click()
        await expect.poll(() => page.evaluate(() => window.__probe.forkDestination)).toBe('native-fork-child')
        expect(requests).toEqual([{ nativeBoundary }, { nativeBoundary }, {}, {}])
        expect(errors).toEqual([])
    })
}
