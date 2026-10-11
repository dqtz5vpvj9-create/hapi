import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { captureReadingAnchor, restoreReadingAnchor } from './reading-anchor'
import { clearMessageWindow, getMessageReadingAnchor, getMessageWindowState, saveMessageReadingAnchor } from './message-window-store'
const ids = new Set<string>()
afterEach(() => {
    ids.forEach(clearMessageWindow); ids.clear(); vi.restoreAllMocks(); sessionStorage.clear(); document.body.innerHTML = ''
    Reflect.deleteProperty(document, 'caretPositionFromPoint')
})
function fixture(id: string) {
    ids.add(id)
    const source: DecryptedMessage = { id: 'source', seq: 1, localId: null, createdAt: 1, invokedAt: 1,
        content: { role: 'user', content: { type: 'text', text: 'short' } } }
    const viewport = document.createElement('div')
    viewport.innerHTML = '<div class="happy-thread-messages"><div id="hapi-message-user-text:source">short</div></div>'
    document.body.append(viewport)
    const row = viewport.querySelector<HTMLElement>('[id]')!
    let node = row.firstChild as Text, textTop = 20
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top, toJSON: () => ({}) })
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => rect(0, 500))
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => rect(10, 100))
    const createRange = document.createRange.bind(document)
    vi.spyOn(document, 'createRange').mockImplementation(() => { const range = createRange(); range.getClientRects = () => [rect(textTop, 16)] as unknown as DOMRectList; return range })
    Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: node, offset: 1 }) })
    const first = captureReadingAnchor(viewport)!
    expect(first.text?.quote).toBe('short')
    sessionStorage.setItem(`hapi:message-reader:v1:${id}`, JSON.stringify({ messages: [source],
        readingBookmark: { ...first, sourceMessageId: source.id, position: { at: 1, seq: 1 } },
        viewMode: 'tail', hasMore: false, epoch: 1, oldestPositionAt: 1, oldestPositionSeq: 1, newestPositionAt: 1, newestPositionSeq: 1 }))
    return { viewport, first, moveText: () => { textTop = 40 }, replaceText: () => {
        const replacement = document.createTextNode('short'); row.replaceChild(replacement, node); node = replacement
    } }
}
describe('equal bookmark weak DOM capture refresh', () => {
    for (const replaced of [false, true]) it(`preserves short-quote restoration after ${replaced ? 'node replacement' : 'hydration'} without state churn`, () => {
        const id = `dom-${replaced}`, view = fixture(id), before = getMessageWindowState(id), retained = getMessageReadingAnchor(id)!
        saveMessageReadingAnchor(id, view.first)
        if (replaced) view.replaceText()
        const fresh = captureReadingAnchor(view.viewport)!
        const write = vi.spyOn(Storage.prototype, 'setItem'), remove = vi.spyOn(Storage.prototype, 'removeItem')
        saveMessageReadingAnchor(id, fresh)
        expect(getMessageWindowState(id)).toBe(before); expect(getMessageReadingAnchor(id)).toBe(retained)
        expect(write).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
        view.moveText(); expect(restoreReadingAnchor(view.viewport, retained)).toBe(true)
        expect(view.viewport.scrollTop).toBe(20)
    })
})
