import { Capacitor, registerPlugin } from '@capacitor/core'
import type { LiveUpdatePlugin } from '@capawesome/capacitor-live-update'
import { nativePlatform } from '@/lib/platform'

export type NativeUpdateStatus = 'idle' | 'checking' | 'downloading' | 'available' | 'app-required' | 'applying' | 'error'

export interface NativeUpdateState {
    status: NativeUpdateStatus
    needRefresh: boolean
    progress: number | null
    error: string | null
    version: string | null
}

/** These values come from the installed native binary, never the downloaded JavaScript or a Hub. */
export interface NativeUpdateConfig {
    feedUrl: string
    runtimeVersion: string
    builtInBundleId: string
    builtInCreatedAt: number
    publicKey?: string
}

export interface NativeUpdateManifest {
    schemaVersion: 1
    bundleId: string
    version: string
    createdAt: number
    runtimes: { android: string; ios: string }
    url: string
    sha256: string
    size: number
    signature?: string
}

export type NativeUpdatePlugin = Pick<LiveUpdatePlugin,
    'ready' | 'getCurrentBundle' | 'getNextBundle' | 'getBlockedBundles' | 'getDownloadedBundles' |
    'downloadBundle' | 'deleteBundle' | 'setNextBundle' | 'reload' | 'addListener'>

export interface NativeUpdateRuntime {
    platform: 'android' | 'ios'
    liveUpdate: NativeUpdatePlugin
    getConfig: () => Promise<NativeUpdateConfig>
}

export interface NativeUpdateOptions {
    loadRuntime?: () => Promise<NativeUpdateRuntime>
    fetch?: typeof fetch
    storage?: Pick<Storage, 'getItem' | 'setItem'> | null
    requestTimeoutMs?: number
}

const HASH = /^[a-f0-9]{64}$/
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_BUNDLE_BYTES = 120 * 1024 * 1024
const INITIAL_STATE: NativeUpdateState = { status: 'idle', needRefresh: false, progress: null, error: null, version: null }

class NativeUpdateError extends Error {}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function httpsUrl(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 8192) return false
    try {
        const url = new URL(value)
        return url.protocol === 'https:' && !url.username && !url.password && !url.hash
    } catch {
        return false
    }
}

function parseConfig(value: unknown): NativeUpdateConfig {
    if (!record(value) || !httpsUrl(value.feedUrl) || typeof value.runtimeVersion !== 'string' || !HASH.test(value.runtimeVersion)
        || typeof value.builtInBundleId !== 'string' || !value.builtInBundleId || value.builtInBundleId.length > 128
        || !Number.isSafeInteger(value.builtInCreatedAt) || (value.builtInCreatedAt as number) < 0
        || (value.publicKey !== undefined && (typeof value.publicKey !== 'string'
            || value.publicKey.length > 16384 || !value.publicKey.includes('-----BEGIN PUBLIC KEY-----')
            || !value.publicKey.includes('-----END PUBLIC KEY-----')))) {
        throw new NativeUpdateError('This app does not have a valid update configuration.')
    }
    return value as unknown as NativeUpdateConfig
}

function parseManifest(value: unknown, requireSignature: boolean): NativeUpdateManifest {
    if (!record(value) || value.schemaVersion !== 1 || typeof value.bundleId !== 'string' || !HASH.test(value.bundleId)
        || value.sha256 !== value.bundleId || typeof value.version !== 'string' || !value.version.trim() || value.version.length > 128
        || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0
        || !record(value.runtimes) || typeof value.runtimes.android !== 'string' || !HASH.test(value.runtimes.android)
        || typeof value.runtimes.ios !== 'string' || !HASH.test(value.runtimes.ios)
        || !httpsUrl(value.url) || !Number.isSafeInteger(value.size) || (value.size as number) <= 0
        || (value.size as number) > MAX_BUNDLE_BYTES
        || (value.signature !== undefined && (typeof value.signature !== 'string' || !value.signature
            || value.signature.length > 16384 || !BASE64.test(value.signature)))
        || (requireSignature && !value.signature)) {
        throw new NativeUpdateError('The update information is invalid or cannot be verified.')
    }
    // Rebuild the object so unrecognized publisher fields are never forwarded to the bridge.
    return {
        schemaVersion: 1,
        bundleId: value.bundleId,
        version: value.version,
        createdAt: value.createdAt as number,
        runtimes: { android: value.runtimes.android, ios: value.runtimes.ios },
        url: value.url,
        sha256: value.sha256 as string,
        size: value.size as number,
        ...(value.signature ? { signature: value.signature as string } : {}),
    }
}

