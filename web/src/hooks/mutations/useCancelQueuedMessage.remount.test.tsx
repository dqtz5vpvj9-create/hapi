import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { CancelMessageResponse } from '@hapi/protocol/schemas'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import {
    clearMessageWindow,
    getMessageWindowState,
    ingestIncomingMessages,
    syncTailMessages,
} from '@/lib/message-window-store'
import { useCancelQueuedMessage } from './useCancelQueuedMessage'

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({ haptic: { notification: vi.fn() } }),
}))

const sessionA = 'cancel-remount-A'
const sessionB = 'cancel-remount-B'

function message(id: string, seq: number): DecryptedMessage {
    return {
        id, localId: `local-${id}`, seq, createdAt: 1000 + seq, invokedAt: null,
        content: { role: 'user', content: { type: 'text', text: id } },
    } as DecryptedMessage
}

afterEach(() => {
    cleanup()
    clearMessageWindow(sessionA)
    clearMessageWindow(sessionB)
})

async function beginRemountedCancel() {
    let resolve!: (response: CancelMessageResponse) => void
    let reject!: (reason: Error) => void
    const response = new Promise<CancelMessageResponse>((done, fail) => {
        resolve = done
        reject = fail
    })
    const api = { cancelMessage: vi.fn(() => response) } as unknown as ApiClient
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const target = message('cancel-target', 1)
    const neighbor = message('other-queue', 2)
    const otherSession = message('other-session-queue', 1)
    ingestIncomingMessages(sessionA, [target, neighbor])
    ingestIncomingMessages(sessionB, [otherSession])
    const first = renderHook(() => useCancelQueuedMessage(api), { wrapper })
    let result!: Promise<CancelMessageResponse>
    act(() => {
        result = first.result.current.mutateAsync({
            sessionId: sessionA, messageId: target.id, localId: target.localId!, snapshot: target,
        })
    })
    // Observe the request starting and its optimistic deletion before leaving A.
    await waitFor(() => expect(api.cancelMessage).toHaveBeenCalledOnce())
    expect(getMessageWindowState(sessionA).messages.map(row => row.id)).toEqual([neighbor.id])
    first.unmount()
    renderHook(() => useCancelQueuedMessage(api), { wrapper })
    // A returned before the cancellation ACK. Its fresh GET still contained the
    // queued row; cancellation SSE is absent. Use the actual message store.
    act(() => ingestIncomingMessages(sessionA, [target, neighbor]))
    expect(getMessageWindowState(sessionA).messages.map(row => row.id)).toContain(target.id)
    return { api, target, neighbor, otherSession, result, resolve, reject }
}

describe('queued cancellation across a remount and refetch', () => {
    it('applies a successful ACK to a refetched row without removing other queues', async () => {
        const pending = await beginRemountedCancel()
        await act(async () => {
            pending.resolve({ status: 'cancelled', localId: pending.target.localId! })
            await pending.result
        })
        expect(getMessageWindowState(sessionA).messages.map(row => row.id)).toEqual([pending.neighbor.id])
        expect(getMessageWindowState(sessionB).messages).toEqual([pending.otherSession])
        expect(pending.api.cancelMessage).toHaveBeenCalledOnce()
    })

    it('does not resurrect a cancelled row when its earlier tail read arrives after the ACK', async () => {
        const pending = await beginRemountedCancel()
        let releaseRead!: () => void
        const heldRead = new Promise<void>(resolve => { releaseRead = resolve })
        const getMessages = vi.fn().mockImplementationOnce(async () => {
            await heldRead
            return {
                messages: [pending.target, pending.neighbor],
                page: {
                    direction: 'latest' as const, limit: 20, epoch: 1, reset: false, hasMore: false,
                    nextBeforeAt: 1001, nextBeforeSeq: 1, nextAfterAt: 1002, nextAfterSeq: 2,
                    snapshotHeadAt: 1002, snapshotHeadSeq: 2,
                },
            }
        })
        getMessages.mockResolvedValue({
            messages: [pending.neighbor],
            page: {
                direction: 'latest', limit: 20, epoch: 2, reset: true, hasMore: false,
                nextBeforeAt: 1002, nextBeforeSeq: 2, nextAfterAt: 1002, nextAfterSeq: 2,
                snapshotHeadAt: 1002, snapshotHeadSeq: 2,
            },
        })
        Object.assign(pending.api, { getMessages })
        const read = syncTailMessages(pending.api, sessionA)
        await waitFor(() => expect(getMessages).toHaveBeenCalledOnce())
        await act(async () => {
            pending.resolve({ status: 'cancelled', localId: pending.target.localId! })
            await pending.result
        })
        expect(getMessageWindowState(sessionA).messages.map(row => row.id)).not.toContain(pending.target.id)
        await act(async () => {
            releaseRead()
            await read
        })
        expect(getMessageWindowState(sessionA).messages.map(row => row.id)).toEqual([pending.neighbor.id])
        expect(getMessageWindowState(sessionB).messages).toEqual([pending.otherSession])
    })

    it('keeps the authoritative consumed row when the agent won the cancel race', async () => {
        const pending = await beginRemountedCancel()
        await act(async () => {
            pending.resolve({ status: 'invoked', message: { ...pending.target, invokedAt: 4000 } } as CancelMessageResponse)
            await pending.result
        })
        expect(getMessageWindowState(sessionA).messages.find(row => row.id === pending.target.id))
            .toMatchObject({ invokedAt: 4000, status: 'sent' })
        expect(getMessageWindowState(sessionA).messages.map(row => row.id)).toContain(pending.neighbor.id)
        expect(getMessageWindowState(sessionB).messages).toEqual([pending.otherSession])
    })

    it('retains the queued snapshot when the cancellation request fails', async () => {
        const pending = await beginRemountedCancel()
        const failed = pending.result.catch(error => error)
        await act(async () => {
            pending.reject(new Error('Synthetic offline failure'))
            await failed
        })
        expect(getMessageWindowState(sessionA).messages.find(row => row.id === pending.target.id))
            .toMatchObject({ localId: pending.target.localId, invokedAt: null })
        expect(getMessageWindowState(sessionA).messages.map(row => row.id)).toContain(pending.neighbor.id)
        expect(getMessageWindowState(sessionB).messages).toEqual([pending.otherSession])
    })
})
