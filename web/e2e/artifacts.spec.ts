import { expect, test } from '@playwright/test'

test('mobile artifact previews preserve media and isolate interactive HTML', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const external: string[] = []
    const blocked: string[] = []
    const policyErrors: string[] = []
    page.on('console', message => { if (message.type() === 'error') policyErrors.push(message.text()) })
    page.on('request', request => { if (request.url().includes('artifact-network.invalid')) external.push(request.url()) })
    page.on('requestfailed', request => { if (['csp', 'net::ERR_BLOCKED_BY_CSP'].includes(request.failure()?.errorText ?? '')) blocked.push(request.url()) })
    await page.goto('/e2e-fixtures/artifacts-fixture.html')
    await expect(page.locator('img').first()).toBeVisible()
    expect(await page.locator('img').first().evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
    expect(await page.evaluate(() => (window as unknown as { artifactCalls: Record<string, number> }).artifactCalls.html)).toBeUndefined()
    const report = page.getByTestId('artifact-html')
    await report.getByRole('button', { name: /打开预览|Open preview/ }).click()
    const frame = report.frameLocator('iframe')
    await expect(frame.locator('#boundary')).toHaveText('Parent access blocked')
    await frame.locator('#counter').click()
    await expect(frame.locator('#counter')).toHaveText('Count: 1')
    expect(await page.locator('body').getAttribute('data-artifact-escaped')).toBeNull()
    // Chromium emits a request event even when CSP blocks it before transport.
    await expect.poll(() => external.every(url => blocked.includes(url))).toBe(true)
    const previewFrame = page.frames().find(value => value.url() === 'about:srcdoc')!
    await previewFrame.evaluate(() => { location.href = 'https://artifact-network.invalid/navigation' })
    await expect.poll(() => policyErrors.some(message => message.includes('Framing') && message.includes("frame-src 'none'"))).toBe(true)
    const pdf = page.getByTestId('artifact-pdf')
    await pdf.getByRole('button', { name: /打开预览|Open preview/ }).click()
    await expect(pdf.locator('canvas[data-pdf-page="1"]')).toBeVisible()
    await expect(pdf).toContainText('1 / 1')
    expect(await pdf.locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(0)
    await page.getByTestId('artifact-csv').getByRole('button', { name: /打开预览|Open preview/ }).click()
    await expect(page.getByTestId('artifact-csv').getByRole('cell', { name: 'Feb' })).toBeVisible()
    for (const kind of ['audio', 'video']) {
        const card = page.getByTestId(`artifact-${kind}`)
        await card.getByRole('button', { name: /打开预览|Open preview/ }).click()
        const media = card.locator(kind)
        await expect(media).toBeVisible()
        await expect.poll(() => media.evaluate((element: HTMLMediaElement) => element.readyState)).toBeGreaterThanOrEqual(2)
        await media.evaluate(async (element: HTMLMediaElement) => { element.muted = true; await element.play() })
        expect(await media.evaluate((element: HTMLMediaElement) => element.paused)).toBe(false)
    }
    await expect(page.getByTestId('artifact-missing')).toContainText('The original file is no longer available')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
