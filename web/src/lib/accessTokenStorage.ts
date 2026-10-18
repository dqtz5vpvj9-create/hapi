import { Capacitor } from '@capacitor/core'
import { isNativePlatform } from '@/lib/platform'

const ACCESS_TOKEN_PREFIX = 'hapi_access_token::'
const pendingMutations = new Map<string, Promise<void>>()

function mutateInOrder(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = pendingMutations.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    pendingMutations.set(key, next)
    void next.finally(() => {
        if (pendingMutations.get(key) === next) pendingMutations.delete(key)
    }).catch(() => {})
    return next
}

export class AccessTokenStorageError extends Error {
    constructor() {
        super('Secure credential storage is unavailable. Unlock the device and try again.')
        this.name = 'AccessTokenStorageError'
    }
}

async function nativeStorage() {
    try {
        // The plugin also has a plaintext Web implementation. Never use it for
        // native credentials or fall back to localStorage when a bridge fails.
        if (!isNativePlatform()) throw new AccessTokenStorageError()
        // Check before import: this plugin registers JS native wrappers, which
        // alone make isPluginAvailable true even without the native backend.
        if (!Capacitor.isPluginAvailable('SecureStorage')) throw new AccessTokenStorageError()
        return await import('@aparajita/capacitor-secure-storage')
    } catch {
        throw new AccessTokenStorageError()
    }
}

export async function readAccessToken(baseUrl: string): Promise<string | null> {
    if (!baseUrl) return null
    const key = ACCESS_TOKEN_PREFIX + baseUrl
    if (isNativePlatform()) {
        try {
            const { SecureStorage } = await nativeStorage()
            const value = await SecureStorage.get(key, false, false)
            if (value !== null && typeof value !== 'string') throw new AccessTokenStorageError()
            return value
        } catch {
            throw new AccessTokenStorageError()
        }
    }
    try { return localStorage.getItem(key) } catch { return null }
}

export async function storeAccessToken(baseUrl: string, token: string): Promise<void> {
    if (!baseUrl) throw new AccessTokenStorageError()
    const key = ACCESS_TOKEN_PREFIX + baseUrl
    if (isNativePlatform()) {
        try {
            await mutateInOrder(key, async () => {
                const { SecureStorage, KeychainAccess } = await nativeStorage()
                await SecureStorage.set(key, token, false, false, KeychainAccess.whenUnlockedThisDeviceOnly)
            })
            return
        } catch {
            throw new AccessTokenStorageError()
        }
    }
    try { localStorage.setItem(key, token) } catch { /* Browser private-mode login stays available. */ }
}

export async function clearAccessToken(baseUrl: string): Promise<void> {
    if (!baseUrl) return
    const key = ACCESS_TOKEN_PREFIX + baseUrl
    if (isNativePlatform()) {
        try {
            await mutateInOrder(key, async () => {
                const { SecureStorage } = await nativeStorage()
                await SecureStorage.remove(key, false)
            })
            return
        } catch {
            throw new AccessTokenStorageError()
        }
    }
    try { localStorage.removeItem(key) } catch { /* Browser storage may be disabled. */ }
}
