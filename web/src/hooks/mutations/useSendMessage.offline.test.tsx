import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { ApiClient } from '@/api/client'
import { useSendMessage } from './useSendMessage'
import { useCancelQueuedMessage } from './useCancelQueuedMessage'
import { computeCanCancel } from '@/components/AssistantChat/QueuedMessagesBar'
import { clearMessageWindow, getMessageWindowState, ingestIncomingMessages } from '@/lib/message-window-store'
import type { AttachmentDraftInput } from '@/lib/composer-attachment-drafts'
import type { AttachmentMetadata } from '@/types/api'

vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { notification: vi.fn() } }) }))

const sessionId = 'offline-send-regression'
const clients: QueryClient[] = []
function environment() {
    // Deliberately allow retries globally: send must override them itself.
    const client = new QueryClient({ defaultOptions: { mutations: { retry: 3, retryDelay: 0 } } })
    clients.push(client)
    function Wrapper({ children }: { children: ReactNode }) {
        return <QueryClientProvider client={client}>{children}</QueryClientProvider>
    }
    return { client, Wrapper }
}

beforeEach(() => {
    onlineManager.setOnline(true)
    clearMessageWindow(sessionId)
})
afterEach(() => {
    cleanup()
    for (const client of clients.splice(0)) client.clear()
    onlineManager.setOnline(true)
    vi.unstubAllGlobals()
    clearMessageWindow(sessionId)
})

const attachment: AttachmentMetadata = { id: 'picked-image', filename: 'photo.png', mimeType: 'image/png', size: 11, path: '/uploads/photo.png' }

