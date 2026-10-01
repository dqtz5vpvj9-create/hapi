import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'

let store: typeof import('./message-window-store')
const session = 'public-unresolved-send'
const local = (id: string): DecryptedMessage => ({
    id, localId: id, seq: null, createdAt: 1000, invokedAt: null, scheduledAt: 9000,
    status: 'sending', originalText: 'PUBLIC UNSENT QUESTION '+id,
    content: { role: 'user', content: { type: 'text', text: 'PUBLIC UNSENT QUESTION '+id,
        attachments: [{ id: 'image', filename: 'image.png', path: '/uploads/image.png', size: 10, mimeType: 'image/png' }] },
    meta: { deliveryMode: 'queue' } },
})
const response = (messages: DecryptedMessage[]): MessagesResponse => ({ messages, page: {
    direction: 'latest', limit: 200, epoch: 1, reset: false, hasMore: false,
    nextBeforeAt: null, nextBeforeSeq: null, nextAfterAt: null, nextAfterSeq: null, snapshotHeadAt: null, snapshotHeadSeq: null,
} })
beforeEach(async () => {
    vi.useFakeTimers(); sessionStorage.clear(); vi.resetModules()
    store = await import('./message-window-store')
})
afterEach(() => { store.clearMessageWindow(session); vi.clearAllTimers(); vi.useRealTimers(); sessionStorage.clear() })
async function reload() {
    // The actual browser waited 400ms before page.goto. Complete the existing
    // throttled persistence before destroying this document's module state.
    await vi.runOnlyPendingTimersAsync()
    const saved = JSON.parse(sessionStorage.getItem(`hapi:message-reader:v1:${session}`) ?? '{"messages":[]}')
    expect(saved.messages).toEqual(store.getMessageWindowState(session).messages.filter(row => row.seq === null || row.invokedAt === null))
    vi.resetModules()
    store = await import('./message-window-store')
    return (await import('./queued-state-reconciliation')).reconcileQueuedStateAfterConnect
}

it('keeps an interrupted ordinary send recoverable across two document reloads and empty authoritative queue snapshots without resending', async () => {
    const payload = local('local-unresolved')
    store.appendOptimisticMessage(session, payload)
    let reconcile = await reload()
    const api = { getMessages: vi.fn(async () => response([])),
        getQueuedState: vi.fn(async () => ({ queuedLocalIds: [], invokedLocalMessages: [] })),
        sendMessage: vi.fn() } as unknown as ApiClient
    await reconcile(api, session)
    expect(store.getMessageWindowState(session).messages).toEqual([{ ...payload, status: 'failed' }])
    reconcile = await reload()
    await reconcile(api, session)
    expect(store.getMessageWindowState(session).messages).toEqual([{ ...payload, status: 'failed' }])
    expect(api.sendMessage).not.toHaveBeenCalled()
    store.removeOptimisticMessage(session, payload.localId!) // existing local Discard control
    await reload()
    expect(store.getMessageWindowState(session).messages).toEqual([])
})

it.each(['queued', 'invoked', 'indeterminate', 'echo', 'echo-invoked'] as const)('resolves interrupted local payload on authoritative %s evidence, then removes retired server-owned queues', async (acceptance) => {
    const payload = local('local-accepted')
    store.appendOptimisticMessage(session, payload)
    const reconcile = await reload()
    const server: DecryptedMessage = { ...payload, id: 'server-accepted', seq: 1, status: undefined,
        invokedAt: acceptance === 'invoked' || acceptance === 'echo-invoked' ? 2000 : null }
    const api = { getMessages: vi.fn(async () => response(acceptance.startsWith('echo') ? [server] : [])),
        getQueuedState: vi.fn(async () => ({ queuedLocalIds: acceptance === 'queued' || acceptance === 'echo' ? [payload.localId!] : [],
            invokedLocalMessages: acceptance === 'invoked' ? [{ localId: payload.localId!, invokedAt: 2000 }] : [],
            indeterminateLocalIds: acceptance === 'indeterminate' ? [payload.localId!] : [] })),
        sendMessage: vi.fn() } as unknown as ApiClient
    await reconcile(api, session)
    const row = store.getMessageWindowState(session).messages[0]!
    expect(row).toBeDefined()
    expect(row.status).not.toBe('failed')
    expect(row.invokedAt).toBe(acceptance === 'invoked' || acceptance === 'echo-invoked' ? 2000 : null)
    if (acceptance.startsWith('echo')) expect(row.id).toBe('server-accepted')
    if (acceptance === 'indeterminate') expect(row.deliveryState).toBe('indeterminate')
    expect(api.sendMessage).not.toHaveBeenCalled()
    // Accepted queued state may be retired; it is no longer an unresolved browser-only payload.
    if (acceptance !== 'invoked' && acceptance !== 'echo-invoked') {
        vi.mocked(api.getMessages).mockResolvedValue(response([]))
        vi.mocked(api.getQueuedState).mockResolvedValue({ queuedLocalIds: [], invokedLocalMessages: [] })
        await reconcile(api, session)
        expect(store.getMessageWindowState(session).messages).toEqual([])
    }
})

it('does not resurrect a native APP mirror absent from the authoritative queue', async () => {
    const native: DecryptedMessage = { ...local('external-app'), id: 'native:thread:turn:user', seq: 20, status: undefined }
    store.ingestIncomingMessages(session, [native])
    const reconcile = await reload()
    const api = { getMessages: vi.fn(async () => response([])),
        getQueuedState: vi.fn(async () => ({ queuedLocalIds: [], invokedLocalMessages: [] })) } as unknown as ApiClient
    await reconcile(api, session)
    expect(store.getMessageWindowState(session).messages).toEqual([])
})


it('continues retiring HTTP-accepted optimistic queues without requiring a tail echo', async () => {
    const payload = local('local-http-accepted')
    store.appendOptimisticMessage(session, payload)
    store.updateMessageStatus(session, payload.localId!, 'queued') // actual onSuccess boundary
    const reconcile = await reload()
    const api = { getMessages: vi.fn(async () => response([])),
        getQueuedState: vi.fn(async () => ({ queuedLocalIds: [], invokedLocalMessages: [] })) } as unknown as ApiClient
    await reconcile(api, session)
    expect(store.getMessageWindowState(session).messages).toEqual([])
})
