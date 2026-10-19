import { expect, test, type Locator, type Page } from '@playwright/test'

const fixtureUrl = '/e2e-fixtures/codex-command-fixture.html'
const powershellCommand = '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "rg needle src"'
const reportLine = `Browser reports: ${Array.from({ length: 18 }, (_, index) => `browser-report-${String(index + 1).padStart(2, '0')}.json`).join(' | ')}`
const fullOutput = ['API acceptance saved: True', 'DETAIL_OUTPUT_ONLY', 'Verification complete.', reportLine].join('\n')

async function expectNoPageOverflow(page: Page) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(await page.evaluate(() => window.scrollX)).toBe(0)
}

async function expectHorizontalScroll(page: Page, region: Locator) {
    const geometry = await region.evaluate(element => ({
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflow: getComputedStyle(element).overflowX,
    }))
    expect(geometry.scrollWidth).toBeGreaterThan(geometry.width)
    expect(geometry.overflow).toBe('auto')
    await region.hover()
    await page.mouse.wheel(260, 0)
    await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
    await expectNoPageOverflow(page)
}

for (const width of [390, 1280]) {
    test(`command previews expand inline and retain the full detail dialog at ${width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width, height: 844 })
        await page.goto(fixtureUrl)
        const header = page.getByRole('button', { name: /Ran ls -ld/ })
        await expect(header).toHaveAttribute('aria-expanded', 'false')
        const label = header.getByText(/^Ran ls -ld/)
        const geometry = await label.evaluate(element => ({
            height: element.getBoundingClientRect().height,
            lineHeight: parseFloat(getComputedStyle(element).lineHeight),
            overflow: getComputedStyle(element).textOverflow,
            whitespace: getComputedStyle(element).whiteSpace,
        }))
        expect(geometry.height).toBeLessThanOrEqual(geometry.lineHeight + 1)
        expect(geometry.overflow).toBe('ellipsis')
        expect(geometry.whitespace).toBe('nowrap')

        const preview = page.getByRole('region', { name: 'Output preview', exact: true })
        await expect(preview).toContainText('API acceptance saved: True')
        await expect(preview).toContainText('Browser reports: browser-report-01.json')
        expect((await preview.innerText()).split('\n')).toEqual(['API acceptance saved: True', '…', expect.stringMatching(/^Browser reports: browser-report-01\.json.*…$/)])
        await expect(page.getByText('DETAIL_OUTPUT_ONLY')).toHaveCount(0)
        await expect(page.getByRole('button', { name: /Show details/ })).toContainText('+2 lines')
        await expectNoPageOverflow(page)
        await page.screenshot({ path: testInfo.outputPath(`command-preview-${width}.png`) })

        await page.getByRole('button', { name: /Show details/ }).click()
        const details = page.getByRole('region', { name: 'Command details', exact: true })
        await expect(header).toHaveAttribute('aria-expanded', 'true')
        await expect(details).toContainText('DETAIL_OUTPUT_ONLY')
        await expect(details).toContainText('systemctl --user list-units')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(page.locator('button button, [role="button"] button')).toHaveCount(0)
        await expectNoPageOverflow(page)
        await page.screenshot({ path: testInfo.outputPath(`command-expanded-${width}.png`) })

        const fullDetails = page.getByRole('button', { name: 'Open full details', exact: true })
        await fullDetails.click()
        await expect(page.getByRole('dialog')).toContainText('DETAIL_OUTPUT_ONLY')
        await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(details).toBeVisible()
        await page.getByRole('button', { name: 'Hide details', exact: true }).click()
        await expect(header).toHaveAttribute('aria-expanded', 'false')
        await expect(details).toHaveCount(0)
        await expect(preview).toBeVisible()
        await expect(page.getByText('DETAIL_OUTPUT_ONLY')).toHaveCount(0)
    })

    test(`long command and output scroll, wrap, and copy without losing content at ${width}px`, async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'])
        await page.setViewportSize({ width, height: 844 })
        await page.goto(fixtureUrl)
        await expectHorizontalScroll(page, page.getByRole('region', { name: 'Output preview', exact: true }))
        await page.getByRole('button', { name: /Show details/ }).click()
        const details = page.getByRole('region', { name: 'Command details', exact: true })
        const codeBlocks = details.locator('[data-hapi-code-block="true"]')
        const command = codeBlocks.first()
        const output = codeBlocks.last()
        await expectHorizontalScroll(page, command.locator('[data-hapi-code-body="true"]'))
        await expectHorizontalScroll(page, output.locator('[data-hapi-code-body="true"]'))
        await output.getByRole('button', { name: 'Copy', exact: true }).click()
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(fullOutput)
        await expect(page.getByRole('dialog')).toHaveCount(0)

        await output.getByRole('button', { name: 'Enable word wrap', exact: true }).click()
        await expect(output.getByRole('button', { name: 'Disable word wrap', exact: true })).toHaveAttribute('aria-pressed', 'true')
        await expect(command.getByRole('button', { name: 'Disable word wrap', exact: true })).toHaveAttribute('aria-pressed', 'true')
        for (const block of [command, output]) {
            expect(await block.locator('[data-hapi-code-body="true"]').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
        }
        await expectNoPageOverflow(page)
    })

    test(`a completed transport event with exit 1 exposes failure and every diagnostic at ${width}px`, async ({ page, context }, testInfo) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'])
        await page.setViewportSize({ width, height: 844 })
        await page.goto(`${fixtureUrl}?failed`)
        const header = page.getByRole('button', { name: /Failed.*exit 1.*ls -ld/ })
        await expect(header).toBeVisible()
        await expect(page.getByRole('button', { name: /^Ran ls -ld/ })).toHaveCount(0)
        const preview = page.getByRole('region', { name: 'Output preview', exact: true })
        await expect(preview).toHaveText('Browser verification failed: expected chat content was not rendered.\n…\nDIAGNOSTIC_OUTPUT_ONLY: report artifact capture stopped.')
        await page.screenshot({ path: testInfo.outputPath(`command-failed-${width}.png`) })
        await header.click()
        const details = page.getByRole('region', { name: 'Command details', exact: true })
        await expect(details).toContainText('DETAIL_OUTPUT_ONLY')
        await expect(details).toContainText('Browser verification failed: expected chat content was not rendered.')
        await expect(details).toContainText('DIAGNOSTIC_OUTPUT_ONLY: report artifact capture stopped.')
        const output = details.locator('[data-hapi-code-block="true"]').last()
        await expect(output.getByText('Output', { exact: true })).toBeVisible()
        await output.getByRole('button', { name: 'Copy', exact: true }).click()
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe([
            fullOutput,
            'Browser verification failed: expected chat content was not rendered.',
            'DIAGNOSTIC_OUTPUT_ONLY: report artifact capture stopped.',
        ].join('\n'))
        await expectNoPageOverflow(page)
    })

    test(`PowerShell remains readable in summary and verbatim in details and clipboard at ${width}px`, async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'])
        await page.setViewportSize({ width, height: 844 })
        await page.goto(`${fixtureUrl}?powershell`)
        const header = page.getByRole('button', { name: /Ran rg needle src/ })
        await expect(header).toBeVisible()
        await expect(page.getByText(/Program Files/)).toHaveCount(0)
        await header.click()
        const details = page.getByRole('region', { name: 'Command details', exact: true })
        await expect(details).toContainText('pwsh.exe')
        await expect(details).toContainText('-Command')
        await details.locator('[data-hapi-code-block="true"]').first().getByRole('button', { name: 'Copy', exact: true }).click()
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(powershellCommand)
        await page.getByRole('button', { name: 'Open full details', exact: true }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog).toContainText('pwsh.exe')
        await expect(dialog).toContainText('-Command')
        await expect(dialog).toContainText('DETAIL_OUTPUT_ONLY')
        await expectNoPageOverflow(page)
    })

    test(`grouped command rows expose their own inline details at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 })
        for (const query of ['?group', '?group&group-open']) {
            await page.goto(`${fixtureUrl}${query}`)
            await expect(page.getByRole('region', { name: 'Output preview', exact: true })).toHaveCount(2)
            const firstCommand = page.getByRole('button', { name: /Ran ls -ld/ })
            const secondCommand = page.getByRole('button', { name: /Ran printf/ })
            await firstCommand.click()
            await expect(page.getByRole('region', { name: 'Command details', exact: true })).toContainText('DETAIL_OUTPUT_ONLY')
            await expect(secondCommand).toHaveAttribute('aria-expanded', 'false')
            await expect(page.getByText('SECOND_COMMAND_OUTPUT', { exact: true })).toBeVisible()
            await expect(page.getByRole('dialog')).toHaveCount(0)
            await expectNoPageOverflow(page)
        }
    })
}