async function loadNativeRuntime(): Promise<NativeUpdateRuntime> {
    const platform = nativePlatform()
    if (!platform || !Capacitor.isPluginAvailable('LiveUpdate')) {
        throw new NativeUpdateError('Live updates are unavailable in this app installation.')
    }
    // Check native implementations before registering JS proxies. A proxy alone is not a native capability.
    const hasNativeConfig = Capacitor.isPluginAvailable('HapiUpdates')
    const { LiveUpdate } = await import('@capawesome/capacitor-live-update')
    const configPlugin = hasNativeConfig ? registerPlugin<{ getConfig(): Promise<NativeUpdateConfig> }>('HapiUpdates') : null
    return {
        platform,
        liveUpdate: LiveUpdate,
        getConfig: () => configPlugin?.getConfig()
            ?? Promise.reject(new NativeUpdateError('Live updates are unavailable in this app installation.')),
    }
}

function browserStorage(): NativeUpdateOptions['storage'] {
    try { return globalThis.localStorage } catch { return null }
}

interface UpdateContext {
    config: NativeUpdateConfig
    currentBundleId: string | null
    currentCreatedAt: number | null
    blocked: Set<string>
}

/** A download is only a candidate. setNextBundle/reload are exclusive to an explicit apply(). */
export class NativeUpdateController {
    private state: NativeUpdateState = INITIAL_STATE
    private readonly listeners = new Set<() => void>()
    private readonly loadRuntime: () => Promise<NativeUpdateRuntime>
    private readonly fetch: typeof fetch
    private readonly storage: NativeUpdateOptions['storage']
    private readonly requestTimeoutMs: number
    private runtime: NativeUpdateRuntime | null = null
    private config: NativeUpdateConfig | null = null
    private initialization: Promise<void> | null = null
    private readiness: ReturnType<NativeUpdatePlugin['ready']> | null = null
    private initialized = false
    private checkPromise: Promise<void> | null = null
    private applyPromise: Promise<void> | null = null
    private candidate: NativeUpdateManifest | null = null
    private readonly rolledBackBundles = new Set<string>()
    private request: AbortController | null = null
    private progressListener: { remove(): Promise<void> } | null = null
    private disposed = false
    private applied = false

    constructor(options: NativeUpdateOptions = {}) {
        this.loadRuntime = options.loadRuntime ?? loadNativeRuntime
        this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
        this.storage = options.storage === undefined ? browserStorage() : options.storage
        this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000
    }

    getSnapshot = (): NativeUpdateState => this.state

    subscribe = (listener: () => void): (() => void) => {
        if (!this.disposed) this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }

    initialize(): Promise<void> {
        if (this.disposed) return Promise.resolve()
        if (this.initialization) return this.initialization
        if (this.initialized) return Promise.resolve()
        const promise = this.initializeInternal().catch((error: unknown) => {
            this.fail(error, 'Could not initialize app updates.')
        }).finally(() => {
            if (this.initialization === promise) this.initialization = null
        })
        this.initialization = promise
        return promise
    }

    private async initializeInternal(): Promise<void> {
        this.runtime ??= await this.loadRuntime()
        if (this.disposed) return
        // A healthy offline UI must acknowledge readiness before reading a Hub or update feed.
        this.readiness ??= this.runtime.liveUpdate.ready()
        const ready = await this.readiness
        if (this.disposed) return
        if (ready.rollback && ready.previousBundleId) this.rolledBackBundles.add(ready.previousBundleId)
        this.config = parseConfig(await this.runtime.getConfig())
        if (this.disposed) return
        try {
            const saved = this.storage?.getItem(this.candidateKey(this.config))
            const candidate = saved && saved.length <= MAX_MANIFEST_BYTES ? parseManifest(JSON.parse(saved), !!this.config.publicKey) : null
            if (candidate) {
                const context = await this.context()
                const downloaded = await this.runtime.liveUpdate.getDownloadedBundles()
                if (this.disposition(candidate, context) === 'available' && downloaded.bundleIds.includes(candidate.bundleId)) this.candidate = candidate
            }
        } catch { /* A broken cache entry must not prevent a healthy UI from starting. */ }
        this.publish({
            ...INITIAL_STATE,
            status: this.candidate ? 'available' : 'idle',
            needRefresh: !!this.candidate,
            progress: this.candidate ? 1 : null,
            version: this.candidate?.version ?? null,
            error: ready.rollback ? 'The previous update could not start. HAPI restored its built-in version.' : null,
        })
        await this.pruneBundles()
        if (!this.disposed) this.initialized = true
    }

