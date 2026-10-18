import { expect, test, type Page } from '@playwright/test'

const bundleId = 'a'.repeat(64)
const runtime = 'b'.repeat(64)
const fixture = '/e2e-fixtures/native-attachments-fixture.html?updates#draft'
const feed = 'https://updates.hapi.test/latest.json'

async function installUpdater(page: Page, failDownload = false) {
    await page.route(feed, route => route.fulfill({
        json: { schemaVersion: 1, bundleId, sha256: bundleId, version: 'next', createdAt: 2000,
            runtimes: { android: runtime, ios: runtime }, url: 'https://updates.hapi.test/bundle.zip', size: 100 },
        headers: { 'Access-Control-Allow-Origin': '*' },
    }))
    await page.addInitScript(({ bundleId, runtime, feed, failDownload }) => {
        const target = window as unknown as {
            androidBridge: object
            Capacitor: object
            __rejectNativeDownload: boolean
            __nativeUpdateCalls: string[]
        }
        target.androidBridge = {}
        target.__rejectNativeDownload = failDownload
        target.__nativeUpdateCalls = []
        const current = () => localStorage.getItem('__native_current')
        const downloaded = () => JSON.parse(localStorage.getItem('__native_downloaded') ?? '[]') as string[]
        target.Capacitor = {
            PluginHeaders: [
                { name: 'HapiUpdates', methods: [{ name: 'getConfig', rtype: 'promise' }] },
                { name: 'FilePicker', methods: [{ name: 'pickFiles', rtype: 'promise' }] },
                { name: 'LiveUpdate', methods: [
                    ...['ready', 'getCurrentBundle', 'getNextBundle', 'getBlockedBundles', 'getDownloadedBundles',
                        'downloadBundle', 'setNextBundle', 'reload', 'deleteBundle', 'removeListener'].map(name => ({ name, rtype: 'promise' })),
                    { name: 'addListener', rtype: 'callback' },
                ] },
            ],
            nativeCallback: () => 'test-listener',
            nativePromise: async (plugin: string, method: string, options: { bundleId?: string | null }) => {
                target.__nativeUpdateCalls.push(`${plugin}.${method}`)
                if (plugin === 'HapiUpdates') return { feedUrl: feed, runtimeVersion: runtime, builtInBundleId: 'builtin', builtInCreatedAt: 1000 }
                if (plugin === 'FilePicker') return { files: [{ name: 'Unsent notes.txt', mimeType: 'text/plain', size: 5, webPath: 'data:text/plain;base64,aGVsbG8=' }] }
                if (method === 'ready') return { bundleId: current(), previousBundleId: null, rollback: false }
                if (method === 'getCurrentBundle') return { bundleId: current() }
                if (method === 'getNextBundle') return { bundleId: localStorage.getItem('__native_next') }
                if (method === 'getBlockedBundles') return { bundleIds: [] }
                if (method === 'getDownloadedBundles') return { bundleIds: downloaded() }
                if (method === 'downloadBundle') {
                    if (target.__rejectNativeDownload) throw new Error('Checksum mismatch')
                    localStorage.setItem('__native_downloaded', JSON.stringify([bundleId]))
                    return
                }
                if (method === 'setNextBundle') {
                    if (options.bundleId) localStorage.setItem('__native_next', options.bundleId)
                    else localStorage.removeItem('__native_next')
                    return
                }
                if (method === 'reload') {
                    localStorage.setItem('__native_current', localStorage.getItem('__native_next')!)
                    // Simulate the plugin loading its entry point, then let the
                    // real bootstrap helper restore the route's hash.
                    history.replaceState(null, '', '/e2e-fixtures/native-attachments-fixture.html?updates')
                    location.reload()
                }
            },
        }
    }, { bundleId, runtime, feed, failDownload })
}

test('native Update HAPI preserves the real composer draft, file blob and route across a WebView reload', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await installUpdater(page)
    await page.goto(fixture)
    const update = page.getByRole('button', { name: 'Update HAPI', exact: true })
    await expect(update).toBeEnabled()
    await page.getByRole('textbox').fill('Keep this unsent message after updating')
    await page.getByRole('button', { name: 'Attach file', exact: true }).click()
    await page.getByRole('button', { name: 'Files', exact: true }).click()
    await expect(page.getByText('Unsent notes.txt', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('__native_next'))).toBeNull()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await Promise.all([page.waitForEvent('load'), update.click()])
    expect(await page.evaluate(() => localStorage.getItem('__native_current'))).toBe(bundleId)
    await expect(page.getByRole('textbox')).toHaveText('Keep this unsent message after updating')
    await expect(page.getByText('Unsent notes.txt', { exact: true })).toBeVisible()
    await expect(page).toHaveURL(/\?updates#draft$/)
    await expect(page.getByTestId('pwa-update-banner')).toHaveCount(0)
})

test('a native verification failure keeps the current page and draft, and Retry downloads without activating', async ({ page }) => {
    await installUpdater(page, true)
    await page.goto(fixture)
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await page.getByRole('textbox').fill('Do not lose this failed-update draft')
    expect(await page.evaluate(() => localStorage.getItem('__native_next'))).toBeNull()
    await page.evaluate(() => { (window as unknown as { __rejectNativeDownload: boolean }).__rejectNativeDownload = false })
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Update HAPI', exact: true })).toBeEnabled()
    await expect(page.getByRole('textbox')).toHaveText('Do not lose this failed-update draft')
    expect(await page.evaluate(() => localStorage.getItem('__native_current'))).toBeNull()
    expect(await page.evaluate(() => localStorage.getItem('__native_next'))).toBeNull()
})
