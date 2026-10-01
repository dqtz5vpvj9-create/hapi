import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'

const row = (n: number, text: string): DecryptedMessage => ({
    id: `m-${n}`, seq: n, createdAt: n, invokedAt: n, localId: null, scheduledAt: null,
    content: { role: 'user', content: { type: 'text', text } }
})
const context = (n: number, text: string) => ({ messages: [row(n, text)],
    anchor: { id: `m-${n}`, at: n, seq: n, status: 'found' },
    page: { epoch: 1, hasMoreBefore: true, hasMoreAfter: true,
        beforeCursor: { at: n, seq: n }, afterCursor: { at: n, seq: n }, snapshotHead: { at: 1000, seq: 1000 } }
})
const apiFor = (...responses: ReturnType<typeof context>[]) => ({
    getMessageContext: responses.reduce((fn, value) => fn.mockResolvedValueOnce(value), vi.fn())
}) as unknown as ApiClient
let store: typeof import('./message-window-store')
beforeEach(async () => {
    vi.useFakeTimers(); vi.resetModules(); sessionStorage.clear()
    store = await import('./message-window-store')
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); sessionStorage.clear() })
async function read(api: ApiClient, session: string, n: number) {
    expect(await store.openMessageContext(api, session, `m-${n}`, () => true)).toBe(true)
    store.saveMessageReadingAnchor(session, { id: `hapi-message-user-text:m-${n}`, topOffset: 16 }, true)
    await vi.runOnlyPendingTimersAsync()
}
async function cold() { vi.resetModules(); return import('./message-window-store') }

it('recovers the current context after large native bodies exceed real storage capacity, retaining a local queued row', async () => {
    const id = 'quota-reader'
    const large = 'PUBLIC REPORT5 ' + 'x'.repeat(6 * 1024 * 1024)
    const api = apiFor(context(929, 'PUBLIC REPORT929'), context(5, large))
    await read(api, id, 929)
    const queued: DecryptedMessage = { ...row(0, 'PUBLIC UNSENT'), id: 'local-1', localId: 'local-1',
        seq: null, invokedAt: null, status: 'queued' }
    store.appendOptimisticMessage(id, queued)
    await read(api, id, 5)
    const fresh = await cold()
    expect(fresh.getMessageReadingAnchor(id)?.id).toBe('hapi-message-user-text:m-5')
    expect(fresh.getMessageWindowState(id).messages).toEqual([queued])
    const recovered = context(5, large)
    const online = { getMessages: vi.fn(async () => ({ messages: [row(1000, 'PUBLIC LATEST')],
        page: { direction: 'latest', limit: 200, epoch: 1, reset: false, hasMore: true,
            nextBeforeAt: 1000, nextBeforeSeq: 1000, snapshotHeadAt: 1000, snapshotHeadSeq: 1000 } })),
        getMessageContext: vi.fn(async () => recovered) } as unknown as ApiClient
    fresh.activateMessageWindow(id)
    await fresh.syncTailMessages(online, id)
    expect(online.getMessageContext).toHaveBeenCalledWith(id, 'm-5', { radius: 99, epoch: 1 })
    expect(fresh.getMessageWindowState(id).messages.map(m => m.id).sort()).toEqual(['local-1', 'm-5'])
    expect(fresh.getMessageWindowState(id).viewMode).toBe('history')
    fresh.setMessageViewMode(id, 'tail')
    await fresh.syncTailMessages(online, id)
    expect(fresh.getMessageWindowState(id).viewMode).toBe('tail')
    expect(fresh.getMessageReadingAnchor(id)).toBeNull()
    expect(fresh.getMessageWindowState(id).messages.some(m => m.id === 'local-1')).toBe(true)
})

it('does not serialize or rewrite body caches when the user moves the reading bookmark', async () => {
    const id = 'scroll-reader'
    await read(apiFor(context(5, 'PUBLIC REPORT5')), id, 5)
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    for (let offset = 10; offset < 30; offset++) store.saveMessageReadingAnchor(id,
        { id: 'hapi-message-user-text:m-5', topOffset: offset })
    await vi.runOnlyPendingTimersAsync()
    expect(setItem.mock.calls.length).toBeGreaterThan(0)
    expect(setItem.mock.calls.every(([key]) => key === `hapi:message-reader:v1:${id}`)).toBe(true)
    expect(setItem.mock.calls.every(([, value]) => JSON.parse(value).messages.length === 0)).toBe(true)
    const fresh = await cold()
    expect(fresh.getMessageReadingAnchor(id)?.topOffset).toBe(29)
})

