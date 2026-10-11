import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { appendOptimisticMessage, clearMessageWindow, getMessageWindowState, invalidateMessageWindow, releaseMessageWindow,
    seedMessageWindowFromSession, removeOptimisticMessage, markMessagesConsumed, markMessagesDispatching,
    markMessagesIndeterminate, markMessagesRequeued } from './message-window-store'
import { getHistoryPageRepository } from './history-page-repository'
import { reconcileQueuedStateAfterConnect } from './queued-state-reconciliation'
import { cancelQueuedStateRequestsForApi } from './queued-state-request-lifetime'

const row: DecryptedMessage = { id: 'local', localId: 'local', seq: null, createdAt: 1000, invokedAt: null,
    status: 'queued', scheduledAt: null, content: { role: 'user', content: { type: 'text', text: 'Keep this' } } }
const empty: MessagesResponse = { messages: [], page: { direction: 'latest', limit: 20, epoch: 1, reset: false, hasMore: false,
    nextBeforeAt: null, nextBeforeSeq: null, nextAfterAt: null, nextAfterSeq: null, snapshotHeadAt: null, snapshotHeadSeq: null } }
const queued = { queuedLocalIds: ['local'], invokedLocalMessages: [] }
const consumed = { queuedLocalIds: [], invokedLocalMessages: [{ localId: 'local', invokedAt: 1200 }] }
const ids = new Set<string>(), apis = new Set<ApiClient>()
const requests: Array<{ signal?: AbortSignal; resolve: (response: Response) => void; reject: (error: Error) => void }> = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
async function flush() { for (let index = 0; index < 80; index++) await Promise.resolve() }
function fixture(id: string, initial = row, options?: ConstructorParameters<typeof ApiClient>[1]) {
    ids.add(id); appendOptimisticMessage(id, initial)
    const api = new ApiClient('old-token', options); apis.add(api); return api
}
function track(pending: Promise<void>) {
    const result: { settled: boolean; error?: unknown } = { settled: false }
    void pending.then(() => { result.settled = true }, error => { result.settled = true; result.error = error })
    return result
}
beforeEach(() => {
    vi.useFakeTimers(); requests.length = 0
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
        if (!url.endsWith('/queued-state')) return Promise.resolve(json(empty))
        // Ignore abort deliberately, covering transports/auth waits that settle late.
        return new Promise<Response>((resolve, reject) => requests.push({ signal: init?.signal ?? undefined, resolve, reject }))
    }))
})
afterEach(async () => {
    ids.forEach(clearMessageWindow); ids.clear()
    apis.forEach(api => { cancelQueuedStateRequestsForApi(api); getHistoryPageRepository(api).invalidate() }); apis.clear()
    await flush(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); sessionStorage.clear()
})