    check(): Promise<void> {
        if (this.disposed || this.applied) return Promise.resolve()
        if (this.applyPromise) return this.applyPromise
        if (this.checkPromise) return this.checkPromise
        const promise = this.checkInternal().catch((error: unknown) => {
            this.fail(error, 'Could not check for an update. Try again.')
        }).finally(() => {
            if (this.checkPromise === promise) this.checkPromise = null
        })
        this.checkPromise = promise
        return promise
    }

    private async checkInternal(): Promise<void> {
        await this.initialize()
        if (!this.initialized || this.disposed) return
        const context = await this.context()
        if (this.disposed) return
        if (this.candidate && this.disposition(this.candidate, context) !== 'available') this.candidate = null
        this.publish({ status: 'checking', needRefresh: !!this.candidate, progress: null, error: null, version: this.candidate?.version ?? null })
        const manifest = parseManifest(await this.fetchManifest(context.config.feedUrl), !!context.config.publicKey)
        if (this.disposed) return
        const disposition = this.disposition(manifest, context)
        if (disposition !== 'available') {
            this.candidate = null
            this.publish({ ...INITIAL_STATE, status: disposition, version: disposition === 'app-required' ? manifest.version : null })
            return
        }

        const cached = this.candidate?.bundleId === manifest.bundleId ? this.candidate : this.readManifest(context.config, manifest.bundleId)
        const downloaded = await this.runtime!.liveUpdate.getDownloadedBundles()
        if (this.disposed) return
        if (!cached || JSON.stringify(cached) !== JSON.stringify(manifest) || !downloaded.bundleIds.includes(manifest.bundleId)) {
            if (downloaded.bundleIds.includes(manifest.bundleId)) {
                // The SDK refuses duplicate IDs. An interrupted earlier WebView may
                // have left an archive without metadata proving it was verified here.
                const liveUpdate = this.runtime!.liveUpdate
                const [current, next] = await Promise.all([liveUpdate.getCurrentBundle(), liveUpdate.getNextBundle()])
                if (this.disposed) return
                if (current.bundleId === manifest.bundleId || next.bundleId === manifest.bundleId) {
                    throw new NativeUpdateError('This update is already active or selected. Reopen HAPI before trying again.')
                }
                if (this.candidate?.bundleId === manifest.bundleId) this.candidate = null
                await liveUpdate.deleteBundle({ bundleId: manifest.bundleId })
                if (this.disposed) return
            }
            this.publish({ status: 'downloading', needRefresh: !!this.candidate, progress: 0, error: null, version: manifest.version })
            await this.download(manifest)
            if (this.disposed) return
        }
        // Native installation/rollback state may have changed while the archive was downloading.
        const latestContext = await this.context()
        if (this.disposed) return
        const latestDisposition = this.disposition(manifest, latestContext)
        if (latestDisposition !== 'available') {
            this.candidate = null
            this.publish({ ...INITIAL_STATE, status: latestDisposition, version: latestDisposition === 'app-required' ? manifest.version : null })
            return
        }
        this.writeManifest(latestContext.config, manifest)
        this.candidate = manifest
        this.publish({ status: 'available', needRefresh: true, progress: 1, error: null, version: manifest.version })
        await this.pruneBundles()
    }

    private async download(manifest: NativeUpdateManifest): Promise<void> {
        const listener = await this.runtime!.liveUpdate.addListener('downloadBundleProgress', (event) => {
            if (event.bundleId !== manifest.bundleId || this.disposed || this.state.status !== 'downloading') return
            if (!Number.isFinite(event.progress)) return
            this.publish({ ...this.state, progress: Math.max(0, Math.min(1, event.progress)) })
        })
        if (this.disposed) {
            await listener.remove()
            return
        }
        this.progressListener = listener
        try {
            await this.runtime!.liveUpdate.downloadBundle({
                artifactType: 'zip',
                bundleId: manifest.bundleId,
                url: manifest.url,
                checksum: manifest.sha256,
                ...(manifest.signature ? { signature: manifest.signature } : {}),
            })
        } finally {
            if (this.progressListener === listener) {
                this.progressListener = null
                await listener.remove().catch(() => {})
            }
        }
    }

