import { expect, test, type Locator, type Page } from '@playwright/test'

async function documentAction(page: Page, surface: Locator, name: string) {
    await surface.getByRole('button', { name: 'Document actions', exact: true }).click()
    await page.getByRole('dialog', { name: 'Document actions', exact: true }).getByRole('button', { name, exact: true }).click()
}

for (const width of [390, 1440]) {
    for (const format of ['pptx', 'pdf']) {
        test(`hides rendered ${format} pages across pane and workspace switches at ${width}px`, async ({ page }) => {
            await page.setViewportSize({ width, height: 844 })
            await page.goto(`/e2e-fixtures/workspace-fixture.html?panes=1&documents=1&documentSample=pane-visibility.${format}`)
            const surface = page.locator('.document-surface')
            const ready = surface.locator('.document-page[aria-busy="false"]')
            await expect(ready).toBeVisible({ timeout: 30000 })
            await surface.getByRole('button', { name: 'Next page', exact: true }).click()
            await expect(ready).toBeVisible()
            await expect(surface.locator('.textLayer')).toContainText('Second page')
            await surface.getByRole('button', { name: 'Zoom', exact: true }).click()
            await page.getByRole('dialog', { name: 'Zoom', exact: true }).getByRole('button', { name: 'Zoom in', exact: true }).click()
            await page.keyboard.press('Escape')
            await expect(ready).toBeVisible()

            // Sample intermediate frames too: the hidden pane must retain its
            // geometry without leaving canvas pixels or a selectable text layer.
            await page.evaluate(() => {
                const probe = { frames: 0, leaks: [] as string[], stop: false }
                Object.assign(window, { documentVisibilityProbe: probe })
                const sample = () => {
                    probe.frames++
                    for (const element of document.querySelectorAll('.document-page canvas, .document-page .textLayer')) {
                        if (element.closest('[aria-hidden="true"]') && getComputedStyle(element).visibility === 'visible') {
                            probe.leaks.push(element.tagName)
                        }
                    }
                    if (!probe.stop) requestAnimationFrame(sample)
                }
                requestAnimationFrame(sample)
            })
            const togglePane = async (document: boolean) => {
                if (width < 640) await page.getByRole('button', { name: document ? 'P2' : 'P1', exact: true }).click()
                else {
                    if (!document) await page.getByTestId('rich-composer-input').first().click()
                    await page.keyboard.press('Control+b'); await page.keyboard.press('z')
                }
            }
            for (let visit = 0; visit < 2; visit++) {
                await togglePane(false)
                await expect(surface.locator('canvas')).toHaveCSS('visibility', 'hidden')
                await expect(surface.locator('.textLayer')).toHaveCSS('visibility', 'hidden')
                expect((await surface.locator('canvas').boundingBox())!.width).toBeGreaterThan(100)
                await togglePane(true)
                await expect(ready).toBeVisible()
                await expect(surface.locator('.document-page-controls')).toContainText('2 / 2')
                await expect(surface.locator('.document-page-controls')).toContainText('125%')
            }
            await page.keyboard.press('Control+b'); await page.keyboard.press('n')
            await expect(page.locator('.workspace-empty:visible')).toBeVisible()
            await expect(surface.locator('canvas')).toHaveCSS('visibility', 'hidden')
            await expect(surface.locator('.textLayer')).toHaveCSS('visibility', 'hidden')
            await page.keyboard.press('Control+b'); await page.keyboard.press('p')
            await expect(ready).toBeVisible()
            await expect(surface.locator('.textLayer')).toContainText('Second page')
            const probe = await page.evaluate(() => {
                const value = (window as unknown as { documentVisibilityProbe: { frames: number; leaks: string[]; stop: boolean } }).documentVisibilityProbe
                value.stop = true
                return value
            })
            expect(probe.frames).toBeGreaterThan(0)
            expect(probe.leaks).toEqual([])
        })
    }
}