it('reclaims another session optional cache under actual quota pressure without deleting its queued content or bookmark', async () => {
    const other = 'other-reader'
    const primaryKey = `hapi:message-reader:v1:${other}`
    const cacheKey = `hapi:message-window:v2:${other}`
    const pending = { ...row(0, 'PUBLIC OTHER UNSENT'), id: 'other-local', seq: null, invokedAt: null, status: 'queued' }
    const metadata = JSON.stringify({ messages: [pending], readingBookmark: { id: 'other-anchor', topOffset: 8 }, viewMode: 'history', hasMore: true })
    sessionStorage.setItem(primaryKey, metadata)
    // jsdom's real default quota is 5,000,000 code units. Fill the optional
    // cache to one remaining unit; Storage itself supplies the quota error.
    const empty = JSON.stringify({ messages: [], padding: '' })
    const padding = 'x'.repeat(5000000 - primaryKey.length - metadata.length - cacheKey.length - empty.length - 1)
    sessionStorage.setItem(cacheKey, JSON.stringify({ messages: [], padding }))
    await read(apiFor(context(5, 'PUBLIC REPORT5')), 'new-reader', 5)
    expect(sessionStorage.getItem(primaryKey)).toBe(metadata)
    expect(sessionStorage.getItem(cacheKey)).toBeNull()
    const fresh = await cold()
    expect(fresh.getMessageReadingAnchor('new-reader')?.id).toBe('hapi-message-user-text:m-5')
    expect(fresh.getMessageWindowState(other).messages).toEqual([pending])
    expect(fresh.getMessageReadingAnchor(other)?.id).toBe('other-anchor')
})

it('bounds optional caches across sessions while keeping both reading intents available for cold context recovery', async () => {
    for (const id of ['reader-a', 'reader-b']) await read(apiFor(context(5, 'PUBLIC '+id+' '+ 'x'.repeat(600000))), id, 5)
    const keys = Object.keys(sessionStorage).filter(k => k.startsWith('hapi:message-window:v2:'))
    expect(keys.reduce((bytes, k) => bytes + sessionStorage.getItem(k)!.length * 2, 0)).toBeLessThanOrEqual(2 * 1024 * 1024)
    const fresh = await cold()
    for (const id of ['reader-a', 'reader-b']) expect(fresh.getMessageReadingAnchor(id)?.id).toBe('hapi-message-user-text:m-5')
    expect(fresh.getMessageWindowState('reader-a').messages).toHaveLength(0)
    expect(fresh.getMessageWindowState('reader-b').messages).toHaveLength(1)
})

it('clears both independent intent and optional bodies when a session window is cleared', async () => {
    const id = 'clear-reader'
    await read(apiFor(context(5, 'PUBLIC REPORT5')), id, 5)
    store.clearMessageWindow(id)
    expect(sessionStorage.getItem(`hapi:message-reader:v1:${id}`)).toBeNull()
    expect(sessionStorage.getItem(`hapi:message-window:v2:${id}`)).toBeNull()
    expect((await cold()).getMessageReadingAnchor(id)).toBeNull()
})

it('frees previous-version window bodies in place under real quota pressure without losing another session local rows', async () => {
    const id = 'legacy-reader'
    const key = `hapi:message-window:v2:${id}`
    const pending = { ...row(0, 'PUBLIC LEGACY UNSENT'), id: 'legacy-local', seq: null, invokedAt: null, status: 'queued' }
    const legacy = { messages: [row(905, ''), pending], readingBookmark: { id: 'legacy-anchor', sourceMessageId: 'm-905', topOffset: 18 },
        viewMode: 'history', hasMore: true, epoch: 1, oldestPositionAt: 905, oldestPositionSeq: 905, newestPositionAt: 1000, newestPositionSeq: 1000 }
    const length = JSON.stringify(legacy).length
    legacy.messages[0] = row(905, 'x'.repeat(5000000 - key.length - length - 1))
    sessionStorage.setItem(key, JSON.stringify(legacy))
    await read(apiFor(context(5, 'PUBLIC REPORT5')), 'new-reader', 5)
    const fresh = await cold()
    expect(fresh.getMessageReadingAnchor('new-reader')?.id).toBe('hapi-message-user-text:m-5')
    expect(fresh.getMessageWindowState(id).messages).toEqual([pending])
    expect(fresh.getMessageReadingAnchor(id)?.id).toBe('legacy-anchor')
})