    apply(beforeApply?: () => void | Promise<void>): Promise<void> {
        if (this.disposed || this.applied) return Promise.resolve()
        if (this.applyPromise) return this.applyPromise
        const pendingCheck = this.checkPromise
        const promise = this.applyInternal(pendingCheck, beforeApply).catch((error: unknown) => {
            this.fail(error, 'Could not apply the update. Try again.')
        }).finally(() => {
            if (this.applyPromise === promise) this.applyPromise = null
        })
        this.applyPromise = promise
        return promise
    }

    private async applyInternal(pendingCheck: Promise<void> | null, beforeApply?: () => void | Promise<void>): Promise<void> {
        await pendingCheck
        await this.initialize()
        if (this.disposed || !this.initialized || !this.candidate) return
        const candidate = this.candidate
        this.publish({ status: 'applying', needRefresh: false, progress: null, error: null, version: candidate.version })
        const context = await this.ensureApplicable(candidate)
        if (this.disposed) return
        this.writeManifest(context.config, candidate)
        if (JSON.stringify(this.readManifest(context.config, candidate.bundleId)) !== JSON.stringify(candidate)) {
            throw new NativeUpdateError('Could not save update information. Free some device storage and try again.')
        }
        try {
            await beforeApply?.()
        } catch (error) {
            const detail = error instanceof Error ? ` ${error.message.slice(0, 300)}` : ''
            throw new NativeUpdateError(`Could not save the current draft before updating.${detail}`)
        }
        if (this.disposed) return
        // Preflight may save drafts asynchronously. Recheck immediately before changing native selection.
        await this.ensureApplicable(candidate)
        if (this.disposed) return
        const liveUpdate = this.runtime!.liveUpdate
        const previous = await liveUpdate.getNextBundle()
        if (this.disposed) return
        let selected = false
        try {
            selected = true
            await liveUpdate.setNextBundle({ bundleId: candidate.bundleId })
            if (this.disposed) {
                await liveUpdate.setNextBundle({ bundleId: previous.bundleId })
                return
            }
            await liveUpdate.reload()
            this.applied = true
        } catch (error) {
            if (selected) {
                try {
                    await liveUpdate.setNextBundle({ bundleId: previous.bundleId })
                } catch {
                    throw new NativeUpdateError('The update could not be applied or reset. Close and reopen HAPI.')
                }
            }
            throw error
        }
    }

    private async ensureApplicable(candidate: NativeUpdateManifest): Promise<UpdateContext> {
        const context = await this.context()
        const disposition = this.disposition(parseManifest(candidate, !!context.config.publicKey), context)
        if (disposition !== 'available') {
            this.candidate = null
            this.publish({ ...INITIAL_STATE, status: disposition, version: disposition === 'app-required' ? candidate.version : null })
            throw new NativeUpdateError(disposition === 'app-required'
                ? 'This update requires a newer app installation.' : 'This update is no longer applicable.')
        }
        const downloaded = await this.runtime!.liveUpdate.getDownloadedBundles()
        if (!downloaded.bundleIds.includes(candidate.bundleId)) {
            this.candidate = null
            throw new NativeUpdateError('The downloaded update is no longer available. Check for updates again.')
        }
        return context
    }

    private async context(): Promise<UpdateContext> {
        const runtime = this.runtime!
        const [rawConfig, current, blocked] = await Promise.all([
            runtime.getConfig(), runtime.liveUpdate.getCurrentBundle(), runtime.liveUpdate.getBlockedBundles(),
        ])
        const config = parseConfig(rawConfig)
        if (this.config && (config.feedUrl !== this.config.feedUrl || config.publicKey !== this.config.publicKey)) {
            throw new NativeUpdateError('The installed app update configuration changed. Reopen HAPI.')
        }
        const metadata = current.bundleId ? this.readManifest(config, current.bundleId) : null
        return {
            config,
            currentBundleId: current.bundleId,
            currentCreatedAt: current.bundleId && current.bundleId !== config.builtInBundleId && !metadata
                ? null : Math.max(config.builtInCreatedAt, metadata?.createdAt ?? 0),
            blocked: new Set([...blocked.bundleIds, ...this.rolledBackBundles]),
        }
    }

