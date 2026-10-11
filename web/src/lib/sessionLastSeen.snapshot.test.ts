import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    getSessionReadStateSnapshot,
    initializeSessionLastSeen,
    markAllSessionsSeen,
    markSessionSeen,
    markSessionUnread,
} from './sessionLastSeen'

const seenKey = 'hapi.sessionLastSeen.v1'
const unreadKey = 'hapi.sessionManualUnread.v1'
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('persisted read-state snapshots', () => {
    it.each([100, 1000])('reads and parses each %i-entry map only once', count => {
        const seen = Object.fromEntries(Array.from({ length: count }, (_, i) => [`row-${i}`, i]))
        const unread = Object.fromEntries(Array.from({ length: count }, (_, i) => [`row-${i}`, i + 1]))
        localStorage.setItem(seenKey, JSON.stringify(seen))
        localStorage.setItem(unreadKey, JSON.stringify(unread))
        const reads = vi.spyOn(Storage.prototype, 'getItem')
        const parses = vi.spyOn(JSON, 'parse')
        const snapshot = getSessionReadStateSnapshot()
        for (let i = 0; i < count; i++) {
            expect(snapshot.lastSeenById[`row-${i}`]).toBe(i)
            expect(snapshot.manualUnreadById[`row-${i}`]).toBe(i + 1)
        }
        expect(reads.mock.calls).toEqual([[seenKey], [unreadKey]])
        expect(parses).toHaveBeenCalledTimes(2)
    })

    it('keeps old snapshots detached from later writes and initialization', () => {
        markSessionUnread('a', 100)
        const previous = getSessionReadStateSnapshot()
        markSessionSeen('a', 100)
        initializeSessionLastSeen('snapshot-hub', [{ id: 'b', updatedAt: 200 }])
        expect(previous).toEqual({ lastSeenById: { a: 99 }, manualUnreadById: { a: 100 } })
        expect(getSessionReadStateSnapshot()).toEqual({ lastSeenById: { a: 100, b: 200 }, manualUnreadById: {} })
    })

    it.each(['seen', 'unread', 'all', 'initialize'] as const)('does not publish failed %s writes into later snapshots', operation => {
        localStorage.setItem(seenKey, JSON.stringify({ a: 99 }))
        localStorage.setItem(unreadKey, JSON.stringify({ a: 100 }))
        const before = getSessionReadStateSnapshot()
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })
        if (operation === 'seen') markSessionSeen('a', 100)
        if (operation === 'unread') markSessionUnread('a', 200)
        if (operation === 'all') markAllSessionsSeen([{ id: 'a', updatedAt: 100 }])
        if (operation === 'initialize') initializeSessionLastSeen('new-hub', [{ id: 'b', updatedAt: 200 }])
        expect(getSessionReadStateSnapshot()).toEqual(before)
    })

    it('reflects only the successful key when a two-key write partially fails', () => {
        markSessionUnread('a', 100)
        const setItem = Storage.prototype.setItem
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
            if (key === unreadKey) throw new Error('quota exceeded')
            setItem.call(this, key, value)
        })
        markSessionSeen('a', 100)
        expect(getSessionReadStateSnapshot()).toEqual({ lastSeenById: { a: 100 }, manualUnreadById: { a: 100 } })
    })

    it('observes direct replacement, removal and clear on each new snapshot', () => {
        markSessionUnread('a', 100)
        const before = getSessionReadStateSnapshot()
        localStorage.setItem(seenKey, JSON.stringify({ b: 200 }))
        localStorage.removeItem(unreadKey)
        expect(getSessionReadStateSnapshot()).toEqual({ lastSeenById: { b: 200 }, manualUnreadById: {} })
        localStorage.clear()
        expect(getSessionReadStateSnapshot()).toEqual({ lastSeenById: {}, manualUnreadById: {} })
        expect(before).toEqual({ lastSeenById: { a: 99 }, manualUnreadById: { a: 100 } })
    })
})
