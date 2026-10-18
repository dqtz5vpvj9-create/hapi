import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ native: true, registerSW: vi.fn() }))
vi.mock('@/lib/platform', () => ({ isNativePlatform: () => h.native }))
vi.mock('virtual:pwa-register', () => ({ registerSW: h.registerSW }))

import { normalizeServerUrl, useServerUrl } from './useServerUrl'
import { usePwaUpdate } from './usePwaUpdate'
import { usePWAInstall } from './usePWAInstall'
import { usePushNotifications } from './usePushNotifications'
import { requireHubUrlForLogin } from '@/lib/runtime-config'

beforeEach(() => {
    h.native = true
    h.registerSW.mockClear()
    localStorage.clear()
    window.history.replaceState({}, '', '/')
})

describe('packaged native app runtime', () => {
    it('requires an explicit hub instead of using the WebView asset origin', () => {
        const { result } = renderHook(() => useServerUrl())
        expect(result.current.serverUrl).toBeNull()
        expect(result.current.baseUrl).toBe('')
        expect(requireHubUrlForLogin()).toBe(true)
    })

    it('normalizes HTTPS hub identities and rejects unsupported native transports', () => {
        expect(normalizeServerUrl('https://Hub.Example:443/path?token=ignored')).toEqual({ ok: true, value: 'https://hub.example' })
        expect(normalizeServerUrl('http://hub.example').ok).toBe(false)
        expect(normalizeServerUrl('capacitor://localhost').ok).toBe(false)
        localStorage.setItem('hapi_hub_url', 'http://old-hub.example')
        const { result } = renderHook(() => useServerUrl())
        expect(result.current.baseUrl).toBe('')
    })

    it('preserves browser same-origin and explicit HTTP hub behavior', () => {
        h.native = false
        const { result } = renderHook(() => useServerUrl())
        expect(result.current.baseUrl).toBe(window.location.origin)
        expect(normalizeServerUrl('http://localhost:3006/')).toEqual({ ok: true, value: 'http://localhost:3006' })
    })

    it('does not register a service worker or offer installation inside the native app', () => {
        const { result } = renderHook(() => ({ update: usePwaUpdate(), install: usePWAInstall() }))
        expect(h.registerSW).not.toHaveBeenCalled()
        expect(result.current.update.needRefresh).toBe(false)
        expect(result.current.install.isStandalone).toBe(true)
        expect(result.current.install.canInstall).toBe(false)
        expect(result.current.install.canInstallIOS).toBe(false)
    })

    it('does not wait for a Web Push service worker or prompt for browser notifications', async () => {
        const { result } = renderHook(() => usePushNotifications(null))
        expect(result.current.isSupported).toBe(false)
        expect(await result.current.requestPermission()).toBe(false)
        expect(await result.current.subscribe()).toBe(false)
    })
})
