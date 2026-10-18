import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadBundleOptions, DownloadBundleProgressEvent, ReadyResult } from '@capawesome/capacitor-live-update'

const bridge = vi.hoisted(() => ({
    platform: null as 'android' | 'ios' | null,
    hasLiveUpdate: true,
    hasConfig: true,
    registerPlugin: vi.fn(),
    liveUpdate: {} as unknown,
}))
vi.mock('@/lib/platform', () => ({ nativePlatform: () => bridge.platform }))
vi.mock('@capacitor/core', () => ({
    Capacitor: { isPluginAvailable: (name: string) => name === 'LiveUpdate' ? bridge.hasLiveUpdate : bridge.hasConfig },
    registerPlugin: bridge.registerPlugin,
}))
vi.mock('@capawesome/capacitor-live-update', () => ({ LiveUpdate: bridge.liveUpdate }))

import { NativeUpdateController, type NativeUpdateConfig, type NativeUpdateManifest, type NativeUpdateOptions, type NativeUpdateRuntime } from './nativeUpdate'

const androidRuntime = 'a'.repeat(64)
const iosRuntime = 'b'.repeat(64)
const bundled = 'c'.repeat(40)
const bundle = 'd'.repeat(64)
const newerBundle = 'e'.repeat(64)
const priorBundle = 'f'.repeat(64)
const nativeConfig: NativeUpdateConfig = {
    feedUrl: 'https://publisher.example/hapi/mobile-update.json',
    runtimeVersion: androidRuntime,
    builtInBundleId: bundled,
    builtInCreatedAt: 100,
}
const update: NativeUpdateManifest = {
    schemaVersion: 1,
    bundleId: bundle,
    version: '2026.10.18',
    createdAt: 200,
    runtimes: { android: androidRuntime, ios: iosRuntime },
    url: `https://publisher.example/releases/${bundle}.zip`,
    sha256: bundle,
    size: 1024,
}
const controllers: NativeUpdateController[] = []

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
    return { promise, resolve, reject }
}

function harness(options: Partial<NativeUpdateOptions> = {}) {
    const data = new Map<string, string>()
    const state = {
        config: { ...nativeConfig },
        current: null as string | null,
        next: null as string | null,
        blocked: [] as string[],
        downloaded: new Set<string>(),
        progress: null as ((event: DownloadBundleProgressEvent) => void) | null,
    }
    const order: string[] = []
    const removeListener = vi.fn(async () => {})
    const liveUpdate = {
        ready: vi.fn(async (): Promise<ReadyResult> => {
            order.push('ready')
            return { previousBundleId: null, currentBundleId: state.current, rollback: false }
        }),
        getCurrentBundle: vi.fn(async () => ({ bundleId: state.current })),
        getNextBundle: vi.fn(async () => ({ bundleId: state.next })),
        getBlockedBundles: vi.fn(async () => ({ bundleIds: [...state.blocked] })),
        getDownloadedBundles: vi.fn(async () => ({ bundleIds: [...state.downloaded] })),
        downloadBundle: vi.fn(async (download: DownloadBundleOptions) => {
            order.push('download')
            state.downloaded.add(download.bundleId)
        }),
        deleteBundle: vi.fn(async ({ bundleId }: { bundleId: string }) => { state.downloaded.delete(bundleId) }),
        setNextBundle: vi.fn(async ({ bundleId }: { bundleId: string | null }) => {
            order.push('select')
            state.next = bundleId
        }),
        reload: vi.fn(async () => { order.push('reload') }),
        addListener: vi.fn(async (_event: string, listener: (event: DownloadBundleProgressEvent) => void) => {
            state.progress = listener
            return { remove: removeListener }
        }),
    }
    const getConfig = vi.fn(async () => { order.push('config'); return state.config })
    const runtime: NativeUpdateRuntime = { platform: 'android', liveUpdate: liveUpdate as NativeUpdateRuntime['liveUpdate'], getConfig }
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        order.push('fetch')
        return new Response(JSON.stringify(update))
    })
    const storage = { getItem: vi.fn((key: string) => data.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { data.set(key, value) }) }
    const controllerOptions: NativeUpdateOptions = { loadRuntime: async () => runtime, fetch, storage, ...options }
    const controller = new NativeUpdateController(controllerOptions)
    controllers.push(controller)
    return { controller, controllerOptions, state, order, liveUpdate, getConfig, runtime, fetch, storage, data, removeListener }
}

