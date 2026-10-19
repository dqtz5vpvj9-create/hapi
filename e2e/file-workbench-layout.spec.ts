import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'

const root = '/mnt/cache/src/hapi'
const pdfPath = 'docs/research/AgentCompletionInterrupt/6787-R2-review.pdf'
const tree = (page: Page) => page.getByRole('tree')
const entry = (page: Page, path: string) => tree(page).locator(`[data-file-path="${path}"][data-file-kind]`)
const reader = (page: Page) => page.locator('.document-surface:visible')

async function openWorkbench(page: Page, width: number, splitWidth?: number) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : width < 700 ? 844 : 1000 })
    await page.addInitScript(({ splitWidth }) => {
        localStorage.setItem('hapi-font-scale', '1.2')
        if (splitWidth !== undefined) localStorage.setItem('hapi-file-workspace-width', String(splitWidth))
    }, { splitWidth })
    await page.goto('/e2e-fixtures/file-workbench-fixture.html?single=1&layout=1&theme=codex')
    await page.getByRole('button', { name: 'More actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Project files', exact: true }).click()
    await expect(tree(page)).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-color-theme', 'codex')
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-font-scale').trim())).toBe('1.2')
}

async function openPdf(page: Page) {
    const parts = pdfPath.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
        const disclosure = entry(page, parts.slice(0, depth).join('/')).locator('button[aria-expanded]').first()
        if (await disclosure.getAttribute('aria-expanded') !== 'true') await disclosure.click()
        await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    }
    await entry(page, pdfPath).locator('button.app-file-tree-target').click()
    await expect(reader(page)).toHaveAttribute('data-document-state', 'ready')
    await expect(reader(page).locator('.document-page[aria-busy="false"]')).toBeVisible({ timeout: 30_000 })
    await expect(reader(page).locator('.textLayer')).toContainText('First page')
}

// Check the rendered hit area and clipping ancestors, not only DOM presence.
// A control can be "visible" while half of it sits outside an overflow panel.
async function expectReachable(control: Locator) {
    await expect(control).toBeVisible()
    const result = await control.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const viewport = window.visualViewport
        let left = viewport?.offsetLeft ?? 0
        let top = viewport?.offsetTop ?? 0
        let right = left + (viewport?.width ?? innerWidth)
        let bottom = top + (viewport?.height ?? innerHeight)
        for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor)
            const bounds = ancestor.getBoundingClientRect()
            if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
                left = Math.max(left, bounds.left + ancestor.clientLeft)
                right = Math.min(right, bounds.left + ancestor.clientLeft + ancestor.clientWidth)
            }
            if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
                top = Math.max(top, bounds.top + ancestor.clientTop)
                bottom = Math.min(bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight)
            }
        }
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return {
            label: element.getAttribute('aria-label') ?? element.textContent,
            width: rect.width, height: rect.height,
            clipped: rect.left < left - 1 || rect.right > right + 1 || rect.top < top - 1 || rect.bottom > bottom + 1,
            reachable: !!hit && element.contains(hit),
        }
    })
    expect(result.width, `${result.label}: usable width`).toBeGreaterThan(16)
    expect(result.height, `${result.label}: usable height`).toBeGreaterThan(16)
    expect(result.clipped, `${result.label}: clipped by viewport or parent`).toBe(false)
    expect(result.reachable, `${result.label}: covered by another element`).toBe(true)
}

async function expectOneRow(controls: Locator[]) {
    const boxes = await Promise.all(controls.map(control => control.boundingBox()))
    for (const box of boxes) expect(box).not.toBeNull()
    // Their vertical hit areas must overlap. This catches wrapping without
    // prescribing exact typography, padding, borders, or pixel snapshots.
    expect(Math.max(...boxes.map(box => box!.y))).toBeLessThan(Math.min(...boxes.map(box => box!.y + box!.height)))
    for (const control of controls) await expectReachable(control)
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
    await page.screenshot({ path: testInfo.outputPath(name), animations: 'disabled' })
    await testInfo.attach(name, { path: testInfo.outputPath(name), contentType: 'image/png' })
}