describe('real TanStack offline send lifecycle', () => {
    it.each([false, true])('returns an offline send to editable draft, with attachments=%s, then never sends on reconnect', async (withAttachment) => {
        const { client, Wrapper } = environment()
        onlineManager.setOnline(false)
        const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
        vi.stubGlobal('fetch', fetch)
        const api = new ApiClient('')
        const file = new File(['image bytes'], 'photo.png', { type: 'image/png' })
        const files: AttachmentDraftInput[] = withAttachment ? [{ id: attachment.id, file, path: attachment.path }] : []
        const scheduledAt = Date.now() + 300_000
        const onError = vi.fn()
        const { result } = renderHook(() => {
            const [draft, setDraft] = useState({ text: 'offline question', files, scheduledAt: scheduledAt as number | null })
            const send = useSendMessage(api, sessionId, {
                onError: (info) => {
                    onError(info)
                    setDraft({ text: info.text, files: info.attachmentDrafts ?? [], scheduledAt: info.scheduledAt })
                },
            })
            return { ...send, draft, setDraft, submit: async () => {
                const accepted = await send.sendMessage(draft.text, withAttachment ? [attachment] : undefined, draft.scheduledAt, 'queue', draft.files)
                if (accepted) setDraft({ text: '', files: [], scheduledAt: null })
                return accepted
            } }
        }, { wrapper: Wrapper })
        await act(async () => { await result.current.submit() })
        await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
        expect(fetch).toHaveBeenCalledTimes(1)
        const mutation = client.getMutationCache().getAll()[0]!
        expect(mutation.state).toMatchObject({ status: 'error', isPaused: false, failureCount: 1 })
        expect(result.current.isSending).toBe(false)
        expect(getMessageWindowState(sessionId).messages).toHaveLength(0)
        expect(result.current.draft.text).toBe('offline question')
        expect(result.current.draft.scheduledAt).toBe(scheduledAt)
        if (withAttachment) {
            expect(result.current.draft.files[0]?.file).toBe(file)
            expect(result.current.draft.files[0]).toMatchObject({ id: attachment.id, path: attachment.path, uploadSessionId: sessionId })
        }
        act(() => result.current.setDraft({ ...result.current.draft, text: 'modified question' }))
        // User abandons the returned draft; no mutation or hidden outbox remains.
        act(() => result.current.setDraft({ text: '', files: [], scheduledAt: null }))
        await act(async () => { onlineManager.setOnline(true); await client.resumePausedMutations() })
        expect(fetch).toHaveBeenCalledTimes(1)
        expect(result.current.draft).toEqual({ text: '', files: [], scheduledAt: null })
        expect(mutation.state.status).toBe('error')
    })

    it('retries only on explicit send, with edited text, retained attachments and absolute schedule', async () => {
        const { Wrapper, client } = environment()
        onlineManager.setOnline(false)
        const fetch = vi.fn()
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValue(new Response('{}', { status: 200 }))
        vi.stubGlobal('fetch', fetch)
        const onError = vi.fn()
        const { result } = renderHook(() => useSendMessage(new ApiClient(''), sessionId, { onError }), { wrapper: Wrapper })
        const file = new File(['image bytes'], 'photo.png', { type: 'image/png' })
        const scheduledAt = Date.now() + 300_000
        await act(async () => { await result.current.sendMessage('original', [attachment], scheduledAt, 'queue', [{ id: attachment.id, file }]) })
        await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
        const recovered = onError.mock.calls[0]![0]
        await act(async () => { onlineManager.setOnline(true); await client.resumePausedMutations() })
        expect(fetch).toHaveBeenCalledTimes(1)
        await act(async () => { await result.current.sendMessage('edited', [attachment], recovered.scheduledAt, 'queue', recovered.attachmentDrafts) })
        await waitFor(() => expect(result.current.sendSettlement?.status).toBe('success'))
        expect(fetch).toHaveBeenCalledTimes(2)
        const request = fetch.mock.calls[1]![1] as RequestInit
        expect(JSON.parse(request.body as string)).toMatchObject({ text: 'edited', attachments: [attachment], scheduledAt, deliveryMode: 'queue' })
    })

    it('supports discarding a terminal legacy attachment failure without issuing DELETE or reconnect send', async () => {
        const { Wrapper, client } = environment()
        onlineManager.setOnline(false)
        const fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') })
        vi.stubGlobal('fetch', fetch)
        const { result } = renderHook(() => useSendMessage(new ApiClient(''), sessionId), { wrapper: Wrapper })
        await act(async () => { await result.current.sendMessage('legacy attachment', [attachment]) })
        await waitFor(() => expect(result.current.sendSettlement?.status).toBe('error'))
        const row = getMessageWindowState(sessionId).messages[0]!
        expect(row.status).toBe('failed')
        act(() => { expect(result.current.discardFailedMessage(row.localId!)).toBe(true) })
        expect(getMessageWindowState(sessionId).messages).toHaveLength(0)
        await act(async () => { onlineManager.setOnline(true); await client.resumePausedMutations() })
        expect(fetch).toHaveBeenCalledTimes(1)
    })

    it.each(['missing', 'empty', 'partial', 'wrong-id'])('keeps all attachment references when the File snapshot is %s', async (kind) => {
        const { Wrapper } = environment()
        onlineManager.setOnline(false)
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
        const onError = vi.fn()
        const { result } = renderHook(() => useSendMessage(new ApiClient(''), sessionId, { onError }), { wrapper: Wrapper })
        const file = new File(['image bytes'], 'photo.png', { type: 'image/png' })
        const second = { ...attachment, id: 'second', filename: 'second.png' }
        const snapshots = kind === 'missing' ? undefined : kind === 'empty' ? [] : [{ id: kind === 'wrong-id' ? 'unknown' : attachment.id, file }]
        await act(async () => { await result.current.sendMessage('both images', [attachment, second], null, 'queue', snapshots) })
        await waitFor(() => expect(result.current.sendSettlement?.status).toBe('error'))
        expect(onError).not.toHaveBeenCalled()
        const row = getMessageWindowState(sessionId).messages[0]!
        expect(row.status).toBe('failed')
        expect(row.content).toMatchObject({ content: { attachments: [attachment, second] } })
    })

    it('keeps the server-echo gate and authoritative cancel/edit race handling for a normal online send', async () => {
        const { Wrapper } = environment()
        const fetch = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify(
            init.method === 'DELETE' ? { status: 'cancelled', localId: 'server-local' } : {},
        ), { status: 200 }))
        vi.stubGlobal('fetch', fetch)
        const api = new ApiClient('')
        const { result } = renderHook(() => ({
            send: useSendMessage(api, sessionId, { isSessionThinking: true }), cancel: useCancelQueuedMessage(api),
        }), { wrapper: Wrapper })
        await act(async () => { await result.current.send.sendMessage('queued on server') })
        await waitFor(() => expect(result.current.send.sendSettlement?.status).toBe('success'))
        const optimistic = getMessageWindowState(sessionId).messages[0]!
        expect(computeCanCancel({ id: optimistic.id, localId: optimistic.localId, isPending: false })).toBe(false)
        expect(result.current.send.discardFailedMessage(optimistic.localId!)).toBe(false)
        const echoed = { ...optimistic, id: 'server-row', seq: 1, status: 'queued' as const }
        ingestIncomingMessages(sessionId, [echoed])
        expect(computeCanCancel({ id: echoed.id, localId: echoed.localId, isPending: false })).toBe(true)
        await act(async () => { await result.current.cancel.mutateAsync({ sessionId, messageId: echoed.id, localId: echoed.localId!, snapshot: echoed }) })
        expect(getMessageWindowState(sessionId).messages).toHaveLength(0)
        expect(fetch.mock.calls[1]![1].method).toBe('DELETE')
    })
})