test('compact preference keeps one row until the command is expanded', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${fixtureUrl}?compact`)
    await expect(page.getByRole('region', { name: 'Output preview', exact: true })).toHaveCount(0)
    await expect(page.getByText('API acceptance saved: True')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /Show details/ })).toHaveCount(0)
    await page.getByRole('button', { name: /Ran ls -ld/ }).click()
    await expect(page.getByRole('region', { name: 'Command details', exact: true })).toContainText('DETAIL_OUTPUT_ONLY')
    await expectNoPageOverflow(page)
})

test('keyboard expansion and dialog dismissal retain accessible state and focus', async ({ page }) => {
    await page.goto(fixtureUrl)
    const header = page.getByRole('button', { name: /Ran ls -ld/ })
    await header.focus()
    await page.keyboard.press('Enter')
    const details = page.getByRole('region', { name: 'Command details', exact: true })
    await expect(details).toBeVisible()
    await expect(header).toHaveAttribute('aria-controls', await details.getAttribute('id') ?? '')
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Space')
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(details).toHaveCount(0)
    await page.keyboard.press('Enter')

    const fullDetails = page.getByRole('button', { name: 'Open full details', exact: true })
    await fullDetails.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(fullDetails).toBeFocused()
    await expect(details).toBeVisible()
})

test('expanded command output updates during streaming and reports its final failure', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${fixtureUrl}?streaming`)
    await page.getByRole('button', { name: /Running ls -ld/ }).click()
    const details = page.getByRole('region', { name: 'Command details', exact: true })
    await expect(details).toContainText('Waiting for browser report…')
    await page.getByRole('button', { name: 'Append output', exact: true }).click()
    await expect(details).toContainText('DETAIL_OUTPUT_ONLY')
    await expect(details).not.toContainText('Waiting for browser report…')
    await page.getByRole('button', { name: 'Finish command', exact: true }).click()
    await expect(page.getByRole('button', { name: /Failed.*exit 1.*ls -ld/ })).toHaveAttribute('aria-expanded', 'true')
    await expect(details).toContainText('Browser verification failed: expected chat content was not rendered.')
    await expect(details).toContainText('DIAGNOSTIC_OUTPUT_ONLY: report artifact capture stopped.')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expectNoPageOverflow(page)
})