function restart(h: ReturnType<typeof harness>) {
    h.controller.dispose()
    const controller = new NativeUpdateController(h.controllerOptions)
    controllers.push(controller)
    return controller
}

function setCurrent(h: ReturnType<typeof harness>, bundleId: string, createdAt = 150) {
    h.state.current = bundleId
    h.data.set(`hapi_native_update::${h.state.config.runtimeVersion}::${bundleId}`,
        JSON.stringify({ ...update, bundleId, sha256: bundleId, createdAt }))
}

beforeEach(() => {
    bridge.platform = null
    bridge.hasLiveUpdate = true
    bridge.hasConfig = true
    bridge.registerPlugin.mockReset()
    bridge.liveUpdate = {}
})

afterEach(() => {
    for (const controller of controllers.splice(0)) controller.dispose()
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe('native update readiness and trust boundary', () => {
    it('acknowledges a healthy UI exactly once before config or network, including concurrent initialization', async () => {
        const h = harness()
        const config = deferred<NativeUpdateConfig>()
        h.getConfig.mockImplementationOnce(() => { h.order.push('config'); return config.promise })
        const first = h.controller.initialize()
        expect(h.controller.initialize()).toBe(first)
        await vi.waitFor(() => expect(h.liveUpdate.ready).toHaveBeenCalledTimes(1))
        expect(h.order).toEqual(['ready', 'config'])
        expect(h.fetch).not.toHaveBeenCalled()
        config.resolve(nativeConfig)
        await first
        await h.controller.initialize()
        expect(h.liveUpdate.ready).toHaveBeenCalledTimes(1)
        expect(h.controller.getSnapshot().status).toBe('idle')
        expect(h.liveUpdate.setNextBundle).not.toHaveBeenCalled()
    })

    it('waits for startup cache restoration and pruning before a concurrent foreground check', async () => {
        const h = harness()
        const cache = deferred<{ bundleIds: string[] }>()
        h.liveUpdate.getDownloadedBundles.mockReturnValueOnce(cache.promise)
        const initializing = h.controller.initialize()
        await vi.waitFor(() => expect(h.liveUpdate.getDownloadedBundles).toHaveBeenCalledTimes(1))
        expect(h.controller.initialize()).toBe(initializing)
        const checking = h.controller.check()
        for (let i = 0; i < 10; i++) await Promise.resolve()
        expect(h.fetch).not.toHaveBeenCalled()
        cache.resolve({ bundleIds: [] })
        await Promise.all([initializing, checking])
        expect(h.controller.getSnapshot().needRefresh).toBe(true)
        expect(h.liveUpdate.downloadBundle).toHaveBeenCalledTimes(1)
    })

    it('does not register or import a native updater in a browser', async () => {
        const controller = new NativeUpdateController()
        controllers.push(controller)
        await controller.initialize()
        expect(controller.getSnapshot()).toMatchObject({ status: 'error', needRefresh: false })
        expect(bridge.registerPlugin).not.toHaveBeenCalled()
    })

    it('requires an actual native update backend', async () => {
        bridge.platform = 'android'
        bridge.hasLiveUpdate = false
        const controller = new NativeUpdateController()
        controllers.push(controller)
        await controller.initialize()
        expect(controller.getSnapshot().error).toContain('unavailable')
        expect(bridge.registerPlugin).not.toHaveBeenCalled()
    })

    it('still acknowledges readiness if the native config plugin is missing, with no JS config fallback', async () => {
        const h = harness()
        bridge.platform = 'android'
        bridge.hasConfig = false
        bridge.liveUpdate = h.liveUpdate
        const controller = new NativeUpdateController({ fetch: h.fetch })
        controllers.push(controller)
        await controller.initialize()
        expect(h.liveUpdate.ready).toHaveBeenCalledTimes(1)
        expect(controller.getSnapshot().error).toContain('unavailable')
        expect(bridge.registerPlugin).not.toHaveBeenCalled()
        expect(h.fetch).not.toHaveBeenCalled()
    })

    it.each([
        { feedUrl: 'http://publisher.example/update.json' },
        { feedUrl: 'https://name:password@publisher.example/update.json' },
        { feedUrl: 'https://publisher.example/update.json#alternate' },
        { runtimeVersion: 'a-web-bundle-version-is-not-a-native-runtime' },
        { publicKey: 'invalid key' },
    ])('rejects malformed installed configuration before downloading: %j', async (invalid) => {
        const h = harness()
        h.state.config = { ...nativeConfig, ...invalid }
        await h.controller.check()
        expect(h.liveUpdate.ready).toHaveBeenCalledTimes(1)
        expect(h.controller.getSnapshot().status).toBe('error')
        expect(h.fetch).not.toHaveBeenCalled()
        expect(h.liveUpdate.downloadBundle).not.toHaveBeenCalled()
    })
})

describe('checking and prefetching', () => {
    it('fetches only the installed publisher feed without credentials and downloads a verified ZIP without selecting it', async () => {
        const h = harness()
        h.data.set('hapi_access_token::https://hub.example', 'secret-not-for-publisher')
        const pending = deferred<void>()
        h.liveUpdate.downloadBundle.mockImplementationOnce(async ({ bundleId }) => {
            await pending.promise
            h.state.downloaded.add(bundleId)
        })
        const checking = h.controller.check()
        await vi.waitFor(() => expect(h.liveUpdate.downloadBundle).toHaveBeenCalledTimes(1))
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'downloading', needRefresh: false, progress: 0 })
        h.state.progress?.({ bundleId: bundle, progress: 0.5, downloadedBytes: 512, totalBytes: 1024 })
        expect(h.controller.getSnapshot().progress).toBe(0.5)
        h.state.progress?.({ bundleId: newerBundle, progress: 0.8, downloadedBytes: 800, totalBytes: 1024 })
        expect(h.controller.getSnapshot().progress).toBe(0.5)
        expect(h.fetch).toHaveBeenCalledWith(nativeConfig.feedUrl, {
            credentials: 'omit', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
        })
        expect(h.liveUpdate.downloadBundle).toHaveBeenCalledWith({
            artifactType: 'zip', bundleId: bundle, url: update.url, checksum: bundle,
        })
        expect(h.storage.getItem.mock.calls.flat()).not.toContain('hapi_access_token::https://hub.example')
        expect(h.liveUpdate.setNextBundle).not.toHaveBeenCalled()
        expect(h.liveUpdate.reload).not.toHaveBeenCalled()
        pending.resolve()
        await checking
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'available', needRefresh: true, progress: 1, version: update.version })
        expect(h.removeListener).toHaveBeenCalledTimes(1)
        expect(h.state.next).toBeNull()
    })

    it('matches the installed iOS runtime independently of the Android runtime', async () => {
        const h = harness()
        h.runtime.platform = 'ios'
        h.state.config.runtimeVersion = iosRuntime
        await h.controller.check()
        expect(h.controller.getSnapshot().needRefresh).toBe(true)
        expect(h.liveUpdate.downloadBundle).toHaveBeenCalledTimes(1)
    })

    it('shows an app installation requirement instead of downloading an incompatible update', async () => {
        const h = harness()
        h.state.config.runtimeVersion = priorBundle
        await h.controller.check()
        await h.controller.apply()
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'app-required', needRefresh: false, version: update.version })
        expect(h.liveUpdate.downloadBundle).not.toHaveBeenCalled()
        expect(h.liveUpdate.setNextBundle).not.toHaveBeenCalled()
        expect(h.liveUpdate.reload).not.toHaveBeenCalled()
    })

    it.each(['current', 'built-in', 'older', 'blocked'] as const)('does not offer the %s bundle', async (condition) => {
        const h = harness()
        if (condition === 'current') h.state.current = bundle
        if (condition === 'built-in') h.state.config.builtInBundleId = bundle
        if (condition === 'older') h.state.config.builtInCreatedAt = 201
        if (condition === 'blocked') h.state.blocked = [bundle]
        await h.controller.check()
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'idle', needRefresh: false })
        expect(h.liveUpdate.downloadBundle).not.toHaveBeenCalled()
    })

    it('does not reoffer the failed bundle reported by ready(), even before the persistent blocklist returns it', async () => {
        const h = harness()
        h.liveUpdate.ready.mockResolvedValueOnce({ currentBundleId: null, previousBundleId: bundle, rollback: true })
        await h.controller.initialize()
        expect(h.controller.getSnapshot().error).toContain('restored its built-in version')
        await h.controller.check()
        expect(h.controller.getSnapshot().needRefresh).toBe(false)
        expect(h.liveUpdate.downloadBundle).not.toHaveBeenCalled()
    })

    it('rechecks native rollback state after downloading', async () => {
        const h = harness()
        h.liveUpdate.downloadBundle.mockImplementationOnce(async ({ bundleId }) => {
            h.state.downloaded.add(bundleId)
            h.state.blocked = [bundleId]
        })
        await h.controller.check()
        expect(h.controller.getSnapshot().needRefresh).toBe(false)
        expect(h.liveUpdate.setNextBundle).not.toHaveBeenCalled()
    })

    it('does not offer or activate a bundle when native checksum/signature verification fails', async () => {
        const h = harness()
        h.liveUpdate.downloadBundle.mockRejectedValueOnce(new Error('Checksum mismatch; arbitrary native diagnostic'))
        await h.controller.check()
        await h.controller.apply()
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'error', needRefresh: false })
        expect(h.controller.getSnapshot().error).not.toContain('arbitrary native diagnostic')
        expect(h.liveUpdate.setNextBundle).not.toHaveBeenCalled()
        expect(h.liveUpdate.reload).not.toHaveBeenCalled()
        expect(h.removeListener).toHaveBeenCalledTimes(1)
    })

    it('requires signatures for pinned native installations and forwards a valid signature to the native verifier', async () => {
        const h = harness()
        h.state.config.publicKey = '-----BEGIN PUBLIC KEY-----\nRSA\n-----END PUBLIC KEY-----'
        await h.controller.check()
        expect(h.controller.getSnapshot().status).toBe('error')
        expect(h.liveUpdate.downloadBundle).not.toHaveBeenCalled()
        h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...update, signature: 'YWJjZA==' })))
        await h.controller.check()
        expect(h.liveUpdate.downloadBundle).toHaveBeenCalledWith(expect.objectContaining({ checksum: bundle, signature: 'YWJjZA==' }))
        expect(h.controller.getSnapshot().needRefresh).toBe(true)
    })

    it.each([
        { schemaVersion: 2 },
        { bundleId: '../outside-app' },
        { sha256: priorBundle },
        { url: 'http://publisher.example/bundle.zip' },
        { url: 'https://name:password@publisher.example/bundle.zip' },
        { size: 120 * 1024 * 1024 + 1 },
        { createdAt: NaN },
        { runtimes: { android: 'unknown', ios: iosRuntime } },
        { signature: 'this is not base64' },
    ])('rejects untrusted manifest fields before calling native download: %j', async (invalid) => {
        const h = harness()
        h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...update, ...invalid })))
        await h.controller.check()
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'error', needRefresh: false })
        expect(h.liveUpdate.downloadBundle).not.toHaveBeenCalled()
    })

    it('deduplicates overlapping checks and reuses an already verified download', async () => {
        const h = harness()
        const response = deferred<Response>()
        h.fetch.mockReturnValueOnce(response.promise)
        const first = h.controller.check()
        expect(h.controller.check()).toBe(first)
        await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1))
        response.resolve(new Response(JSON.stringify(update)))
        await first
        await h.controller.check()
        expect(h.liveUpdate.downloadBundle).toHaveBeenCalledTimes(1)
        expect(h.liveUpdate.ready).toHaveBeenCalledTimes(1)
        expect(h.controller.getSnapshot().needRefresh).toBe(true)
    })

    it('re-verifies an orphaned downloaded archive instead of retrying the SDK duplicate-ID failure forever', async () => {
        const h = harness()
        await h.controller.initialize()
        // An old WebView download can finish after this startup cache sweep.
        h.state.downloaded.add(bundle)
        h.liveUpdate.downloadBundle.mockImplementationOnce(async ({ bundleId }) => {
            if (h.state.downloaded.has(bundleId)) throw new Error('Bundle already exists')
            h.state.downloaded.add(bundleId)
        })
        await h.controller.check()
        expect(h.liveUpdate.deleteBundle).toHaveBeenCalledWith({ bundleId: bundle })
        expect(h.liveUpdate.downloadBundle).toHaveBeenCalledTimes(1)
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'available', needRefresh: true })
        expect(h.liveUpdate.setNextBundle).not.toHaveBeenCalled()
    })

    it('does not evict an unverified archive already selected by the native layer', async () => {
        const h = harness()
        await h.controller.initialize()
        h.state.downloaded.add(bundle)
        h.state.next = bundle
        await h.controller.check()
        expect(h.liveUpdate.deleteBundle).not.toHaveBeenCalled()
        expect(h.liveUpdate.downloadBundle).not.toHaveBeenCalled()
        expect(h.state.next).toBe(bundle)
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'error', needRefresh: false })
    })

    it('invalidates the old offer when metadata changes and native re-verification fails', async () => {
        const h = harness()
        await h.controller.check()
        h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...update, version: 'renamed-release' })))
        h.liveUpdate.downloadBundle.mockRejectedValueOnce(new Error('Signature check failed'))
        await h.controller.check()
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'error', needRefresh: false })
        expect(h.state.downloaded.has(bundle)).toBe(false)
        expect(h.liveUpdate.setNextBundle).not.toHaveBeenCalled()
    })

    it('preserves an available verified candidate after a later feed request fails', async () => {
        const h = harness()
        await h.controller.check()
        h.fetch.mockRejectedValueOnce(new TypeError('Network unreachable'))
        await h.controller.check()
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'available', needRefresh: true, version: update.version })
        expect(h.controller.getSnapshot().error).toContain('Could not check')
        await h.controller.apply()
        expect(h.liveUpdate.setNextBundle).toHaveBeenCalledWith({ bundleId: bundle })
    })

    it('restores a prefetched update after restart and allows offline application without selecting it at boot', async () => {
        const h = harness()
        await h.controller.check()
        h.fetch.mockRejectedValue(new TypeError('Offline'))
        const controller = restart(h)
        await controller.initialize()
        expect(controller.getSnapshot()).toMatchObject({ status: 'available', needRefresh: true })
        expect(h.liveUpdate.setNextBundle).not.toHaveBeenCalled()
        await controller.check()
        await controller.apply()
        expect(h.liveUpdate.downloadBundle).toHaveBeenCalledTimes(1)
        expect(h.liveUpdate.reload).toHaveBeenCalledTimes(1)
    })

    it('uses persisted active-bundle metadata to reject a downgrade after restarting the WebView', async () => {
        const h = harness()
        await h.controller.check()
        await h.controller.apply()
        h.state.current = bundle
        h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...update, bundleId: priorBundle, sha256: priorBundle, createdAt: 150 })))
        const controller = restart(h)
        await controller.check()
        expect(controller.getSnapshot()).toMatchObject({ status: 'idle', needRefresh: false })
        expect(h.liveUpdate.downloadBundle).toHaveBeenCalledTimes(1)
    })

    it('fails closed when active OTA ordering metadata is missing, while recognizing the already active feed bundle', async () => {
        const h = harness()
        h.state.current = priorBundle
        await h.controller.check()
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'error', needRefresh: false })
        expect(h.controller.getSnapshot().error).toContain('current web version cannot be verified')
        expect(h.liveUpdate.downloadBundle).not.toHaveBeenCalled()
        h.state.current = bundle
        await h.controller.check()
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'idle', needRefresh: false })
        expect(h.liveUpdate.downloadBundle).not.toHaveBeenCalled()
    })

    it('cleans only obsolete HAPI cache bundles, preserving active, selected-next, and verified candidate bundles', async () => {
        const h = harness()
        const obsolete = '1'.repeat(64)
        setCurrent(h, priorBundle)
        h.state.next = newerBundle
        h.state.downloaded = new Set([priorBundle, newerBundle, obsolete, 'unrelated-cache-id'])
        h.state.blocked = [obsolete]
        await h.controller.check()
        expect(h.liveUpdate.deleteBundle).toHaveBeenCalledWith({ bundleId: obsolete })
        expect(h.state.downloaded).toEqual(new Set([priorBundle, newerBundle, bundle, 'unrelated-cache-id']))
        expect(h.state.blocked).toEqual([obsolete])
        expect(h.state.next).toBe(newerBundle)
    })
})