async function expectCompactPdf(page: Page) {
    const document = reader(page)
    const controls = document.locator('.document-page-controls')
    await expect(document.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
    await expectOneRow([
        document.getByRole('button', { name: 'Back to file tree', exact: true }),
        document.getByRole('button', { name: 'File path', exact: true }),
        document.getByRole('button', { name: 'Copy file path', exact: true }),
        document.getByRole('button', { name: 'Document actions', exact: true }),
    ])
    await expectOneRow([
        controls.getByRole('button', { name: 'Previous page', exact: true }),
        controls.getByRole('button', { name: 'Next page', exact: true }),
        controls.getByRole('button', { name: 'Zoom', exact: true }),
        controls.getByRole('button', { name: 'Selection tool', exact: true }),
    ])
    const documentBounds = (await document.boundingBox())!
    const pageBounds = (await document.locator('.document-page').boundingBox())!
    // The original reader stacked title, actions, path, return, PDF actions,
    // and selection mode above the paper. Leave room for two useful rows.
    expect(pageBounds.y - documentBounds.y).toBeLessThan(160)
    expect(pageBounds.width).toBeGreaterThan(documentBounds.width * .8)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
}

test.describe('phone file workbench hierarchy', () => {
    test.use({ hasTouch: true, isMobile: true })

    for (const width of [390, 320]) {
        test(`keeps file actions accessible without permanent action rows at ${width}px and 120% text`, async ({ page }, testInfo) => {
            await openWorkbench(page, width)
            const search = page.getByRole('textbox', { name: 'Search files', exact: true })
            const create = page.getByRole('button', { name: 'New', exact: true })
            const options = page.getByRole('button', { name: 'File browser options', exact: true })
            await expectOneRow([search, create, options])
            await expect(tree(page).getByRole('checkbox')).toHaveCount(0)
            await expect(page.getByRole('button', { name: 'Show file', exact: true })).toHaveCount(0)
            const panel = (await page.locator('.session-workspace-panel').boundingBox())!
            const firstFolder = (await entry(page, 'docs').boundingBox())!
            expect(firstFolder.y - panel.y).toBeLessThan(200)
            expect(firstFolder.height).toBeGreaterThanOrEqual(44)
            expect(firstFolder.height).toBeLessThanOrEqual(52)
            await screenshot(page, testInfo, `files-${width}-large-text.png`)

            await create.click()
            const creationMenu = page.getByRole('menu', { name: 'New', exact: true })
            for (const name of ['New file', 'New folder', 'Upload files', 'Upload folder']) {
                const item = creationMenu.getByRole('menuitem', { name, exact: true })
                await item.scrollIntoViewIfNeeded()
                await expectReachable(item)
            }
            await screenshot(page, testInfo, `files-create-${width}-large-text.png`)
            await page.keyboard.press('Escape')
            await expect(create).toBeFocused()
            await options.click()
            const optionsMenu = page.getByRole('menu', { name: 'File browser options', exact: true })
            for (const name of ['Refresh filesystem view', 'Sort files', 'File filters', 'Collapse folders', 'Select items']) {
                const item = optionsMenu.getByRole('menuitem', { name, exact: true })
                await item.scrollIntoViewIfNeeded()
                await expectReachable(item)
            }
            const hidden = optionsMenu.getByRole('menuitemcheckbox', { name: 'Show hidden files', exact: true })
            await hidden.scrollIntoViewIfNeeded()
            await expectReachable(hidden)
            await optionsMenu.getByRole('menuitem', { name: 'Select items', exact: true }).click()
            await expect(search).toHaveCount(0)
            await expect(create).toHaveCount(0)
            const checkbox = tree(page).getByRole('checkbox', { name: 'Select docs', exact: true })
            await checkbox.focus()
            await page.keyboard.press('Space')
            await expect(checkbox).toBeChecked()
            const selection = page.getByRole('toolbar', { name: '1 selected', exact: true })
            await expectReachable(selection.getByRole('button', { name: 'Done', exact: true }))
            await screenshot(page, testInfo, `files-selection-${width}-large-text.png`)
            await selection.getByRole('button', { name: 'Selected file actions', exact: true }).click()
            const selectionMenu = page.getByRole('menu', { name: 'Selected file actions', exact: true })
            for (const name of ['Copy selected paths', 'Move selected', 'Copy selected', 'Delete selected']) {
                const item = selectionMenu.getByRole('menuitem', { name, exact: true })
                await item.scrollIntoViewIfNeeded()
                await expectReachable(item)
            }
            await page.keyboard.press('Escape')
            await selection.getByRole('button', { name: 'Done', exact: true }).click()
            await expect(tree(page).getByRole('checkbox')).toHaveCount(0)
            await expectOneRow([search, create, options])
            expect(await page.evaluate(() => window.__fileWorkbenchFixture.mutations)).toEqual([])
        })

        test(`gives PDF content priority and exposes the complete path at ${width}px and 120% text`, async ({ page, context }, testInfo) => {
            await context.grantPermissions(['clipboard-read', 'clipboard-write'])
            await openWorkbench(page, width)
            await openPdf(page)
            await expect(tree(page)).toBeHidden()
            await expect(page.locator('.session-workspace-heading')).toBeHidden()
            await expectCompactPdf(page)
            await screenshot(page, testInfo, `pdf-${width}-large-text.png`)
            await reader(page).getByRole('button', { name: 'File path', exact: true }).click()
            const path = page.getByRole('dialog', { name: 'File path', exact: true })
            await expect(path.locator('.document-full-path')).toHaveText(`${root}/${pdfPath}`)
            expect(await path.locator('.document-full-path').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
            await expectReachable(path.getByRole('button', { name: 'Copy file path', exact: true }))
            await screenshot(page, testInfo, `pdf-path-${width}-large-text.png`)
            await page.keyboard.press('Escape')
            await expect(reader(page).getByRole('button', { name: 'File path', exact: true })).toBeFocused()
            await reader(page).getByRole('button', { name: 'Copy file path', exact: true }).click()
            await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`${root}/${pdfPath}`)
            await reader(page).getByRole('button', { name: 'Document actions', exact: true }).click()
            const actions = page.getByRole('dialog', { name: 'Document actions', exact: true })
            for (const name of ['Reload', 'Download', 'Keep open']) await expectReachable(actions.getByRole('button', { name, exact: true }))
            await expect(actions.getByRole('button', { name: 'Find', exact: true })).toHaveCount(0)
            await page.keyboard.press('Escape')
            await reader(page).getByRole('button', { name: 'Zoom', exact: true }).click()
            const zoom = page.getByRole('dialog', { name: 'Zoom', exact: true })
            for (const name of ['Zoom out', 'Zoom in', 'Fit width']) await expectReachable(zoom.getByRole('button', { name, exact: true }))
            await zoom.getByRole('button', { name: 'Zoom in', exact: true }).click()
            await expect(zoom).toContainText('125%')
            await zoom.getByRole('button', { name: 'Fit width', exact: true }).click()
            await reader(page).getByRole('button', { name: 'Selection tool', exact: true }).click()
            const selection = page.getByRole('dialog', { name: 'Selection tool', exact: true })
            await expectReachable(selection.getByRole('button', { name: 'Select text', exact: true }))
            await expectReachable(selection.getByRole('button', { name: 'Select area', exact: true }))
            await selection.getByRole('button', { name: 'Select area', exact: true }).click()
            await expect(reader(page).locator('.document-region-layer')).toBeVisible()
            await reader(page).getByRole('button', { name: 'Next page', exact: true }).click()
            await expect(reader(page).locator('.textLayer')).toContainText('Second page')
            await expectCompactPdf(page)
            expect(await page.evaluate(() => window.__fileWorkbenchFixture.unhandled)).toEqual([])
        })
    }
})

for (const scenario of [
    { width: 1920, splitWidth: 72, wide: true, name: 'wide desktop' },
    { width: 1440, splitWidth: 40, wide: false, name: 'narrow desktop panel' },
]) {
    test(`fits the reader to its ${scenario.name} instead of the window width`, async ({ page }, testInfo) => {
        await openWorkbench(page, scenario.width, scenario.splitWidth)
        await expect(page.locator('.session-workspace')).toHaveAttribute('data-split', 'true')
        await expect(page.locator('.file-workbench')).toHaveAttribute('data-wide', String(scenario.wide))
        await openPdf(page)
        if (scenario.wide) await expect(tree(page)).toBeVisible()
        else await expect(tree(page)).toBeHidden()
        await expectCompactPdf(page)
        await screenshot(page, testInfo, `pdf-${scenario.wide ? 'desktop' : 'narrow-panel'}.png`)
        await reader(page).getByRole('button', { name: 'Back to file tree', exact: true }).click()
        await expect(tree(page)).toBeVisible()
        await expect(entry(page, pdfPath).locator('button.app-file-tree-target')).toHaveAttribute('aria-current', 'true')
        await expect(entry(page, pdfPath)).toBeInViewport()
        expect(await page.evaluate(() => window.__fileWorkbenchFixture.mutations)).toEqual([])
    })
}
