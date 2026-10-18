import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ authenticate: vi.fn(), bind: vi.fn() }))

vi.mock('@/api/client', () => ({
    ApiClient: class {
        constructor(public token: string, public options: {
            baseUrl: string
            getToken?: () => string | null
            onUnauthorized?: () => Promise<string | null>
        }) {}
        authenticate(payload: unknown) { return h.authenticate(this.options.baseUrl, payload) }
        bind(payload: unknown) { return h.bind(this.options.baseUrl, payload) }
    },
    ApiError: class extends Error {},
}))
vi.mock('@/hooks/useTelegram', () => ({ getTelegramWebApp: () => null, isTelegramEnvironment: () => false }))

import { useAuth, type AuthSource } from './useAuth'
import { useAuthSource } from './useAuthSource'

const alpha = 'https://alpha.example'
const beta = 'https://beta.example'
const alphaSource: AuthSource = { type: 'accessToken', token: 'alpha-access' }
const betaSource: AuthSource = { type: 'accessToken', token: 'beta-access' }
const auth = (token: string) => ({ token, user: { id: 1, firstName: 'Test' } })
type Client = { options: { getToken: () => string | null; onUnauthorized: () => Promise<string | null> } }

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}

beforeEach(() => {
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    h.authenticate.mockReset().mockImplementation(async (url: string) => auth(url + '-jwt'))
    h.bind.mockReset()
})

describe('hub credential isolation', () => {
    it('consumes a direct-access URL token once without resurrecting it after a hub switch', async () => {
        window.history.replaceState({}, '', '/?token=original-link-access')
        const { result, rerender } = renderHook(({ url }) => useAuthSource(url), { initialProps: { url: alpha } })
        await waitFor(() => expect(result.current.authSource).toEqual({ type: 'accessToken', token: 'original-link-access' }))
        expect(new URLSearchParams(window.location.search).has('token')).toBe(false)
        await act(async () => { await result.current.setAccessToken('replacement-access') })
        rerender({ url: beta })
        await waitFor(() => expect(result.current.isLoading).toBe(false))
        expect(result.current.authSource).toBeNull()
        rerender({ url: alpha })
        await waitFor(() => expect(result.current.authSource).toEqual({ type: 'accessToken', token: 'replacement-access' }))
        expect(localStorage.getItem('hapi_access_token::' + alpha)).toBe('replacement-access')
    })

    it('never exchanges the previous hub access token at the newly selected hub', async () => {
        localStorage.setItem('hapi_access_token::' + alpha, 'alpha-access')
        localStorage.setItem('hapi_access_token::' + beta, 'beta-access')
        const { result, rerender } = renderHook(({ url }) => {
            const source = useAuthSource(url)
            return useAuth(source.authSource, url)
        }, { initialProps: { url: alpha } })
        await waitFor(() => expect(result.current.token).toBe(alpha + '-jwt'))
        rerender({ url: beta })
        await waitFor(() => expect(result.current.token).toBe(beta + '-jwt'))
        expect(h.authenticate.mock.calls).toEqual([
            [alpha, { accessToken: 'alpha-access' }],
            [beta, { accessToken: 'beta-access' }],
        ])
    })

    it('makes the previous hub client inert immediately after switching hubs', async () => {
        const { result, rerender } = renderHook(({ source, url }) => useAuth(source, url), {
            initialProps: { source: alphaSource, url: alpha },
        })
        await waitFor(() => expect(result.current.api).not.toBeNull())
        const oldClient = result.current.api as unknown as Client
        rerender({ source: betaSource, url: beta })
        expect(oldClient.options.getToken()).toBeNull()
        await waitFor(() => expect(result.current.token).toBe(beta + '-jwt'))
        const calls = h.authenticate.mock.calls.length
        await act(async () => { expect(await oldClient.options.onUnauthorized()).toBeNull() })
        expect(h.authenticate).toHaveBeenCalledTimes(calls)
        expect(result.current.token).toBe(beta + '-jwt')
    })

    it('ignores a refresh from the previous hub that finishes after a new login', async () => {
        const pending = deferred<ReturnType<typeof auth>>()
        const { result, rerender } = renderHook(({ source, url }) => useAuth(source, url), {
            initialProps: { source: alphaSource, url: alpha },
        })
        await waitFor(() => expect(result.current.api).not.toBeNull())
        const oldClient = result.current.api as unknown as Client
        h.authenticate.mockImplementationOnce(() => pending.promise)
        let refreshing!: Promise<string | null>
        act(() => { refreshing = oldClient.options.onUnauthorized() })
        rerender({ source: betaSource, url: beta })
        await waitFor(() => expect(result.current.token).toBe(beta + '-jwt'))
        await act(async () => {
            pending.resolve(auth('late-alpha-jwt'))
            expect(await refreshing).toBeNull()
        })
        expect(result.current.token).toBe(beta + '-jwt')
    })

    it('invalidates a previous account client when credentials change within one hub', async () => {
        const { result, rerender } = renderHook(({ source }) => useAuth(source, alpha), {
            initialProps: { source: alphaSource as AuthSource | null },
        })
        await waitFor(() => expect(result.current.api).not.toBeNull())
        const oldClient = result.current.api as unknown as Client
        rerender({ source: null })
        expect(result.current.api).toBeNull()
        expect(result.current.token).toBeNull()
        expect(oldClient.options.getToken()).toBeNull()
        await act(async () => { expect(await oldClient.options.onUnauthorized()).toBeNull() })
    })
})