describe('explicit update application', () => {
    it('runs the route/draft preflight before selecting and reloading, and deduplicates repeated clicks', async () => {
        const h = harness()
        await h.controller.check()
        const saved = deferred<void>()
        const preflight = vi.fn(() => saved.promise)
        const applying = h.controller.apply(preflight)
        expect(h.controller.apply(preflight)).toBe(applying)
        await vi.waitFor(() => expect(preflight).toHaveBeenCalledTimes(1))
        expect(h.liveUpdate.setNextBundle).not.toHaveBeenCalled()
        expect(h.controller.getSnapshot().status).toBe('applying')
        saved.resolve()
        await applying
        expect(h.order.slice(-2)).toEqual(['select', 'reload'])
        expect(h.liveUpdate.setNextBundle).toHaveBeenCalledTimes(1)
        expect(h.liveUpdate.reload).toHaveBeenCalledTimes(1)
        await h.controller.apply()
        expect(h.liveUpdate.reload).toHaveBeenCalledTimes(1)
    })

    it('finishes an in-flight download before honoring an explicit apply', async () => {
        const h = harness()
        const downloaded = deferred<void>()
        h.liveUpdate.downloadBundle.mockImplementationOnce(async ({ bundleId }) => {
            await downloaded.promise
            h.state.downloaded.add(bundleId)
        })
        const checking = h.controller.check()
        await vi.waitFor(() => expect(h.liveUpdate.downloadBundle).toHaveBeenCalledTimes(1))
        const applying = h.controller.apply()
        expect(h.liveUpdate.setNextBundle).not.toHaveBeenCalled()
        downloaded.resolve()
        await Promise.all([checking, applying])
        expect(h.liveUpdate.setNextBundle).toHaveBeenCalledTimes(1)
        expect(h.liveUpdate.reload).toHaveBeenCalledTimes(1)
    })

    it.each(['blocked', 'incompatible', 'deleted'] as const)('rechecks a %s candidate after asynchronous preflight', async (condition) => {
        const h = harness()
        await h.controller.check()
        await h.controller.apply(async () => {
            if (condition === 'blocked') h.state.blocked = [bundle]
            if (condition === 'incompatible') h.state.config.runtimeVersion = priorBundle
            if (condition === 'deleted') h.state.downloaded.delete(bundle)
        })
        expect(h.controller.getSnapshot().needRefresh).toBe(false)
        expect(h.liveUpdate.setNextBundle).not.toHaveBeenCalled()
        expect(h.liveUpdate.reload).not.toHaveBeenCalled()
    })

    it('does not select anything if route/draft preservation fails', async () => {
        const h = harness()
        await h.controller.check()
        await h.controller.apply(() => { throw new Error('Cannot persist route') })
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'available', needRefresh: true })
        expect(h.controller.getSnapshot().error).toContain('Could not save the current draft before updating. Cannot persist route')
        expect(h.liveUpdate.setNextBundle).not.toHaveBeenCalled()
        expect(h.liveUpdate.reload).not.toHaveBeenCalled()
    })

    it.each(['setNextBundle', 'reload'] as const)('restores the prior native selection if %s fails, without leaving a hidden next-start update', async (operation) => {
        const h = harness()
        setCurrent(h, priorBundle)
        h.state.next = priorBundle
        await h.controller.check()
        h.liveUpdate[operation].mockRejectedValueOnce(new Error('Native operation failed'))
        await h.controller.apply()
        expect(h.state.next).toBe(priorBundle)
        expect(h.liveUpdate.setNextBundle).toHaveBeenLastCalledWith({ bundleId: priorBundle })
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'available', needRefresh: true })
        expect(h.controller.getSnapshot().error).toContain('Could not apply')
        if (operation === 'setNextBundle') expect(h.liveUpdate.reload).not.toHaveBeenCalled()
    })

    it('does not activate without persisted ordering metadata', async () => {
        const h = harness()
        h.storage.setItem.mockImplementation(() => { throw new Error('Quota exhausted') })
        await h.controller.check()
        const beforeApply = vi.fn()
        await h.controller.apply(beforeApply)
        expect(h.controller.getSnapshot().error).toContain('Could not save update information')
        expect(beforeApply).not.toHaveBeenCalled()
        expect(h.liveUpdate.setNextBundle).not.toHaveBeenCalled()
        expect(h.liveUpdate.reload).not.toHaveBeenCalled()
    })
})

