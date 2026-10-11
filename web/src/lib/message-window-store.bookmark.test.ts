import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReadingAnchor } from './reading-anchor'
import type { DecryptedMessage } from '@/types/api'
import { clearMessageWindow, getMessageReadingAnchor, getMessageWindowState, saveMessageReadingAnchor } from './message-window-store'
const row: DecryptedMessage = { id: 'source', seq: 10, localId: null, createdAt: 900, invokedAt: 1000,
    content: { role: 'user', content: { type: 'text', text: 'Stable source' } } }
const anchor: ReadingAnchor = { id: 'hapi-message-user-text:source', topOffset: -12, disclosure: true,
    text: { path: [1, 2], offset: 8, quote: 'stable reading source', quoteStart: 3, topOffset: 9 },
    code: { source: 2, innerTopOffset: 5, position: 8, quote: 'stable code source', quoteStart: 3, topOffset: 9 } }
const ids = new Set<string>()
function seed(id: string, bookmark: ReadingAnchor | null = anchor, metadata: Record<string, unknown> = {}) {
    ids.add(id)
    sessionStorage.setItem(`hapi:message-reader:v1:${id}`, JSON.stringify({ messages: [row],
        readingBookmark: bookmark ? { ...bookmark, sourceMessageId: row.id, position: { at: 1000, seq: 10 }, ...metadata } : null,
        viewMode: 'tail', hasMore: false, epoch: 1, oldestPositionAt: 1000, oldestPositionSeq: 10, newestPositionAt: 1000, newestPositionSeq: 10 }))
    return getMessageWindowState(id)
}
const copy = (): ReadingAnchor => JSON.parse(JSON.stringify(anchor))
beforeEach(() => { vi.useFakeTimers(); sessionStorage.clear() })
afterEach(() => { ids.forEach(clearMessageWindow); ids.clear(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); sessionStorage.clear() })
describe('normalized reading bookmark idempotence', () => {
    for (const immediate of [false, true]) it(`does not replace equal snapshots or write storage (immediate=${immediate})`, () => {
        const id = `equal-${immediate}`, before = seed(id), saved = getMessageReadingAnchor(id)
        const write = vi.spyOn(Storage.prototype, 'setItem'), remove = vi.spyOn(Storage.prototype, 'removeItem')
        for (let i = 0; i < 20; i++) saveMessageReadingAnchor(id, copy(), immediate)
        expect(getMessageWindowState(id)).toBe(before); expect(getMessageReadingAnchor(id)).toBe(saved)
        expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
    })
    it('preserves an already-null bookmark without storage work', () => {
        const id = 'empty', before = seed(id, null)
        const write = vi.spyOn(Storage.prototype, 'setItem'), remove = vi.spyOn(Storage.prototype, 'removeItem')
        saveMessageReadingAnchor(id, null); saveMessageReadingAnchor(id, null, true)
        expect(getMessageWindowState(id)).toBe(before); expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
    })
    const changes: Array<[string, (value: ReadingAnchor) => ReadingAnchor]> = [
        ['id', value => ({ ...value, id: 'other' })], ['topOffset', value => ({ ...value, topOffset: -11 })],
        ['disclosure', value => ({ ...value, disclosure: undefined })], ['text removal', value => ({ ...value, text: undefined })],
        ['code removal', value => ({ ...value, code: undefined })],
        ['text path', value => ({ ...value, text: { ...value.text!, path: [1, 3] } })],
        ['text path length', value => ({ ...value, text: { ...value.text!, path: [1, 2, 0] } })],
        ['text offset', value => ({ ...value, text: { ...value.text!, offset: 9 } })],
        ['text quote', value => ({ ...value, text: { ...value.text!, quote: 'changed' } })],
        ['text quoteStart', value => ({ ...value, text: { ...value.text!, quoteStart: 4 } })],
        ['text topOffset', value => ({ ...value, text: { ...value.text!, topOffset: 10 } })],
        ['code source', value => ({ ...value, code: { ...value.code!, source: 3 } })],
        ['code innerTopOffset', value => ({ ...value, code: { ...value.code!, innerTopOffset: 6 } })],
        ['code innerTopOffset removal', value => ({ ...value, code: { ...value.code!, innerTopOffset: undefined } })],
        ['code position', value => ({ ...value, code: { ...value.code!, position: 9 } })],
        ['code quote', value => ({ ...value, code: { ...value.code!, quote: 'changed' } })],
        ['code quoteStart', value => ({ ...value, code: { ...value.code!, quoteStart: 4 } })],
        ['code topOffset', value => ({ ...value, code: { ...value.code!, topOffset: 10 } })]
    ]
    for (const [field, change] of changes) it(`preserves an actual ${field} change and deduplicates only the repeat`, () => {
        const id = `change-${field}`, before = seed(id), changed = change(copy())
        const write = vi.spyOn(Storage.prototype, 'setItem')
        saveMessageReadingAnchor(id, changed)
        const after = getMessageWindowState(id); expect(after).not.toBe(before)
        expect(getMessageReadingAnchor(id)).toMatchObject(changed); expect(write).toHaveBeenCalledOnce()
        saveMessageReadingAnchor(id, JSON.parse(JSON.stringify(changed)))
        expect(getMessageWindowState(id)).toBe(after); expect(write).toHaveBeenCalledOnce()
    })
    for (const metadata of [{ sourceMessageId: 'old' }, { position: { at: 999, seq: 10 } }, { position: { at: 1000, seq: 9 } }]) {
        it(`persists changed normalized source metadata ${JSON.stringify(metadata)}`, () => {
            const id = JSON.stringify(metadata), before = seed(id, anchor, metadata), write = vi.spyOn(Storage.prototype, 'setItem')
            saveMessageReadingAnchor(id, copy()); expect(getMessageWindowState(id)).not.toBe(before)
            expect(getMessageReadingAnchor(id)).toMatchObject({ sourceMessageId: row.id, position: { at: 1000, seq: 10 } })
            expect(write).toHaveBeenCalledOnce()
        })
    }
    it('clears an existing bookmark once', () => {
        const id = 'clear', before = seed(id); saveMessageReadingAnchor(id, null)
        const after = getMessageWindowState(id); expect(after).not.toBe(before); expect(getMessageReadingAnchor(id)).toBeNull()
        const write = vi.spyOn(Storage.prototype, 'setItem'), remove = vi.spyOn(Storage.prototype, 'removeItem')
        saveMessageReadingAnchor(id, null); expect(getMessageWindowState(id)).toBe(after)
        expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
    })
})