describe('bounded reconnect ownership', () => {
    it('times out a hung POST without removing rows and permits a later retry', async () => {
        const api = fixture('timeout'), old = track(reconcileQueuedStateAfterConnect(api, 'timeout')); await flush()
        await vi.advanceTimersByTimeAsync(30_000)
        expect(old).toMatchObject({ settled: true, error: { name: 'TimeoutError' } })
        expect(requests[0].signal?.aborted).toBe(true)
        expect(getMessageWindowState('timeout').messages).toEqual([row])
        const next = track(reconcileQueuedStateAfterConnect(api, 'timeout')); await flush()
        requests[1].resolve(json(queued)); await flush(); expect(next).toEqual({ settled: true })
        requests[0].resolve(json(consumed)); await flush()
        expect(getMessageWindowState('timeout').messages).toEqual([row])
    })
    it('uses one deadline across slow tail plus multiple batches without partial apply', async () => {
        const api = fixture('batch')
        for (let index = 0; index < 1000; index++) appendOptimisticMessage('batch', { ...row, id: `peer-${index}`, localId: `peer-${index}` })
        let tail!: (response: Response) => void
        vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { tail = resolve }))
        const pending = track(reconcileQueuedStateAfterConnect(api, 'batch')); await flush()
        await vi.advanceTimersByTimeAsync(10_000); tail(json(empty)); await flush()
        await vi.advanceTimersByTimeAsync(10_000); requests[0].resolve(json(consumed)); await flush()
        expect(requests).toHaveLength(2)
        await vi.advanceTimersByTimeAsync(10_000)
        expect(pending).toMatchObject({ settled: true, error: { name: 'TimeoutError' } })
        expect(getMessageWindowState('batch').messages).toHaveLength(1001)
        expect(getMessageWindowState('batch').messages.every(item => item.invokedAt === null)).toBe(true)
    })
    it('silently supersedes an old request without canceling the new owner', async () => {
        const api = fixture('superseded'), old = track(reconcileQueuedStateAfterConnect(api, 'superseded')); await flush()
        const next = track(reconcileQueuedStateAfterConnect(api, 'superseded')); await flush()
        expect(old).toEqual({ settled: true }); expect(requests[0].signal?.aborted).toBe(true)
        expect(requests[1].signal?.aborted).toBe(false)
        requests[0].reject(new Error('late failure')); await flush()
        requests[1].resolve(json(consumed)); await flush(); expect(next).toEqual({ settled: true })
        expect(getMessageWindowState('superseded').messages[0].invokedAt).toBe(1200)
    })
    for (const operation of ['clear', 'release', 'invalidate', 'seed'] as const) {
        it(`cancels on ${operation} and ignores a late completion`, async () => {
            const id = `teardown-${operation}`, api = fixture(id)
            const pending = track(reconcileQueuedStateAfterConnect(api, id)); await flush()
            if (operation === 'clear') { clearMessageWindow(id); appendOptimisticMessage(id, row) }
            else if (operation === 'release') releaseMessageWindow(id)
            else if (operation === 'invalidate') invalidateMessageWindow(id)
            else { fixture('seed-source'); seedMessageWindowFromSession('seed-source', id) }
            await flush(); expect(pending).toEqual({ settled: true })
            expect(requests[0].signal?.aborted).toBe(true)
            const before = getMessageWindowState(id); requests[0].resolve(json(consumed)); await flush()
            expect(getMessageWindowState(id)).toBe(before)
        })
    }
    it('cancels only outgoing API requests on an auth/server change', async () => {
        const oldApi = fixture('old'), newApi = fixture('new')
        const old = track(reconcileQueuedStateAfterConnect(oldApi, 'old'))
        const next = track(reconcileQueuedStateAfterConnect(newApi, 'new')); await flush()
        cancelQueuedStateRequestsForApi(oldApi); await flush()
        expect(old).toEqual({ settled: true }); expect(next.settled).toBe(false)
        expect(requests[1].signal?.aborted).toBe(false)
        requests[1].resolve(json(consumed)); await flush(); expect(next).toEqual({ settled: true })
    })
    it('does not start auth refresh after cancellation followed by a late401', async () => {
        const refresh = vi.fn(async () => 'new-token'), api = fixture('late401', row, { onUnauthorized: refresh })
        const pending = track(reconcileQueuedStateAfterConnect(api, 'late401')); await flush()
        cancelQueuedStateRequestsForApi(api); await flush(); expect(pending).toEqual({ settled: true })
        requests[0].resolve(json({}, 401)); await flush(); expect(refresh).not.toHaveBeenCalled()
    })
    it('does not change token or retry after cancellation during auth refresh', async () => {
        let refresh!: (token: string) => void
        const api = fixture('refresh', row, { onUnauthorized: () => new Promise(resolve => { refresh = resolve }) })
        const pending = track(reconcileQueuedStateAfterConnect(api, 'refresh')); await flush()
        requests[0].resolve(json({}, 401)); await flush(); cancelQueuedStateRequestsForApi(api); await flush()
        expect(pending).toEqual({ settled: true }); refresh('new-token'); await flush(); expect(requests).toHaveLength(1)
        await api.getWorkspaces()
        expect(new Headers(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.headers).get('authorization')).toBe('Bearer old-token')
    })
    it('allows legitimate auth refresh and authoritative completion', async () => {
        const api = fixture('refresh-control', row, { onUnauthorized: async () => 'new-token' })
        const pending = track(reconcileQueuedStateAfterConnect(api, 'refresh-control')); await flush()
        requests[0].resolve(json({}, 401)); await flush(); requests[1].resolve(json(consumed)); await flush()
        expect(pending).toEqual({ settled: true })
        expect(getMessageWindowState('refresh-control').messages[0].invokedAt).toBe(1200)
    })
    for (const outcome of ['success', 'failure', 'cancel', 'timeout'] as const) {
        it(`releases request listeners/timer/ownership after ${outcome}`, async () => {
            const id = `cleanup-${outcome}`, api = fixture(id)
            const add = vi.spyOn(AbortSignal.prototype, 'addEventListener'), remove = vi.spyOn(AbortSignal.prototype, 'removeEventListener')
            const pending = track(reconcileQueuedStateAfterConnect(api, id)); await flush()
            const signal = requests[0].signal; expect(signal).toBeDefined()
            if (outcome === 'success') requests[0].resolve(json(consumed))
            else if (outcome === 'failure') requests[0].reject(new Error('network failed'))
            else if (outcome === 'cancel') cancelQueuedStateRequestsForApi(api)
            else await vi.advanceTimersByTimeAsync(30_000)
            await flush(); expect(pending.settled).toBe(true)
            const registrations = add.mock.calls.filter((call, i) => add.mock.contexts[i] === signal && call[0] === 'abort')
            const removals = remove.mock.calls.filter((call, i) => remove.mock.contexts[i] === signal && call[0] === 'abort')
            expect(registrations.length).toBeGreaterThan(0)
            for (const call of registrations) expect(removals.some(value => value[1] === call[1])).toBe(true)
            await vi.advanceTimersByTimeAsync(1000); expect(vi.getTimerCount()).toBe(0)
            if (outcome === 'success' || outcome === 'failure') { cancelQueuedStateRequestsForApi(api); expect(signal?.aborted).toBe(false) }
        })
    }
})