    private disposition(manifest: NativeUpdateManifest, context: UpdateContext): 'available' | 'idle' | 'app-required' {
        if (manifest.bundleId === context.currentBundleId || manifest.bundleId === context.config.builtInBundleId
            || context.blocked.has(manifest.bundleId)) return 'idle'
        if (context.currentCreatedAt === null) {
            throw new NativeUpdateError('The current web version cannot be verified. Reinstall HAPI before updating.')
        }
        if (manifest.createdAt <= context.currentCreatedAt) return 'idle'
        return manifest.runtimes[this.runtime!.platform] === context.config.runtimeVersion ? 'available' : 'app-required'
    }

    private manifestKey(config: NativeUpdateConfig, bundleId: string): string {
        return `hapi_native_update::${config.runtimeVersion}::${bundleId}`
    }

    private candidateKey(config: NativeUpdateConfig): string {
        return `hapi_native_update_candidate::${config.runtimeVersion}`
    }

    private readManifest(config: NativeUpdateConfig, bundleId: string): NativeUpdateManifest | null {
        try {
            const value = this.storage?.getItem(this.manifestKey(config, bundleId))
            if (!value || value.length > MAX_MANIFEST_BYTES) return null
            const manifest = parseManifest(JSON.parse(value), !!config.publicKey)
            return manifest.bundleId === bundleId && manifest.runtimes[this.runtime!.platform] === config.runtimeVersion ? manifest : null
        } catch { return null }
    }

    private writeManifest(config: NativeUpdateConfig, manifest: NativeUpdateManifest): void {
        try {
            const serialized = JSON.stringify(manifest)
            this.storage?.setItem(this.manifestKey(config, manifest.bundleId), serialized)
            this.storage?.setItem(this.candidateKey(config), serialized)
        } catch { /* apply() verifies persistence before changing the native bundle selection. */ }
    }

    private async pruneBundles(): Promise<void> {
        if (this.disposed) return
        try {
            const liveUpdate = this.runtime!.liveUpdate
            const [current, next, downloaded] = await Promise.all([
                liveUpdate.getCurrentBundle(), liveUpdate.getNextBundle(), liveUpdate.getDownloadedBundles(),
            ])
            const keep = new Set([current.bundleId, next.bundleId, this.candidate?.bundleId])
            for (const bundleId of downloaded.bundleIds) {
                if (this.disposed) return
                if (HASH.test(bundleId) && !keep.has(bundleId)) await liveUpdate.deleteBundle({ bundleId })
            }
        } catch { /* Cache cleanup is best effort and never changes the current or next bundle. */ }
    }

    private async fetchManifest(url: string): Promise<unknown> {
        const controller = new AbortController()
        this.request = controller
        const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs)
        try {
            const response = await this.fetch(url, { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal })
            if (!response.ok) throw new NativeUpdateError('Could not check for an update. Try again.')
            const length = response.headers.get('Content-Length')
            if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_MANIFEST_BYTES)) {
                await response.body?.cancel().catch(() => {})
                throw new NativeUpdateError('The update information is too large.')
            }
            if (!response.body) throw new NativeUpdateError('The update information is empty.')
            const reader = response.body.getReader()
            const chunks: Uint8Array[] = []
            let size = 0
            try {
                while (true) {
                    const { done, value } = await reader.read()
                    if (done) break
                    size += value.byteLength
                    if (size > MAX_MANIFEST_BYTES || controller.signal.aborted || this.disposed) {
                        await reader.cancel().catch(() => {})
                        throw new NativeUpdateError('The update information could not be downloaded.')
                    }
                    chunks.push(value)
                }
            } finally {
                reader.releaseLock()
            }
            const bytes = new Uint8Array(size)
            let offset = 0
            for (const chunk of chunks) {
                bytes.set(chunk, offset)
                offset += chunk.byteLength
            }
            return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
        } finally {
            clearTimeout(timeout)
            if (this.request === controller) this.request = null
        }
    }

    private fail(error: unknown, fallback: string): void {
        this.publish({
            status: this.candidate ? 'available' : this.state.status === 'app-required' ? 'app-required' : 'error',
            needRefresh: !!this.candidate,
            progress: this.candidate ? 1 : null,
            error: error instanceof NativeUpdateError ? error.message : fallback,
            version: this.candidate?.version ?? this.state.version,
        })
    }

    private publish(state: NativeUpdateState): void {
        if (this.disposed) return
        this.state = state
        for (const listener of this.listeners) listener()
    }

    dispose(): void {
        this.disposed = true
        this.request?.abort()
        this.listeners.clear()
        const listener = this.progressListener
        this.progressListener = null
        if (listener) void listener.remove().catch(() => {})
    }
}
