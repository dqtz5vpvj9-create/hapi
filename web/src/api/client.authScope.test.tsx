import { StrictMode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './client'
import { useAuth, type AuthSource } from '@/hooks/useAuth'

const requests: Array<[string, (api: ApiClient) => Promise<unknown>]> = [
    ['REST read', api => api.getSessions()],
    ['attachment upload', api => api.uploadFile('session', 'file.txt', 'YQ==', 'text/plain')],
    ['document preview', api => api.getDocumentPreview('session', { kind: 'file', path: 'report.pdf' })],
    ['document range', api => api.readDocumentPreviewRange('session', 'preview', 0, 1, new AbortController().signal)],
    ['artifact', api => api.getArtifactBlob('session', 'artifact')],
    ['generated image', api => api.getGeneratedImageBlob('session', 'image')],
    ['scratchlist attachment', api => api.fetchScratchlistAttachmentBlob('session', 'attachment')],
    ['session migration', api => api.migrateCursorSessionToAcp('session')],
]

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('ApiClient invalidated credential providers', () => {
    it.each(requests)('blocks %s before sending a construction-time JWT', async (_name, request) => {
        const refresh = vi.fn(async () => 'should-not-refresh')
        const api = new ApiClient('previous-account-jwt', {
            baseUrl: 'https://old-hub.example',
            getToken: () => null,
            onUnauthorized: refresh,
        })
        // An accidental request would succeed at the old hub, revealing the
        // bug rather than relying on the hub to reject its still-valid JWT.
        fetchMock.mockResolvedValue(new Response('{}'))
        await expect(request(api)).rejects.toMatchObject({ status: 401 })
        expect(fetchMock).not.toHaveBeenCalled()
        expect(refresh).not.toHaveBeenCalled()
    })

    it.each(requests)('preserves construction-time tokens without a provider for %s', async (_name, request) => {
        const api = new ApiClient('standalone-jwt', { baseUrl: 'https://hub.example' })
        fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
        await request(api).catch(() => {})
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
        expect(headers.get('authorization')).toBe('Bearer standalone-jwt')
    })

    it('stops a queued 401 retry when the provider is invalidated during refresh', async () => {
        let currentToken: string | null = 'active-jwt'
        const pending = deferred<string | null>()
        const refresh = vi.fn(() => pending.promise)
        const api = new ApiClient('constructor-jwt', { getToken: () => currentToken, onUnauthorized: refresh })
        fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
        const result = api.getSessions()
        const rejected = expect(result).rejects.toMatchObject({ status: 401 })
        await waitFor(() => expect(refresh).toHaveBeenCalledOnce())
        currentToken = null
        pending.resolve('late-refreshed-jwt')
        await rejected
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('stops a generated-image cache retry after the provider is invalidated', async () => {
        let currentToken: string | null = 'active-jwt'
        const pending = deferred<Response>()
        const api = new ApiClient('constructor-jwt', { getToken: () => currentToken })
        fetchMock.mockReturnValueOnce(pending.promise).mockResolvedValue(new Response('image'))
        const result = api.getGeneratedImageBlob('session', 'image')
        const rejected = expect(result).rejects.toMatchObject({ status: 401 })
        currentToken = null
        pending.resolve(new Response(null, { status: 304 }))
        await rejected
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('refreshes a live provider without replacing the ApiClient', async () => {
        let currentToken: string | null = 'active-jwt'
        const api = new ApiClient('constructor-jwt', {
            getToken: () => currentToken,
            onUnauthorized: async () => { currentToken = 'refreshed-jwt'; return currentToken },
        })
        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
            .mockResolvedValueOnce(new Response('{"sessions":[]}'))
        expect(await api.getSessions()).toEqual({ sessions: [] })
        expect(fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization')))
            .toEqual(['Bearer active-jwt', 'Bearer refreshed-jwt'])
    })

    it('makes an actual retained client inert after a same-hub account change and after unmount', async () => {
        const original: AuthSource = { type: 'accessToken', token: 'original-access' }
        const replacement: AuthSource = { type: 'accessToken', token: 'replacement-access' }
        fetchMock.mockImplementation(async (input, init) => {
            if (String(input).endsWith('/api/auth')) {
                const body = JSON.parse(String(init?.body)) as { accessToken: string }
                return new Response(JSON.stringify({ token: body.accessToken + '-jwt', user: { id: 1, firstName: 'Test' } }))
            }
            return new Response('{"sessions":[]}')
        })
        const { result, rerender, unmount } = renderHook(({ source }) => useAuth(source, 'https://hub.example'), {
            initialProps: { source: original },
            wrapper: StrictMode,
        })
        await waitFor(() => expect(result.current.api).not.toBeNull())
        const oldClient = result.current.api!
        rerender({ source: replacement })
        await waitFor(() => expect(result.current.token).toBe('replacement-access-jwt'))
        const currentClient = result.current.api!
        fetchMock.mockClear()
        await act(async () => { await expect(oldClient.getSessions()).rejects.toMatchObject({ status: 401 }) })
        expect(fetchMock).not.toHaveBeenCalled()
        unmount()
        await expect(currentClient.uploadFile('session', 'a.txt', 'YQ==', 'text/plain')).rejects.toMatchObject({ status: 401 })
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
