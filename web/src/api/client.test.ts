import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError } from './client'

describe('ApiClient error mapping', () => {
    let originalFetch: typeof globalThis.fetch
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        originalFetch = globalThis.fetch
        fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it('reads only requested PDF bytes and refreshes authentication for later pages', async () => {
        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
            .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 206 }))
        const api = new ApiClient('old-token', { onUnauthorized: async () => 'new-token' })
        expect(await api.readDocumentPreviewRange('session', 'preview', 5, 8, new AbortController().signal)).toEqual(new Uint8Array([1, 2, 3]))
        expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ Range: 'bytes=5-7', authorization: 'Bearer old-token' })
        expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ Range: 'bytes=5-7', authorization: 'Bearer new-token' })
    })

    it('surfaces expired and truncated ranges instead of leaving PDF.js waiting indefinitely', async () => {
        const api = new ApiClient('token')
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Preview expired' }), { status: 410 }))
        await expect(api.readDocumentPreviewRange('session', 'preview', 0, 8, new AbortController().signal)).rejects.toThrow('Preview expired')
        fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 206 }))
        await expect(api.readDocumentPreviewRange('session', 'preview', 0, 8, new AbortController().signal)).rejects.toThrow('incomplete')
    })

    it('reads multibyte streamed messages and reports decoded bytes without a compressed denominator', async () => {
        const value = { messages: [{ text: '消息 🚆' }] }
        const bytes = new TextEncoder().encode(JSON.stringify(value))
        const stream = new ReadableStream({ start(controller) {
            controller.enqueue(bytes.slice(0, 26))
            controller.enqueue(bytes.slice(26, 29))
            controller.enqueue(bytes.slice(29))
            controller.close()
        } })
        fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-length': '12', 'content-encoding': 'gzip' } }))
        const progress: Array<{ receivedBytes: number; totalBytes: number | null }> = []
        const result = await new ApiClient('test-token').getMessages('session', {}, undefined, p => progress.push(p))
        expect(result).toEqual(value)
        expect(progress.at(-1)?.receivedBytes).toBe(bytes.byteLength)
        expect(progress.every(p => p.totalBytes === null)).toBe(true)
        expect(progress).toHaveLength(4)
    })

    it('prefers the stable `code` field over the human-readable `error` message in ApiError.code', async () => {
        // Match the shape /sessions/:id/reopen actually returns on a 503.
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({ error: 'No machine online', code: 'no_machine_online' }),
                { status: 503, statusText: 'Service Unavailable' }
            )
        )

        const api = new ApiClient('test-token')
        try {
            await api.reopenSession('session-X')
            expect.unreachable('expected reopenSession to throw')
        } catch (error) {
            expect(error).toBeInstanceOf(ApiError)
            const apiError = error as ApiError
            expect(apiError.status).toBe(503)
            // The stable taxonomy must survive into ApiError.code so callers can
            // branch on `no_machine_online` rather than parsing the message text.
            expect(apiError.code).toBe('no_machine_online')
            expect(apiError.body).toContain('no_machine_online')
        }
    })

    it('falls back to `parsed.error` when `code` is absent (legacy route shape)', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({ error: 'something broke' }),
                { status: 500, statusText: 'Internal Server Error' }
            )
        )

        const api = new ApiClient('test-token')
        try {
            await api.reopenSession('session-Y')
            expect.unreachable('expected reopenSession to throw')
        } catch (error) {
            expect(error).toBeInstanceOf(ApiError)
            expect((error as ApiError).code).toBe('something broke')
        }
    })

    it('preserves the structured ambiguous-boundary code for Rewind fallbacks', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    error: 'Rewind is unavailable for this Codex history',
                    code: 'ambiguous_native_boundary_fork_safe',
                    hydrateFailed: false
                }),
                { status: 409, statusText: 'Conflict' }
            )
        )

        const api = new ApiClient('test-token')
        await expect(api.rewindConversation('session-1', 'local-1')).rejects.toMatchObject({
            status: 409,
            code: 'ambiguous_native_boundary_fork_safe'
        })
    })

    it('passes the 422 missing-metadata body through unchanged so the UI can show the missing fields', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    error: 'Cursor session id is missing from metadata; reopen requires the original cursor chat id',
                    missing: ['cursorSessionId']
                }),
                { status: 422, statusText: 'Unprocessable Entity' }
            )
        )

        const api = new ApiClient('test-token')
        try {
            await api.reopenSession('session-Z')
            expect.unreachable('expected reopenSession to throw')
        } catch (error) {
            expect(error).toBeInstanceOf(ApiError)
            const apiError = error as ApiError
            expect(apiError.status).toBe(422)
            expect(apiError.body).toContain('cursorSessionId')
        }
    })

    it('returns export warnings and sends explicit confirmation for large exports', async () => {
        const warning = {
            type: 'warning',
            count: 20_001,
            limit: 20_000,
            estimatedBytes: 12_345_678
        }
        const payload = {
            schemaVersion: 2,
            exportedAt: 1_762_000_000_000,
            session: { id: 'session-1' },
            messages: [],
            scratchlist: []
        }
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify(warning), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }))

        const api = new ApiClient('test-token')
        await expect(api.getSessionExport('session-1')).resolves.toEqual(warning)
        await expect(api.getSessionExport('session-1', { force: true })).resolves.toEqual(payload)

        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessions/session-1/export')
        expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/sessions/session-1/export?force=true')
    })

    it('loads the Cursor chat store status for the selected session', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ onDisk: false, store: null }), { status: 200 })
        )

        const api = new ApiClient('test-token')
        await expect(api.getCursorChatStoreStatus('session cursor')).resolves.toEqual({
            onDisk: false,
            store: null
        })
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessions/session%20cursor/cursor-chat-store')
    })

    it('generates a title and saves the summary through separate session endpoints', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ title: 'Generated title' }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

        const api = new ApiClient('test-token')
        await expect(api.suggestSessionTitle('session /?#')).resolves.toEqual({ title: 'Generated title' })
        await api.updateSessionSummary('session /?#', 'Generated title')

        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessions/session%20%2F%3F%23/title-suggestion')
        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
        expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/sessions/session%20%2F%3F%23/summary')
        expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
            method: 'PATCH',
            body: JSON.stringify({ text: 'Generated title' })
        })
    })

    it('reads the Hub title suggestion capability', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
            status: 'ok',
            protocolVersion: 1,
            capabilities: { titleSuggestion: true }
        }), { status: 200 }))

        const api = new ApiClient('test-token')
        await expect(api.getHealth()).resolves.toEqual({
            status: 'ok',
            protocolVersion: 1,
            capabilities: { titleSuggestion: true }
        })
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/health')
    })

    it('asks the machine to re-probe agy only when the caller forces a refresh', async () => {
        fetchMock.mockImplementation(() => Promise.resolve(
            new Response(JSON.stringify({ success: true, availableModels: [] }), { status: 200 })
        ))

        const api = new ApiClient('test-token')
        await api.getMachineAgyModels('machine-1')
        await api.getMachineAgyModels('machine-1', { refresh: true })

        expect(fetchMock.mock.calls[0][0]).toContain('/api/machines/machine-1/agy-models')
        expect(fetchMock.mock.calls[0][0]).not.toContain('refresh')
        expect(fetchMock.mock.calls[1][0]).toContain('/api/machines/machine-1/agy-models?refresh=true')
    })

    it('lists and imports Pi sessions through the selected machine', async () => {
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, sessions: [], machineId: 'machine-1' }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, results: [], machineId: 'machine-1' }), { status: 200 }))
        const api = new ApiClient('test-token')

        await api.getPiSessions('/tmp/project', 'machine-1')
        await api.importPiSessions({ sessionIds: ['pi-1'], cwd: '/tmp/project', machineId: 'machine-1' })

        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/pi/sessions?cwd=%2Ftmp%2Fproject&machineId=machine-1')
        expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/pi/import-sessions')
        expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
            method: 'POST',
            body: JSON.stringify({ sessionIds: ['pi-1'], cwd: '/tmp/project', machineId: 'machine-1' })
        })
    })

    it('loads the authoritative queued state for encoded session IDs', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({
                queuedLocalIds: ['local-2'],
                invokedLocalMessages: [{ localId: 'local-3', invokedAt: 1_000 }]
            }), { status: 200 })
        )

        const api = new ApiClient('test-token')
        await expect(api.getQueuedState('session /?#', ['local-1', 'local-2'])).resolves.toEqual({
            queuedLocalIds: ['local-2'],
            invokedLocalMessages: [{ localId: 'local-3', invokedAt: 1_000 }]
        })

        const [url, init] = fetchMock.mock.calls[0] ?? []
        expect(url).toBe('/api/sessions/session%20%2F%3F%23/messages/queued-state')
        expect(init).toMatchObject({
            method: 'POST',
            body: JSON.stringify({ localIds: ['local-1', 'local-2'] })
        })
        expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
    })

    it('forwards the selected delivery mode when sending a message', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))

        const api = new ApiClient('test-token')
        await api.sendMessage('session /?#', 'steer this', 'local-1', undefined, null, 'steer')

        const [url, init] = fetchMock.mock.calls[0] ?? []
        expect(url).toBe('/api/sessions/session%20%2F%3F%23/messages')
        expect(init).toMatchObject({
            method: 'POST',
            body: JSON.stringify({
                text: 'steer this',
                localId: 'local-1',
                deliveryMode: 'steer',
            })
        })
    })

    it('posts a steer for a queued message', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ status: 'steered', localId: 'local-1' }), { status: 200 })
        )

        const api = new ApiClient('test-token')
        await expect(api.steerMessage('session /?#', 'msg-1')).resolves.toEqual({
            status: 'steered',
            localId: 'local-1',
        })

        const [url, init] = fetchMock.mock.calls[0] ?? []
        expect(url).toBe('/api/sessions/session%20%2F%3F%23/messages/msg-1/steer')
        expect(init).toMatchObject({ method: 'POST' })
    })

    it('requests usage buckets in the viewer IANA time zone', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))

        const api = new ApiClient('test-token')
        await api.getUsageSummary('7d', 'America/New_York')

        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            '/api/usage/summary?range=7d&timeZone=America%2FNew_York'
        )
    })

    it('lets fetch set the multipart boundary for transcription uploads', async () => {
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ text: 'hello' }), { status: 200 }))

        const api = new ApiClient('test-token')
        const file = new File(['audio'], 'speech.webm', { type: 'audio/webm' })
        await api.transcribeVoice({ file, provider: 'openai', mode: 'standard' })

        const [, init] = fetchMock.mock.calls[0] ?? []
        expect(init?.body).toBeInstanceOf(FormData)
        expect(new Headers(init?.headers).has('content-type')).toBe(false)
    })

    it('preserves an unavailable voice backend response', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ backend: null, backends: [] }), { status: 200 })
        )

        const api = new ApiClient('test-token')
        await expect(api.fetchVoiceBackend()).resolves.toEqual({ backend: null, backends: [] })
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/voice/backend')
    })

    it('reads and updates masked transcription credentials', async () => {
        const status = {
            openai: { configured: true, source: 'settings', hint: '••••cret', editable: true },
            elevenlabs: { configured: false, source: 'none', hint: null, editable: true },
            deepgram: { configured: false, source: 'none', hint: null, editable: true },
            groq: { configured: false, source: 'none', hint: null, editable: true },
            openaiCompatible: {
                configured: false,
                source: 'none',
                baseUrl: null,
                model: null,
                baseUrlEditable: true,
                modelEditable: true,
                apiKey: { configured: false, source: 'none', hint: null, editable: true },
            },
            voiceBackends: {
                elevenlabs: { configured: false, source: 'none', hint: null, editable: true },
                geminiLive: { configured: false, source: 'none', hint: null, editable: true },
                qwenRealtime: { configured: false, source: 'none', hint: null, editable: true },
            },
        }
        fetchMock
            .mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 200 }))

        const api = new ApiClient('test-token')
        await expect(api.fetchTranscriptionCredentials()).resolves.toEqual(status)
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/voice/transcription/credentials')

        await expect(api.updateTranscriptionCredentials({ openai: 'sk-test' })).resolves.toEqual(status)
        const [, init] = fetchMock.mock.calls[1] ?? []
        expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/voice/transcription/credentials')
        expect(init?.method).toBe('PUT')
        expect(init?.body).toBe(JSON.stringify({ openai: 'sk-test' }))
    })
})

