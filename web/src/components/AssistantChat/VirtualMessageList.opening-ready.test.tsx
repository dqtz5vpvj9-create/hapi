import { createRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WindowedMessageList, type MessageListNavigation } from './VirtualMessageList'

const mock = vi.hoisted(() => ({
    rows: [{ key: 'row', index: 0, start: 0, end: 100, size: 100, lane: 0 }],
    api: { getVirtualItems: () => mock.rows, getTotalSize: () => 100, resizeItem: () => {},
        measureElement: () => {}, scrollRect: { height: 100 }, scrollElement: null,
        shouldAdjustScrollPositionOnItemSizeChange: () => false },
}))
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: () => mock.api, defaultRangeExtractor: () => [0], observeElementOffset: () => () => {}, observeElementRect: () => () => {} }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('notifies the opening owner when measured readiness changes without a virtual geometry change', () => {
    let measuredHeight = 90
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => [new DOMRect(0, 0, 100, 100)] as unknown as DOMRectList)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return new DOMRect(0, 0, 100, this.hasAttribute('data-hapi-list-count') ? measuredHeight : 100)
    })
    const original = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => element.hasAttribute('data-hapi-virtual-message')
        ? { ...original(element), height: '100px' } as CSSStyleDeclaration : original(element))
    const navigation = createRef<MessageListNavigation>()
    const layout = vi.fn()
    const ids = ['row'], ownerOf = (id: string) => id, renderRow = (id: string) => <div>{id}</div>
    const props = { ids, ownerOf, renderRow, scrollElement: null, navigationRef: navigation, onLayout: layout }
    const view = render(<WindowedMessageList {...props} rowGap={12} />)
    expect(navigation.current!.isLayoutReady(true)).toBe(false)
    const count = layout.mock.calls.length
    measuredHeight = 100
    // Force a commit without changing rows, virtual starts/sizes, or callback.
    view.rerender(<WindowedMessageList {...props} rowGap={13} />)
    expect(navigation.current!.isLayoutReady(true)).toBe(true)
    expect(layout.mock.calls.length).toBe(count + 1)
})