it('retains a failed send after its composer route unmounts, then offers explicit retry or discard without automatic resend', async () => {
    const { client, Wrapper } = environment()
    let reject!: (error: Error) => void
    const sendMessage = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const api = { sendMessage } as unknown as ApiClient
    const onError = vi.fn()
    const old = renderHook(() => useSendMessage(api, sessionId, { onError }), { wrapper: Wrapper })
    const scheduledAt = Date.now() + 300000
    await act(async () => { await old.result.current.sendMessage('PUBLIC LEAVE BEFORE FAILURE', undefined, scheduledAt) })
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    const localId = getMessageWindowState(sessionId).messages[0]!.localId!
    old.unmount()
    await act(async () => { reject(new TypeError('Failed to fetch')) })
    await waitFor(() => expect(client.getMutationCache().getAll()[0]?.state.status).toBe('error'))
    expect(onError).not.toHaveBeenCalled()
    expect(getMessageWindowState(sessionId).messages[0]).toMatchObject({ localId, status: 'failed', originalText: 'PUBLIC LEAVE BEFORE FAILURE', scheduledAt })
    const fresh = renderHook(() => useSendMessage(api, sessionId, { onError }), { wrapper: Wrapper })
    onlineManager.setOnline(false); onlineManager.setOnline(true)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    await act(async () => { expect(fresh.result.current.retryMessage(localId)).toBe(true) })
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))
    expect(sendMessage.mock.calls[1]).toEqual([sessionId, 'PUBLIC LEAVE BEFORE FAILURE', localId, undefined, scheduledAt, 'queue'])
    fresh.unmount()
    await act(async () => { reject(new TypeError('Failed to fetch')) })
    const last = renderHook(() => useSendMessage(api, sessionId), { wrapper: Wrapper })
    await waitFor(() => expect(getMessageWindowState(sessionId).messages[0]?.status).toBe('failed'))
    act(() => { expect(last.result.current.discardFailedMessage(localId)).toBe(true) })
    expect(getMessageWindowState(sessionId).messages).toEqual([])
    expect(sendMessage).toHaveBeenCalledTimes(2)
})


it.each([null, 2000])('keeps an authoritative echo when the send response later fails (invokedAt=%s)', async (invokedAt) => {
    const { Wrapper } = environment()
    let reject!: (error: Error) => void
    const sendMessage = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const api = { sendMessage } as unknown as ApiClient
    const onError = vi.fn()
    const current = renderHook(() => useSendMessage(api, sessionId, { onError }), { wrapper: Wrapper })
    await act(async () => { await current.result.current.sendMessage('PUBLIC SERVER ACCEPTED') })
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    const original = getMessageWindowState(sessionId).messages[0]!
    act(() => { ingestIncomingMessages(sessionId, [{ ...original, id: 'server-echo', seq: 20, invokedAt, status: undefined }]) })
    await act(async () => { reject(new TypeError('Lost send response')) })
    await waitFor(() => expect(current.result.current.sendSettlement?.status).toBe('error'))
    expect(onError).not.toHaveBeenCalled()
    expect(getMessageWindowState(sessionId).messages).toHaveLength(1)
    expect(getMessageWindowState(sessionId).messages[0]).toMatchObject({ id: 'server-echo', invokedAt })
    expect(getMessageWindowState(sessionId).messages[0]?.status).not.toBe('failed')
    act(() => {
        expect(current.result.current.discardFailedMessage(original.localId!)).toBe(false)
        expect(current.result.current.retryMessage(original.localId!)).toBe(false)
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
})