describe('ApiClient Kimi session model discovery', () => {
    let originalFetch: typeof globalThis.fetch
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        originalFetch = globalThis.fetch
        fetchMock = vi.fn()
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    })

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it('requests the running session instead of the machine kimi-models endpoint', async () => {
        const catalog = {
            success: true,
            availableModels: [
                { modelId: 'GLM-5.3-flash', name: 'thehive / GLM-5.3-flash', provider: 'thehive' }
            ],
            currentModelId: 'GLM-5.3-flash'
        }
        fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(catalog), { status: 200 }))

        const api = new ApiClient('test-token')
        await expect(api.getSessionKimiModels('session/1')).resolves.toEqual(catalog)
        expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/sessions/session%2F1/kimi-models')
    })
})

describe('bounded authentication and reads', () => {
    it('supplies a timeout signal for login without replaying the request', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ token: 'fixture', user: { id: 1 } })))
        try {
            await new ApiClient('').authenticate({ accessToken: 'fixture-only' })
            expect(fetch).toHaveBeenCalledTimes(1)
            expect(fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
        } finally { fetch.mockRestore() }
    })
    it('explicitly opts into offline devices while preserving the normal machine endpoint', async () => {
        const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ machines: [] })))
        try {
            const api = new ApiClient('fixture-only')
            await api.getMachines()
            await api.getMachines(true)
            expect(String(fetch.mock.calls[0][0])).toContain('/api/machines')
            expect(String(fetch.mock.calls[1][0])).toContain('/api/machines?includeOffline=true')
        } finally { fetch.mockRestore() }
    })
})
