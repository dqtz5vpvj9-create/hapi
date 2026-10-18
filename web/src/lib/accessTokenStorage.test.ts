import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ native: false, available: true, get: vi.fn(), set: vi.fn(), remove: vi.fn() }))
vi.mock('@/lib/platform', () => ({ isNativePlatform: () => h.native }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isPluginAvailable: () => h.available } }))
vi.mock('@aparajita/capacitor-secure-storage', () => ({
    SecureStorage: { get: h.get, set: h.set, remove: h.remove },
    KeychainAccess: { whenUnlockedThisDeviceOnly: 1 },
}))

import { AccessTokenStorageError, clearAccessToken, readAccessToken, storeAccessToken } from './accessTokenStorage'

const hub = 'https://hub.example'
const key = 'hapi_access_token::' + hub

beforeEach(() => {
    h.native = false
    h.available = true
    h.get.mockReset().mockResolvedValue(null)
    h.set.mockReset().mockResolvedValue(undefined)
    h.remove.mockReset().mockResolvedValue(true)
    localStorage.clear()
})

describe('per-hub credential storage', () => {
    it('preserves the browser storage format and separates different hubs', async () => {
        await storeAccessToken(hub, 'first-access')
        await storeAccessToken('https://other.example', 'other-access')
        expect(localStorage.getItem(key)).toBe('first-access')
        expect(await readAccessToken(hub)).toBe('first-access')
        await clearAccessToken(hub)
        expect(await readAccessToken(hub)).toBeNull()
        expect(await readAccessToken('https://other.example')).toBe('other-access')
        expect(h.set).not.toHaveBeenCalled()
    })

    it('uses native secure storage with device-only access and no cloud synchronization', async () => {
        h.native = true
        await storeAccessToken(hub, 'opaque:namespace')
        expect(h.set).toHaveBeenCalledWith(key, 'opaque:namespace', false, false, 1)
        expect(localStorage.getItem(key)).toBeNull()
        h.get.mockResolvedValue('opaque:namespace')
        expect(await readAccessToken(hub)).toBe('opaque:namespace')
        expect(h.get).toHaveBeenCalledWith(key, false, false)
        await clearAccessToken(hub)
        expect(h.remove).toHaveBeenCalledWith(key, false)
    })

    it('does not recover native credentials from a plaintext browser entry', async () => {
        h.native = true
        localStorage.setItem(key, 'plaintext-must-not-be-used')
        expect(await readAccessToken(hub)).toBeNull()
        h.get.mockRejectedValue(new Error('OS storage locked'))
        await expect(readAccessToken(hub)).rejects.toBeInstanceOf(AccessTokenStorageError)
    })

    it('requires the native bridge before calling the secure plugin', async () => {
        h.native = true
        h.available = false
        await expect(readAccessToken(hub)).rejects.toBeInstanceOf(AccessTokenStorageError)
        await expect(storeAccessToken(hub, 'do-not-persist')).rejects.toBeInstanceOf(AccessTokenStorageError)
        expect(h.get).not.toHaveBeenCalled()
        expect(h.set).not.toHaveBeenCalled()
        expect(localStorage.getItem(key)).toBeNull()
    })

    it('reports native storage failures without a plaintext fallback', async () => {
        h.native = true
        h.set.mockRejectedValue(new Error('Keystore unavailable'))
        await expect(storeAccessToken(hub, 'do-not-persist')).rejects.toBeInstanceOf(AccessTokenStorageError)
        expect(localStorage.getItem(key)).toBeNull()
        h.get.mockResolvedValue({ invalid: 'stored type' })
        await expect(readAccessToken(hub)).rejects.toBeInstanceOf(AccessTokenStorageError)
    })

    it('keeps an earlier pending save ahead of replacement and removal for the same hub', async () => {
        h.native = true
        let finish!: () => void
        const pending = new Promise<void>(resolve => { finish = resolve })
        h.set.mockImplementationOnce(() => pending)
        const first = storeAccessToken(hub, 'old-access')
        await vi.waitFor(() => expect(h.set).toHaveBeenCalledTimes(1))
        const replacement = storeAccessToken(hub, 'new-access')
        const removal = clearAccessToken(hub)
        await Promise.resolve()
        expect(h.set).toHaveBeenCalledTimes(1)
        expect(h.remove).not.toHaveBeenCalled()
        finish()
        await Promise.all([first, replacement, removal])
        expect(h.set.mock.calls.map(call => call[1])).toEqual(['old-access', 'new-access'])
        expect(h.remove).toHaveBeenCalledWith(key, false)
    })
})
