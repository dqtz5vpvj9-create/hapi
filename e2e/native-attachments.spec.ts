import { expect, test, type Page } from '@playwright/test'

const fixture = '/e2e-fixtures/native-attachments-fixture.html'
const photoData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='

async function installNativePicker(page: Page) {
    await page.addInitScript(({ photoData }) => {
        const target = window as unknown as {
            androidBridge: object
            Capacitor: object
            __pickerMode: string
            __pickerCalls: { method: string; options: Record<string, unknown> }[]
        }
        target.androidBridge = {}
        target.__pickerMode = 'select'
        target.__pickerCalls = []
        target.Capacitor = {
            PluginHeaders: [{ name: 'FilePicker', methods: [{ name: 'pickImages', rtype: 'promise' }, { name: 'pickFiles', rtype: 'promise' }] }],
            nativePromise: async (_plugin: string, method: string, options: Record<string, unknown>) => {
                target.__pickerCalls.push({ method, options })
                if (target.__pickerMode === 'cancel') throw new Error('pickFiles canceled.')
                if (target.__pickerMode === 'error') throw new Error('Cloud provider is unavailable')
                const photo = method === 'pickImages'
                return { files: [{
                    name: photo ? 'Original photo.png' : 'Notes 中文.txt',
                    mimeType: photo ? 'image/png' : 'text/plain',
                    size: photo ? atob(photoData).length : 14,
                    modifiedAt: 1700000000000,
                    webPath: photo ? `data:image/png;base64,${photoData}` : 'data:text/plain;base64,b3JpZ2luYWwgbm90ZXM=',
                }] }
            },
        }
    }, { photoData })
}

async function openNativeSources(page: Page, glass = false) {
    if (glass) {
        await page.getByRole('button', { name: 'Add content' }).click()
        await page.getByRole('button', { name: 'Add images or files' }).click()
    } else await page.getByRole('button', { name: 'Attach file', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Add attachments' })).toBeVisible()
}

test('native mobile source panel adds the original photo through the Web preview and upload pipeline', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await installNativePicker(page)
    await page.goto(fixture)
    await openNativeSources(page)
    const dialog = page.getByRole('dialog', { name: 'Add attachments' })
    for (const source of ['Photos', 'Files']) {
        const button = dialog.getByRole('button', { name: source, exact: true })
        const box = await button.boundingBox()
        expect(box!.width).toBeGreaterThanOrEqual(44)
        expect(box!.height).toBeGreaterThanOrEqual(44)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('native-sources-mobile.png') })
    await dialog.getByRole('button', { name: 'Photos', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'Remove attachment', exact: true })).toHaveCount(1)
    await expect(page.getByRole('img', { name: 'Original photo.png', exact: true })).toBeVisible()
    await expect(page.getByRole('textbox')).toHaveText('Inspect these files and retain this draft.')
    const upload = await page.evaluate(() => (window as unknown as { __attachmentUploads: unknown[] }).__attachmentUploads)
    expect(upload).toEqual([{ sessionId: 'native-attachment-fixture', name: 'Original photo.png', data: photoData, mimeType: 'image/png' }])
    expect(await page.evaluate(() => (window as unknown as { __pickerCalls: unknown[] }).__pickerCalls)).toEqual([
        { method: 'pickImages', options: { limit: 0, readData: false, skipTranscoding: true, ordered: true } },
    ])
    await page.screenshot({ path: testInfo.outputPath('native-preview-mobile.png') })
})

test('native cancellation preserves selected attachments and provider errors remain visible', async ({ page }) => {
    await installNativePicker(page)
    await page.goto(fixture)
    await openNativeSources(page)
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await expect(page.getByText('Notes 中文.txt', { exact: true })).toBeVisible()

    await page.evaluate(() => { (window as unknown as { __pickerMode: string }).__pickerMode = 'cancel' })
    await openNativeSources(page)
    await page.getByRole('button', { name: 'Photos', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Add attachments', exact: true })).not.toBeVisible()
    await expect(page.getByText('Notes 中文.txt', { exact: true })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)

    await page.evaluate(() => { (window as unknown as { __pickerMode: string }).__pickerMode = 'error' })
    await openNativeSources(page)
    await page.getByRole('button', { name: 'Photos', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('Cloud provider is unavailable')
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Remove attachment', exact: true })).toHaveCount(1)
    expect(await page.evaluate(() => (window as unknown as { __attachmentUploads: unknown[] }).__attachmentUploads)).toHaveLength(1)
})

test('the refined Add menu can close while its native source picker and upload remain usable', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await installNativePicker(page)
    await page.goto(`${fixture}?glass`)
    await openNativeSources(page, true)
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Add attachments', exact: true })).not.toBeVisible()
    await expect(page.getByText('Notes 中文.txt', { exact: true })).toBeVisible()
    await expect(page.getByRole('textbox')).toHaveText('Inspect these files and retain this draft.')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('ordinary browsers retain their file input and existing upload behavior', async ({ page }) => {
    await page.goto(fixture)
    const fileChooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: 'Attach file', exact: true }).click()
    await (await fileChooser).setFiles({ name: 'browser.txt', mimeType: 'text/plain', buffer: Buffer.from('browser bytes') })
    await expect(page.getByText('browser.txt', { exact: true })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Add attachments', exact: true })).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __attachmentUploads: unknown[] }).__attachmentUploads)).toEqual([
        { sessionId: 'native-attachment-fixture', name: 'browser.txt', data: Buffer.from('browser bytes').toString('base64'), mimeType: 'text/plain' },
    ])
})