test('an empty result is distinguishable from unavailable output', async ({ page }) => {
    await page.goto(`${fixtureUrl}?empty`)
    await expect(page.getByText(/\(?no output\)?/i)).toBeVisible()
    await page.goto(`${fixtureUrl}?unavailable`)
    await expect(page.getByText('Output not available', { exact: true })).toBeVisible()
    await expect(page.getByText(/\(?no output\)?/i)).toHaveCount(0)
})

for (const surface of ['page', 'chat'] as const) {
    test(`mobile output supports horizontal swipes while preserving vertical ${surface} scrolling`, async ({ browser }) => {
        const context = await browser.newContext({
            baseURL: test.info().project.use.baseURL,
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
        })
        try {
            const page = await context.newPage()
            await page.goto(`${fixtureUrl}?touch-scroll${surface === 'chat' ? '&chat-scroll' : ''}`)
            // HAPI's viewport-sized body owns scrolling outside chat; the
            // .chat-scroll-y viewport owns it in an actual conversation.
            const scrollOwner = surface === 'chat' ? page.getByTestId('chat-scroll-fixture') : page.locator('body')
            expect(await scrollOwner.evaluate(element => element.scrollTop)).toBe(0)
            const preview = page.getByRole('region', { name: 'Output preview', exact: true })
            const bounds = await preview.boundingBox()
            expect(bounds).not.toBeNull()
            const x = bounds!.x + bounds!.width - 24
            const y = bounds!.y + bounds!.height / 2
            const client = await context.newCDPSession(page)
            await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
            for (let step = 1; step <= 8; step += 1) {
                await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - step * 24, y }] })
            }
            await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
            await expect.poll(() => preview.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
            await expectNoPageOverflow(page)

            const verticalX = bounds!.x + bounds!.width / 2
            await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: verticalX, y }] })
            for (let step = 1; step <= 8; step += 1) {
                await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: verticalX, y: y - step * 20 }] })
            }
            await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
            await expect.poll(() => scrollOwner.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
            await expect.poll(async () => (await preview.boundingBox())!.y).toBeLessThan(bounds!.y)
            await expectNoPageOverflow(page)
        } finally {
            await context.close()
        }
    })
}
