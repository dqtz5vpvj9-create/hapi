import { expect, test } from '@playwright/test'

for (const width of [390, 1280]) {
    test(`property: cancelling a settings draft preserves the saved value at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 })
        await page.goto('/e2e-fixtures/settings-fixture.html')
        // Mobile category labels include their current setting summary.
        const display = page.getByRole('button', { name: /^Display(?: |$)/ })
        await expect(display).toBeVisible()
        await display.click()
        const input = page.getByRole('spinbutton', { name: 'Sessions Before Folding' })
        await expect(input).toBeVisible()
        const saved = await input.inputValue()
        await input.fill(saved === '17' ? '23' : '17')
        await input.press('Escape')
        await expect(input).toHaveValue(saved)
        await page.reload()
        await expect(display).toBeVisible()
        await display.click()
        await expect(input).toHaveValue(saved)
    })
}

for (const width of [320, 390, 768, 1280]) {
    test(`exploration: workspace controls at ${width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 844 })
        await page.goto('/e2e-fixtures/workspace-fixture.html?split')
        await expect(page.locator('[data-workspace-ready=true]')).toBeVisible({ timeout: 15000 })
        await page.screenshot({ path: testInfo.outputPath('workspace.png'), fullPage: true })
        await expect(page.locator('.workspace-pane:visible .app-composer-toolbar button').first()).toBeVisible()
        const controls = await page.locator('.workspace-bottom button, .workspace-pane:visible .app-composer-toolbar button').evaluateAll(nodes => nodes.map(node => {
            const rect = node.getBoundingClientRect()
            const style = getComputedStyle(node)
            return { label: node.getAttribute('aria-label') || node.textContent, width: rect.width, height: rect.height, x: rect.x, y: rect.y, display: style.display, visible: rect.width > 0 && rect.height > 0 }
        }))
        await testInfo.attach('control-geometry', { body: JSON.stringify(controls, null, 2), contentType: 'application/json' })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        if (width < 768) {
            expect(controls.filter(control => control.visible).length).toBeGreaterThan(5)
            expect(controls.filter(control => control.visible).every(control => control.height >= 40 && control.width >= 32), JSON.stringify(controls)).toBe(true)
        }
    })
}

for (const width of [390, 1280]) {
    test(`property: editor and window round trips preserve drafts at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 })
        await page.goto('/e2e-fixtures/workspace-fixture.html?split')
        const input = page.getByRole('textbox', { name: 'Describe a task · @ session…', exact: true }).last()
        await expect(input).toBeVisible()
        await input.fill('保留草稿：cancel / restore / 中文')
        await page.getByRole('button', { name: 'Expand message editor', exact: true }).last().click()
        await page.getByRole('button', { name: 'Done', exact: true }).click()
        await expect(input).toHaveText('保留草稿：cancel / restore / 中文')
        await page.getByRole('button', { name: 'Window actions', exact: true }).click()
        await page.getByRole('button', { name: 'New window', exact: true }).click()
        // On mobile an empty window opens the conversation picker.
        if (width < 768) await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Window 2', exact: true })).toBeVisible()
        await page.getByRole('button', { name: 'Window actions', exact: true }).click()
        await page.getByRole('button', { name: 'Close window', exact: true }).click()
        await expect(input).toHaveText('保留草稿：cancel / restore / 中文')
        await page.getByRole('button', { name: 'Window actions', exact: true }).click()
        await page.getByRole('button', { name: 'Restore closed window', exact: true }).click()
        await expect(page.getByRole('button', { name: 'Window 2', exact: true })).toBeVisible()
    })
}
