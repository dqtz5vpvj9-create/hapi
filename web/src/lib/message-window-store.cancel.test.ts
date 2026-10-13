import { afterEach, describe, expect, it, vi } from 'vitest'
import * as store from '@/lib/message-window-store'
import { getHistoryPageRepository } from '@/lib/history-page-repository'
import { reconcileQueuedStateAfterConnect } from '@/lib/queued-state-reconciliation'
import { cancelQueuedStateRequestsForApi } from '@/lib/queued-state-request-lifetime'

const pending = <T>() => {
    let resolve!: (value: T) => void, reject!: (error: Error) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
const row = (id: string, seq = 1) => ({ id, localId: `local-${id}`, seq, createdAt: 1000 + seq, invokedAt: null, content: { role: 'user', content: { type: 'text', text: id } } }) as any
const page = (messages: any[], epoch = 1) => ({ messages, page: {
    direction: 'latest', limit: 20, epoch, reset: false, hasMore: false,
    nextBeforeAt: 1001, nextBeforeSeq: 1, nextAfterAt: 1004, nextAfterSeq: 4, snapshotHeadAt: 1004, snapshotHeadSeq: 4,
} }) as any
const context = (messages: any[]) => ({ messages, page: { epoch: 1, reset: false, beforeCursor: { at: 1001, seq: 1 }, afterCursor: { at: 1004, seq: 4 }, snapshotHead: { at: 1004, seq: 4 }, hasMoreBefore: false, hasMoreAfter: false } })
const ids = new Set<string>(), apis = new Set<any>()
const rows = (id: string) => store.getMessageWindowState(id).messages
const fixture = () => {
    const id = crypto.randomUUID(), other = crypto.randomUUID(); ids.add(id); ids.add(other)
    const target = row('target', 2), neighbor = row('neighbor', 3), otherRow = row('target', 2)
    store.ingestIncomingMessages(id, [target, neighbor]); store.ingestIncomingMessages(other, [otherRow])
    return { id, other, target, neighbor, otherRow }
}
const trackApi = (api: any) => { apis.add(api); return api }
const confirm = store.confirmQueuedMessageCancelled
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
afterEach(async () => {
    ids.forEach(store.clearMessageWindow); ids.clear()
    apis.forEach(api => { cancelQueuedStateRequestsForApi(api); getHistoryPageRepository(api).invalidate() }); apis.clear()
    await flush(); sessionStorage.clear(); vi.restoreAllMocks()
})

describe('confirmed queue cancellation read ownership', () => {
    it('invalidates a pure pending context read when no tail controller exists', async () => {
        const f = fixture(), read = pending<any>()
        const api = trackApi({ getMessageContext: vi.fn(() => read.promise) })
        const opening = store.openMessageContext(api, f.id, f.target.id, () => true)
        expect(api.getMessageContext).toHaveBeenCalledOnce()
        confirm(api, f.id, f.target.localId)
        read.resolve(context([f.target, f.neighbor])); expect(await opening).toBe(false)
        expect(rows(f.id)).toEqual([f.neighbor]); expect(rows(f.other)).toEqual([f.otherRow])
        expect(store.getMessageWindowState(f.id)).toMatchObject({ isLoadingMore: false, warning: null })
        expect(getHistoryPageRepository(api).findCachedMessagePage(f.id, 1, f.target.id)).toBeNull()
    })
    it('invalidates only the cancelled session cache even without any tail controller', () => {
        const f = fixture(), api = trackApi({})
        const repository = getHistoryPageRepository(api)
        repository.rememberPage(f.id, { direction: 'latest' }, page([f.target, f.neighbor]))
        repository.rememberPage(f.other, { direction: 'latest' }, page([f.otherRow]))
        expect(repository.getCached(f.id, { direction: 'latest' })).not.toBeNull()
        confirm(api, f.id, f.target.localId)
        expect(repository.getCached(f.id, { direction: 'latest' })).toBeNull()
        expect(repository.getCached(f.other, { direction: 'latest' })?.messages).toEqual([f.otherRow])
        expect(rows(f.id)).toEqual([f.neighbor])
    })
    it('replaces an active stale read and retains newly arriving neighbors despite old finally', async () => {
        const f = fixture(), stale = pending<any>(), current = pending<any>(), newRow = row('new-neighbor', 4)
        const api = trackApi({ getMessages: vi.fn().mockImplementationOnce(() => stale.promise).mockImplementationOnce(() => current.promise) })
        const oldRead = store.syncTailMessages(api, f.id)
        confirm(api, f.id, f.target.localId)
        expect(api.getMessages).toHaveBeenCalledTimes(2)
        stale.resolve(page([f.target, f.neighbor])); await oldRead
        expect(store.getMessageWindowState(f.id).isSyncingTail).toBe(true)
        const latest = store.syncTailMessages(api, f.id)
        expect(api.getMessages).toHaveBeenCalledTimes(2)
        current.resolve(page([f.neighbor, newRow], 2)); await latest
        expect(rows(f.id)).toEqual([f.neighbor, newRow])
        expect(rows(f.other)).toEqual([f.otherRow])
        expect(store.getMessageWindowState(f.id)).toMatchObject({ isSyncingTail: false, warning: null })
    })
    it('lets independent queued-state authority settle a neighboring row after target cancellation', async () => {
        const f = fixture(), state = pending<any>()
        const api = trackApi({ getMessages: vi.fn().mockResolvedValue(page([f.target, f.neighbor])), getQueuedState: vi.fn(() => state.promise) })
        const reconciliation = reconcileQueuedStateAfterConnect(api, f.id); await flush()
        expect(api.getQueuedState).toHaveBeenCalledOnce()
        confirm(api, f.id, f.target.localId)
        state.resolve({ queuedLocalIds: [f.target.localId], invokedLocalMessages: [{ localId: f.neighbor.localId, invokedAt: 4000 }] })
        await reconciliation
        expect(rows(f.id)).toHaveLength(1)
        expect(rows(f.id)[0]).toMatchObject({ id: f.neighbor.id, invokedAt: 4000 })
        expect(rows(f.other)).toEqual([f.otherRow])
    })
    it('preserves history intent and permits a genuinely new read rather than keeping a tombstone', async () => {
        const f = fixture(), api = trackApi({})
        store.setMessageViewMode(f.id, 'history')
        store.saveMessageReadingAnchor(f.id, { id: 'hapi-message:neighbor', topOffset: 57 } as any)
        const bookmark = store.getMessageReadingAnchor(f.id)
        confirm(api, f.id, f.target.localId)
        expect(store.getMessageReadingAnchor(f.id)).toEqual(bookmark)
        expect(store.getMessageWindowState(f.id).viewMode).toBe('history')
        const legitimate = row('new-message', 4)
        Object.assign(api, { getMessageContext: vi.fn().mockResolvedValue(context([f.neighbor, legitimate])) })
        expect(await store.openMessageContext(api, f.id, legitimate.id, () => true)).toBe(true)
        expect(rows(f.id).map(item => item.id)).toEqual([f.neighbor.id, legitimate.id])
        expect(rows(f.other)).toEqual([f.otherRow])
    })
})