describe('bounded requests and stale asynchronous work', () => {
    it('does not acknowledge a vanished UI when plugin loading finishes after disposal', async () => {
        const runtime = deferred<NativeUpdateRuntime>()
        const h = harness({ loadRuntime: () => runtime.promise })
        const initializing = h.controller.initialize()
        h.controller.dispose()
        runtime.resolve(h.runtime)
        await initializing
        expect(h.liveUpdate.ready).not.toHaveBeenCalled()
        expect(h.getConfig).not.toHaveBeenCalled()
        expect(h.fetch).not.toHaveBeenCalled()
    })

    it('rejects excessive declared manifest size without consuming the body', async () => {
        const h = harness()
        const cancel = vi.fn()
        const body = new ReadableStream<Uint8Array>({ cancel })
        h.fetch.mockResolvedValueOnce(new Response(body, { headers: { 'Content-Length': String(64 * 1024 + 1) } }))
        await h.controller.check()
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(h.liveUpdate.downloadBundle).not.toHaveBeenCalled()
        expect(h.controller.getSnapshot().error).toContain('too large')
    })

    it('bounds streamed metadata even when Content-Length lies', async () => {
        const h = harness()
        const cancel = vi.fn()
        h.fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)) }, cancel,
        }), { headers: { 'Content-Length': '1' } }))
        await h.controller.check()
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'error', needRefresh: false })
        expect(h.liveUpdate.downloadBundle).not.toHaveBeenCalled()
    })

    it('aborts a timed-out feed request without blocking startup readiness', async () => {
        vi.useFakeTimers()
        const h = harness({ requestTimeoutMs: 100 })
        h.fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }))
        const checking = h.controller.check()
        await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1))
        await vi.advanceTimersByTimeAsync(101)
        await checking
        expect(h.liveUpdate.ready).toHaveBeenCalledTimes(1)
        expect(h.controller.getSnapshot()).toMatchObject({ status: 'error', needRefresh: false })
        expect(h.liveUpdate.downloadBundle).not.toHaveBeenCalled()
    })

    it('aborts disposed requests and ignores even a late successful response', async () => {
        const h = harness()
        const response = deferred<Response>()
        h.fetch.mockReturnValueOnce(response.promise)
        const listener = vi.fn()
        h.controller.subscribe(listener)
        const checking = h.controller.check()
        await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1))
        const signal = h.fetch.mock.calls[0][1]?.signal
        h.controller.dispose()
        listener.mockClear()
        response.resolve(new Response(JSON.stringify(update)))
        await checking
        expect(signal?.aborted).toBe(true)
        expect(listener).not.toHaveBeenCalled()
        expect(h.liveUpdate.downloadBundle).not.toHaveBeenCalled()
        expect(h.liveUpdate.setNextBundle).not.toHaveBeenCalled()
    })

    it('removes listeners and ignores a download that finishes after disposal', async () => {
        const h = harness()
        const download = deferred<void>()
        h.liveUpdate.downloadBundle.mockReturnValueOnce(download.promise)
        const listener = vi.fn()
        h.controller.subscribe(listener)
        const checking = h.controller.check()
        await vi.waitFor(() => expect(h.liveUpdate.downloadBundle).toHaveBeenCalledTimes(1))
        h.controller.dispose()
        listener.mockClear()
        h.state.progress?.({ bundleId: bundle, progress: 1, downloadedBytes: 1024, totalBytes: 1024 })
        download.resolve()
        await checking
        await h.controller.apply()
        expect(listener).not.toHaveBeenCalled()
        expect(h.removeListener).toHaveBeenCalledTimes(1)
        expect(h.liveUpdate.setNextBundle).not.toHaveBeenCalled()
        expect(h.liveUpdate.reload).not.toHaveBeenCalled()
    })

    it('undoes a native selection that finishes after disposal without reloading', async () => {
        const h = harness()
        await h.controller.check()
        const selection = deferred<void>()
        h.liveUpdate.setNextBundle.mockImplementationOnce(async ({ bundleId }) => {
            await selection.promise
            h.state.next = bundleId
        })
        const applying = h.controller.apply()
        await vi.waitFor(() => expect(h.liveUpdate.setNextBundle).toHaveBeenCalledTimes(1))
        h.controller.dispose()
        selection.resolve()
        await applying
        expect(h.state.next).toBeNull()
        expect(h.liveUpdate.setNextBundle).toHaveBeenLastCalledWith({ bundleId: null })
        expect(h.liveUpdate.reload).not.toHaveBeenCalled()
    })
})