test('edits, conflicts, saves, and attaches a selection without sending or replacing the chat draft', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.goto('/e2e-fixtures/workspace-fixture.html?panes=1&documents=1')
    const document = page.locator('.document-surface')
    await expect(document).toHaveAttribute('data-document-state', 'ready')
    const composer = page.getByTestId('rich-composer-input').first()
    await composer.fill('Please improve this part.')
    await document.getByRole('button', { name: 'Edit', exact: true }).click()
    const editor = document.locator('.cm-content')
    await editor.click(); await editor.press('Control+End'); await editor.pressSequentially('\nBrowser edit')
    await page.evaluate(() => window.__workspaceFixture.updateDocument('# Changed by agent\n'))
    await document.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(document.getByRole('alert')).toContainText('changed on disk')
    await expect(editor).toContainText('Browser edit')
    await document.getByRole('button', { name: 'Compare with disk' }).click()
    await expect(document.locator('.document-conflict')).toContainText('Changed by agent')
    await document.getByRole('button', { name: 'Use my draft as the next revision' }).click()
    await document.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(document.locator('.document-status')).toHaveText('Saved')
    await editor.click(); await editor.press('Control+Home'); await editor.press('Shift+End')
    await document.getByRole('button', { name: 'Reference selection', exact: true }).click()
    await expect(page.getByTestId('document-reference-drafts')).toContainText('PLAN.md')
    await page.getByTestId('document-reference-drafts').locator('summary').click()
    await expect(page.getByTestId('document-reference-drafts').locator('pre')).toContainText('# 文档工作区')
    await expect(composer).toHaveText('Please improve this part.')
    expect(await page.evaluate(() => window.__workspaceFixture.sends.length)).toBe(0)
    await composer.press('Enter')
    await expect.poll(() => page.evaluate(() => window.__workspaceFixture.sends.length)).toBe(1)
    const sent = await page.evaluate(() => window.__workspaceFixture.sends[0])
    expect(sent.sessionId).toBe('chat-1')
    expect(sent.text).toContain('Please improve this part.')
    expect(sent.text).toContain('Source: /mnt/cache/src/hapi/PLAN.md')
    expect(sent.text).toContain('> # 文档工作区')
})

test('keeps a single-session file draft when canceling Close and discards only after an explicit choice', async ({ page }) => {
    await page.goto('/e2e-fixtures/workspace-fixture.html?singleDocument=1')
    const document = page.locator('.document-surface')
    await expect(document).toHaveAttribute('data-document-state', 'ready')
    await document.getByRole('button', { name: 'Edit', exact: true }).click()
    const editor = document.locator('.cm-content')
    await editor.click(); await editor.press('Control+End'); await editor.pressSequentially('\nLeave prompt draft')
    // The single-session file route now owns a retained workbench. Revealing
    // its tree keeps the draft mounted; closing the file is the leave action.
    await documentAction(page, document, 'Close file')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Keep your changes?')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(editor).toContainText('Leave prompt draft')
    await documentAction(page, document, 'Close file')
    await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click()
    await expect(document).toHaveCount(0)
    expect(await page.evaluate(() => window.__workspaceFixture.fileWrites.length)).toBe(0)
})

test('keeps editing and undo through a workspace switch, and restores an unsaved draft after reload', async ({ page }) => {
    await page.goto('/e2e-fixtures/workspace-fixture.html?panes=1&documents=1')
    const document = page.locator('.document-surface')
    await expect(document).toHaveAttribute('data-document-state', 'ready')
    await document.getByRole('button', { name: 'Edit', exact: true }).click()
    const editor = document.locator('.cm-content')
    await editor.click(); await editor.press('Control+End'); await editor.pressSequentially('\nPersist this draft')
    await expect(document.locator('.document-status')).toHaveText('Unsaved changes')
    await page.keyboard.press('Control+b'); await page.keyboard.press('c')
    await expect(page.locator('.workspace-empty:visible')).toBeVisible()
    await page.keyboard.press('Control+b'); await page.keyboard.press('p')
    await expect(editor).toContainText('Persist this draft')
    await editor.click(); await editor.press('Control+z')
    await expect(editor).not.toContainText('Persist this draft')
    await editor.press('Control+Shift+z')
    await expect(editor).toContainText('Persist this draft')
    // Wait for a durable draft, not an arbitrary UI delay.
    await page.waitForFunction(async () => {
        const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('hapi-document-drafts'); request.onsuccess = () => resolve(request.result) })
        return new Promise<boolean>(resolve => {
            const transaction = db.transaction('drafts'); const request = transaction.objectStore('drafts').getAll()
            transaction.oncomplete = () => { db.close(); resolve(request.result.some(draft => draft.text.includes('Persist this draft'))) }
        })
    })
    page.on('dialog', dialog => dialog.accept())
    await page.reload()
    await expect(document).toHaveAttribute('data-document-state', 'ready')
    await expect(document).toContainText('Persist this draft')
    await expect(document.locator('.document-status')).toHaveText('Unsaved changes')
    expect(await page.evaluate(() => window.__workspaceFixture.fileWrites.length)).toBe(0)
})

