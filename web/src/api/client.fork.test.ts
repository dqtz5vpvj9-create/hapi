import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './client'

const nativeBoundary = { threadId: 'native-thread', turnId: 'native-turn', itemId: 'native-input' }
const fetchMock = vi.fn()

function observeRequestError(api: ApiClient) {
    const target = api as unknown as { request: (path: string, init?: RequestInit) => Promise<unknown> }
    const request = target.request.bind(api)
    let originalError: unknown
    vi.spyOn(target, 'request').mockImplementation(async (...args) => {
        try {
            return await request(...args)
        } catch (error) {
            originalError = error
            throw error
        }
    })
    return () => originalError
}

describe('ApiClient fork responses', () => {
    beforeEach(() => {
        fetchMock.mockReset()
        vi.stubGlobal('fetch', fetchMock)
    })
    afterEach(() => {
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    it.each([
        { name: 'current', boundary: undefined, payload: {} },
        { name: 'managed', boundary: 'message-local', payload: { messageLocalId: 'message-local' } },
        { name: 'native', boundary: nativeBoundary, payload: { nativeBoundary } },
    ])('preserves the $name identity payload and response', async ({ boundary, payload }) => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ sessionId: 'created-child' }), { status: 200 }))
        await expect(new ApiClient('token').forkConversation('source /?', boundary)).resolves.toEqual({ sessionId: 'created-child' })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/source%20%2F%3F/fork')
        expect(fetchMock.mock.calls[0][1].method).toBe('POST')
        expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify(payload))
    })

    it('extracts the human error message while preserving status, code and the exact response body', async () => {
        const body = '{ "error": "Native boundary rejected by the source thread", "code": "invalid_native_boundary", "detail": { "itemId": "native-input" } }'
        fetchMock.mockResolvedValueOnce(new Response(body, { status: 409, statusText: 'Conflict' }))
        const api = new ApiClient('token')
        const originalError = observeRequestError(api)
        const error = await api.forkConversation('source', nativeBoundary).catch(error => error)

        expect(error).toBeInstanceOf(ApiError)
        expect(error).not.toBe(originalError())
        expect(error.message).toBe('Native boundary rejected by the source thread')
        expect(error.status).toBe(409)
        expect(error.code).toBe('invalid_native_boundary')
        expect(error.body).toBe(body)
        expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify({ nativeBoundary }))
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it.each([
        '', 'not-json', '{}', 'null', '[]',
        '{"error":null,"code":"invalid_boundary"}',
        '{"error":42,"code":"invalid_boundary"}',
        '{"error":{"message":"Rejected"},"code":"invalid_boundary"}',
        '{"error":"","code":"invalid_boundary"}',
        '{"error":"   ","code":"invalid_boundary"}',
    ])('rethrows the original HTTP error for an unusable error body: %s', async body => {
        fetchMock.mockResolvedValueOnce(new Response(body, { status: 409, statusText: 'Conflict' }))
        const api = new ApiClient('token')
        const originalError = observeRequestError(api)
        const error = await api.forkConversation('source', nativeBoundary).catch(error => error)

        expect(error).toBe(originalError())
        expect(error).toBeInstanceOf(ApiError)
        expect(error.message).toBe(`HTTP 409 Conflict: ${body}`)
        expect(error.status).toBe(409)
        expect(error.body).toBe(body || undefined)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('rethrows the original network error without retrying', async () => {
        const error = new TypeError('Failed to fetch')
        fetchMock.mockRejectedValueOnce(error)
        await expect(new ApiClient('token').forkConversation('source', nativeBoundary)).rejects.toBe(error)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
})

describe('tracked fork API', () => {
    const id = '00000000-0000-4000-8000-000000000001'
    const operation = { operationId: id, sourceSessionId: 'source', childSessionId: 'child', sourceRevision: 1,
        status: 'indeterminate', message: 'Unconfirmed', updatedAt: 1 }
    beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

    it.each([undefined, 'managed-boundary', nativeBoundary])('posts the captured operation and revision once (%j)', async boundary => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ operation }), { status: 202 }))
        await expect(new ApiClient('token').startForkOperation('source', id, 0, boundary)).resolves.toEqual({ operation })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ operationId: id, expectedForkRevision: 0,
            ...(boundary === undefined ? {} : typeof boundary === 'string' ? { messageLocalId: boundary } : { nativeBoundary: boundary }) })
        expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    })

    it('never replays a tracked mutation after 401, even with auth refresh available', async () => {
        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
        const refresh = vi.fn(async () => 'new-token')
        await expect(new ApiClient('token', { onUnauthorized: refresh }).startForkOperation('source', id, 0)).rejects.toMatchObject({ status: 401 })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(refresh).not.toHaveBeenCalled()
    })

    it('uses exact encoded read and binding recovery routes', async () => {
        fetchMock.mockImplementation(async () => new Response(JSON.stringify({ operation }), { status: 200 }))
        const api = new ApiClient('token')
        await api.getForkOperation('source /', id)
        await api.reconcileForkOperation('source /', id)
        expect(fetchMock.mock.calls.map(call => [call[0], call[1].method ?? 'GET'])).toEqual([
            [`/api/sessions/source%20%2F/fork-operations/${id}`, 'GET'],
            [`/api/sessions/source%20%2F/fork-operations/${id}/reconcile`, 'POST'],
        ])
    })

    it('preserves the human conflict text, code and receipt body', async () => {
        const body = JSON.stringify({ error: 'Source already forked', code: 'fork_revision_conflict', revision: 1, operation })
        fetchMock.mockResolvedValueOnce(new Response(body, { status: 409 }))
        await expect(new ApiClient('token').startForkOperation('source', id, 0)).rejects.toMatchObject({
            message: 'Source already forked', status: 409, code: 'fork_revision_conflict', body,
        })
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('scopes persistence to page origin, Hub origin, namespace and authenticated user without storing tokens', () => {
        const token = (ns: string, uid: number) => `header.${btoa(JSON.stringify({ ns, uid }))}.secret`
        const api = new ApiClient(token('one', 1), { baseUrl: 'https://hub.example' })
        expect(api.getForkOperationScope()).toContain('hub.example')
        expect(api.getForkOperationScope()).not.toContain('secret')
        expect(api.getForkOperationScope()).not.toBe(new ApiClient(token('two', 1), { baseUrl: 'https://hub.example' }).getForkOperationScope())
        expect(api.getForkOperationScope()).not.toBe(new ApiClient(token('one', 2), { baseUrl: 'https://hub.example' }).getForkOperationScope())
        expect(api.getForkOperationScope()).not.toBe(new ApiClient(token('one', 1), { baseUrl: 'https://other.example' }).getForkOperationScope())
        expect(new ApiClient('invalid').getForkOperationScope()).toBeNull()
        expect(new ApiClient(token('one', 1), { getToken: () => null }).getForkOperationScope()).toBeNull()
    })
    it('partitions configured Hub paths and normalizes trailing slash, query and hash without retaining URL credentials', () => {
        const token = `header.${btoa(JSON.stringify({ ns: 'one', uid: 1 }))}.secret`
        const scope = (baseUrl: string) => new ApiClient(token, { baseUrl }).getForkOperationScope()
        expect(scope('https://hub.example/first')).not.toBe(scope('https://hub.example/second'))
        expect(scope('https://hub.example/first/?q=1#section')).toBe(scope('https://hub.example/first'))
        expect(scope('https://user:password@hub.example/first')).toBe(scope('https://hub.example/first'))
    })

    it('sends only the captured risk identity and revision, with no current or historical selector', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ operation }), { status: 202 }))
        const api = new ApiClient('token')
        await api.startForkOperation('source', id, 3, undefined, '00000000-0000-4000-8000-000000000002')
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ operationId: id, expectedForkRevision: 3,
            duplicateRiskOf: '00000000-0000-4000-8000-000000000002' })
        await expect(api.startForkOperation('source', id, 3, nativeBoundary, '00000000-0000-4000-8000-000000000002'))
            .rejects.toThrow('preserve the original server-side boundary')
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('closes only the exact encoded operation with captured revision and preserves authoritative source state', async () => {
        const result = { operation: { ...operation, status: 'rejected', rejectionProof: 'not_dispatched', code: 'fork_closed_unadmitted' },
            sourceState: { revision: 3, operation: { ...operation, operationId: '00000000-0000-4000-8000-000000000002' } },
            closure: 'closed', message: 'Closed before admission' }
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }))
        await expect(new ApiClient('token').closeUnadmittedForkOperation('source /?', id, 2)).resolves.toEqual(result)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock.mock.calls[0][0]).toBe(`/api/sessions/source%20%2F%3F/fork-operations/${id}/close-unadmitted`)
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify({ expectedForkRevision: 2 }) })
        expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    })
    it('never auth-refreshes or replays a close mutation after 401', async () => {
        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
        const refresh = vi.fn(async () => 'new-token')
        await expect(new ApiClient('token', { onUnauthorized: refresh }).closeUnadmittedForkOperation('source', id, 2))
            .rejects.toMatchObject({ status: 401 })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(refresh).not.toHaveBeenCalled()
    })
    it.each(['missing-state', 'false-proof', 'extra-field'])('rejects malformed close success (%s)', async kind => {
        const result = { operation, sourceState: { revision: 2, operation }, closure: 'already_admitted' } as Record<string, unknown>
        if (kind === 'missing-state') delete result.sourceState
        if (kind === 'false-proof') result.closure = 'closed'
        if (kind === 'extra-field') result.sessionId = 'unexpected-child'
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(result), { status: 200 }))
        await expect(new ApiClient('token').closeUnadmittedForkOperation('source', id, 2)).rejects.toThrow()
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
    it('preserves human source-identity conflict details without retrying close', async () => {
        const body = JSON.stringify({ error: 'Original native store is unavailable', code: 'source_identity_changed' })
        fetchMock.mockResolvedValueOnce(new Response(body, { status: 409 }))
        await expect(new ApiClient('token').closeUnadmittedForkOperation('source', id, 2)).rejects.toMatchObject({
            message: 'Original native store is unavailable', status: 409, code: 'source_identity_changed', body,
        })
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

})
