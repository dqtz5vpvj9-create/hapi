import { StrictMode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WindowedMessageList } from './VirtualMessageList'

const callbacks = new Map<Element, Set<ResizeObserverCallback>>()
class ResizeObserverMock {
    private targets = new Set<Element>()
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
        this.targets.add(target)
        const listeners = callbacks.get(target) ?? new Set()
        listeners.add(this.callback); callbacks.set(target, listeners)
    }
    unobserve(target: Element) { callbacks.get(target)?.delete(this.callback); this.targets.delete(target) }
    disconnect() { for (const target of this.targets) this.unobserve(target) }
}
afterEach(() => { cleanup(); callbacks.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('retains the actual reading range through StrictMode hide/reveal without a new scroll event', () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    const viewport = document.createElement('div')
    document.body.append(viewport)
    let width = 800, height = 400
    Object.defineProperties(viewport, {
        offsetWidth: { get: () => width }, offsetHeight: { get: () => height },
        clientWidth: { get: () => width }, clientHeight: { get: () => height },
    })
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, width, height)
    viewport.scrollTo = vi.fn()
    viewport.scrollTop = 1500
    const ids = Array.from({ length: 100 }, (_, index) => `row-${index}`)
    const { container, unmount } = render(<StrictMode><WindowedMessageList
        scrollElement={viewport} ids={ids} ownerOf={id => id} renderRow={id => <div>{id}</div>}
    /></StrictMode>)
    act(() => { viewport.dispatchEvent(new Event('scroll')) })
    const publishRect = () => {
        for (const callback of [...(callbacks.get(viewport) ?? [])]) callback([{
            target: viewport, borderBoxSize: [{ inlineSize: width, blockSize: height }],
            contentRect: new DOMRect(0, 0, width, height),
        } as unknown as ResizeObserverEntry], {} as ResizeObserver)
    }
    expect(container.querySelector('[data-hapi-virtual-message="row-15"]')).not.toBeNull()
    expect(container.querySelector('[data-hapi-virtual-message="row-0"]')).toBeNull()
    act(() => { width = 0; height = 0; viewport.scrollTop = 0; publishRect(); viewport.dispatchEvent(new Event('scroll')) })
    act(() => { viewport.scrollTop = 1500; width = 800; height = 400; publishRect() })
    expect(viewport.scrollTop).toBe(1500)
    expect(container.querySelector('[data-hapi-virtual-message="row-15"]')).not.toBeNull()
    expect(container.querySelector('[data-hapi-virtual-message="row-0"]')).toBeNull()
    unmount(); viewport.remove()
})
