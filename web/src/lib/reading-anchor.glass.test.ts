import { afterEach, expect, it, vi } from 'vitest'
import { captureReadingAnchor, restoreReadingAnchor } from './reading-anchor'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

it('preserves a readable message across prepend while ignoring rows behind floating controls', () => {
    const viewport = document.createElement('div')
    viewport.style.scrollPaddingTop = '80px'
    viewport.style.scrollPaddingBottom = '150px'
    const list = document.createElement('div')
    list.className = 'happy-thread-messages'
    viewport.append(list); document.body.append(viewport)
    const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 390, width: 390, height: bottom - top, x: 0, y: top, toJSON() {} })
    vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect(0, 600))
    let readableTop = 110
    for (const [id, top, bottom] of [['covered-header', 0, 70], ['readable', 110, 250], ['covered-composer', 480, 590]] as const) {
        const row = document.createElement('div')
        row.id = `hapi-message-${id}`
        list.append(row)
        vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => id === 'readable' ? rect(readableTop, readableTop + 140) : rect(top, bottom))
    }
    const anchor = captureReadingAnchor(viewport)!
    expect(anchor.id).toBe('hapi-message-readable')
    expect(anchor.topOffset).toBe(110)
    readableTop += 260
    viewport.scrollTop = 500
    restoreReadingAnchor(viewport, anchor)
    expect(viewport.scrollTop).toBe(760)
})