test('projects the same document into a phone pane with an accessible save action', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/e2e-fixtures/workspace-fixture.html?panes=1&documents=1')
    const document = page.locator('.document-surface:visible')
    await expect(document).toHaveAttribute('data-document-state', 'ready')
    await expect(page.getByRole('button', { name: 'P2', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await document.getByRole('button', { name: 'Edit', exact: true }).click()
    const editor = document.locator('.cm-content')
    await editor.click(); await editor.press('Control+End'); await editor.pressSequentially('\nPhone draft')
    await page.getByRole('button', { name: 'P1', exact: true }).click()
    await expect(document).toHaveCount(0)
    await page.getByRole('button', { name: 'P2', exact: true }).click()
    await expect(document.locator('.cm-content')).toContainText('Phone draft')
    await document.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(document.locator('.document-status')).toHaveText('Saved')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('reloads a clean editor but keeps a dirty draft when the original file changes', async ({ page }) => {
    await page.goto('/e2e-fixtures/workspace-fixture.html?panes=1&documents=1')
    const document = page.locator('.document-surface')
    await expect(document).toHaveAttribute('data-document-state', 'ready')
    await document.getByRole('button', { name: 'Edit', exact: true }).click()
    const editor = document.locator('.cm-content')
    await page.evaluate(() => window.__workspaceFixture.updateDocument('# Updated original\n'))
    await documentAction(page, document, 'Reload')
    await expect(editor).toHaveText('# Updated original')
    await editor.click(); await editor.press('Control+End'); await editor.pressSequentially('\nKeep my draft')
    await page.evaluate(() => window.__workspaceFixture.updateDocument('# Updated again\n'))
    await documentAction(page, document, 'Reload')
    await expect(document.getByRole('button', { name: 'Compare with disk' })).toBeVisible()
    await expect(editor).toContainText('Keep my draft')
    expect(await page.evaluate(() => window.__workspaceFixture.fileWrites.length)).toBe(0)
})

test('opens Find from the reader actions with keyboard focus in the actual text search', async ({ page }) => {
    await page.goto('/e2e-fixtures/workspace-fixture.html?panes=1&documents=1')
    const document = page.locator('.document-surface')
    await expect(document).toHaveAttribute('data-document-state', 'ready')
    await document.getByRole('button', { name: 'Document actions', exact: true }).click()
    const actions = page.getByRole('dialog', { name: 'Document actions', exact: true })
    await expect(actions.getByRole('button', { name: 'Find', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await document.getByRole('button', { name: 'Edit', exact: true }).click()
    const trigger = document.getByRole('button', { name: 'Document actions', exact: true })
    await trigger.focus()
    await page.keyboard.press('Enter')
    await actions.getByRole('button', { name: 'Find', exact: true }).focus()
    await page.keyboard.press('Enter')
    const search = document.locator('.cm-search input[name="search"]')
    await expect(search).toBeVisible()
    await expect(search).toBeFocused()
    await page.keyboard.type('workspace')
    await expect(search).toHaveValue('workspace')
    expect(await page.evaluate(() => window.__workspaceFixture.fileWrites.length)).toBe(0)
})

test('closes reader and PDF popovers when their retained phone pane becomes hidden', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/e2e-fixtures/workspace-fixture.html?panes=1&documents=1&documentSample=pane-visibility.pdf')
    const surface = page.locator('.document-surface')
    await expect(surface.locator('.document-page[aria-busy="false"]')).toBeVisible({ timeout: 30000 })
    for (const label of ['File path', 'Document actions', 'Zoom', 'Selection tool']) {
        await surface.getByRole('button', { name: label, exact: true }).click()
        await expect(page.getByRole('dialog', { name: label, exact: true })).toBeVisible()
        // No outside pointer event or Escape: the foreground transition itself
        // must close portalled controls, including a programmatic pane switch.
        await page.getByRole('button', { name: 'P1', exact: true }).evaluate(button => button.click())
        await expect(surface).not.toBeVisible()
        await expect(page.getByRole('dialog', { name: label, exact: true })).toHaveCount(0)
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
        expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[inert], [aria-hidden="true"], .document-popover')))).toBe(false)
        await page.getByRole('button', { name: 'P2', exact: true }).click()
        await expect(surface.locator('.document-page[aria-busy="false"]')).toBeVisible()
        await expect(page.getByRole('dialog', { name: label, exact: true })).toHaveCount(0)
    }
})
