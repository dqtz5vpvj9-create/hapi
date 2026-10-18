import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareNativeUpdateReload, registerNativeUpdatePreparation, restoreNativeUpdateRoute, wasNativeUpdateRouteRestored } from './nativeUpdateReload'

describe('native update reload', () => {
    beforeEach(() => {
        sessionStorage.clear()
        window.history.replaceState(null, '', '/sessions')
    })
    afterEach(() => { vi.restoreAllMocks() })

    it('restores the current local route after a WebView reload at the root', async () => {
        window.history.replaceState(null, '', '/sessions/abc?view=files#output')
        await prepareNativeUpdateReload()
        window.history.replaceState(null, '', '/')
        restoreNativeUpdateRoute()
        expect(window.location.pathname + window.location.search + window.location.hash).toBe('/sessions/abc?view=files#output')
        expect(sessionStorage.getItem('hapi:native-update-route')).toBeNull()
        expect(wasNativeUpdateRouteRestored()).toBe(true)
    })

    it('waits for mounted editors and propagates failure before storing a reload route', async () => {
        const unregister = registerNativeUpdatePreparation(() => Promise.reject(new Error('draft write failed')))
        try {
            await expect(prepareNativeUpdateReload()).rejects.toThrow('draft write failed')
            expect(sessionStorage.getItem('hapi:native-update-route')).toBeNull()
        } finally { unregister() }
        await expect(prepareNativeUpdateReload()).resolves.toBeUndefined()
    })

    it('does not treat a failed second attempt as a new document restoration', async () => {
        await prepareNativeUpdateReload()
        restoreNativeUpdateRoute()
        expect(wasNativeUpdateRouteRestored()).toBe(true)
        const unregister = registerNativeUpdatePreparation(() => { throw new Error('storage full') })
        try {
            await expect(prepareNativeUpdateReload()).rejects.toThrow('storage full')
            expect(wasNativeUpdateRouteRestored()).toBe(false)
        } finally { unregister() }
    })

    it.each(['https://evil.example/', '//evil.example/', '/\\evil.example/', '/\n/evil.example/'])('rejects an unsafe restore path: %s', (path) => {
        sessionStorage.setItem('hapi:native-update-route', JSON.stringify({ path, savedAt: Date.now() }))
        restoreNativeUpdateRoute()
        expect(window.location.pathname).toBe('/sessions')
        expect(sessionStorage.getItem('hapi:native-update-route')).toBeNull()
        expect(wasNativeUpdateRouteRestored()).toBe(false)
    })

    it.each([Date.now() - 6 * 60 * 1000, Date.now() + 60_000, null])('ignores a stale or invalid route timestamp: %s', (savedAt) => {
        sessionStorage.setItem('hapi:native-update-route', JSON.stringify({ path: '/settings', savedAt }))
        restoreNativeUpdateRoute()
        expect(window.location.pathname).toBe('/sessions')
    })

    it('does not block startup when route storage is unavailable', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
        expect(restoreNativeUpdateRoute).not.toThrow()
    })
})
