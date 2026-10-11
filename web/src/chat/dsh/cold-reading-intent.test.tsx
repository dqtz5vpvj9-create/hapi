import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatViewport } from '../nativeViewport'
import type { NativeChatProjection } from '../nativeProjection'
import type { ChatScrollPosition } from './types'
import { useChatScroll } from './use-chat-scroll'

/** Causal owner harness, not a browser/performance benchmark. Geometry and
 * browser default scrolling are explicit so clamping and overwrites differ.
 * Before history arrives NativeCodexThread's hasMore gate prevents loadEarlier;
 * this seam exercises its real native viewport + DSH reading owner underneath.
 */
class TestNativeViewport extends NativeChatViewport {
    override isOpeningLayoutReady() { return true }
    override capturePosition(): ChatScrollPosition | null {
        const scroll = this.readScroll()
        return scroll ? { anchorKey: 'row', anchorTop: 0, scrollTop: scroll.metrics.top } : null
    }
    override readVisibleTurn() { return 1 }
}

function fixture() {
    const geometry = { top: 0, floor: 0, height: 600, writes: [] as number[] }
    const viewport = new TestNativeViewport({ ownerOf: (key: string) => key, get: () => undefined } as unknown as NativeChatProjection)
    const store = { read: () => null, save: vi.fn() }
    let owner!: ReturnType<typeof useChatScroll>
    let element!: HTMLDivElement
    const order = ['row']
    const turns = [{ turn: 1, anchorKey: 'row' }]
    function Harness({ ready, openingInputEnabled = true }: { ready: boolean; openingInputEnabled?: boolean }) {
        owner = useChatScroll({
            ready, openingInputEnabled, order: ready ? order : [], firstSeq: ready ? 1 : null,
            lastKey: ready ? 'row' : null, lastIsUser: false, steeringId: null,
            submissionId: null, running: false, loadedTurns: ready ? turns : [],
            chatScroll: store, hasMore: false, loadingOlder: false,
            loadOlder: vi.fn(), loadThrough: async () => {},
        }, viewport)
        return <div data-conversation-scroll ref={node => {
            owner.listRef.current = node
            if (!node) return
            element = node
            Object.defineProperties(node, {
                scrollTop: { configurable: true, get: () => geometry.top, set: value => {
                    geometry.top = Math.max(0, Math.min(geometry.floor, value))
                    geometry.writes.push(geometry.top)
                } },
                scrollHeight: { configurable: true, get: () => geometry.floor + geometry.height },
                clientHeight: { configurable: true, get: () => geometry.height },
            })
        }}><div ref={owner.columnRef} /></div>
    }
    const view = render(<Harness ready={false} />)
    const wheel = (delta: number, applyDefault = true, deliverScroll = true) => act(() => {
        element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: delta }))
        if (applyDefault) {
            const previous = geometry.top
            geometry.top = Math.max(0, Math.min(geometry.floor, previous + delta))
            if (deliverScroll && previous !== geometry.top) element.dispatchEvent(new Event('scroll'))
        }
    })
    const ready = (floor = 1000, notifyLayout = true) => act(() => {
        geometry.floor = floor
        view.rerender(<Harness ready />)
        if (notifyLayout) viewport.layoutCommitted()
    })
    const setCaptureEnabled = (enabled: boolean) => act(() => view.rerender(<Harness ready={false} openingInputEnabled={enabled} />))
    const resize = () => act(() => viewport.layoutCommitted())
    const scroll = () => act(() => element.dispatchEvent(new Event('scroll')))
    const input = (event: Event, target: HTMLElement = element) => act(() => { target.dispatchEvent(event) })
    const touch = (type: string, x: number, y: number, fingers = 1) => {
        const event = new Event(type, { bubbles: true })
        Object.defineProperty(event, 'touches', { value: type === 'touchend' ? []
            : Array.from({ length: fingers }, (_, id) => ({ identifier: id, clientX: x, clientY: y })) })
        input(event)
    }
    return { geometry, viewport, store, wheel, ready, resize, scroll, view, input, touch, setCaptureEnabled,
        element: () => element, owner: () => owner }
}

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('cold native reader input ownership', () => {
    it('control: no early input lands at the latest floor', () => {
        const f = fixture(); f.ready()
        expect(f.geometry.top).toBe(1000)
        expect(f.owner().reading.followingTail).toBe(true)
    })

    it('regression: retains upward input clamped before the first usable history range', () => {
        const f = fixture()
        f.wheel(-120)
        expect(f.geometry.top).toBe(0) // No browser displacement has happened.
        f.ready()
        expect(f.geometry.top).toBe(880)
        expect(f.owner().reading.followingTail).toBe(false)
    })

    it.each([
        { deltas: [-120, 40], expected: 920 },
        { deltas: [120, -40], expected: 960 }, // Down at the tail clamps before up.
        { deltas: [-120, 300, -40], expected: 960 },
        { deltas: [-2000, 40], expected: 40 }, // Clamp at each edge, not only after summation.
        { deltas: [-120, 120], expected: 1000 },
    ])('preserves ordered edge-clamping for $deltas', ({ deltas, expected }) => {
        const f = fixture()
        deltas.forEach(delta => f.wheel(delta))
        f.ready()
        expect(f.geometry.top).toBe(expected)
    })

    it('retains vertical single-finger touch movement, not merely touchstart', () => {
        const f = fixture()
        f.touch('touchstart', 100, 100)
        f.touch('touchmove', 100, 220)
        f.touch('touchend', 100, 220)
        f.ready()
        expect(f.geometry.top).toBe(880)
    })

    it('keeps ordered touch reversal and clamps each tail arrival', () => {
        const f = fixture()
        f.touch('touchstart', 100, 100)
        f.touch('touchmove', 100, 220) // up 120
        f.touch('touchmove', 100, -80) // down 300, clamped at tail
        f.touch('touchmove', 100, -40) // up 40
        f.touch('touchend', 100, -40)
        f.ready()
        expect(f.geometry.top).toBe(960)
    })

    it.each(['touchstart', 'horizontal', 'multi', 'cancel'])('does not replay %s touch input', mode => {
        const f = fixture()
        f.touch('touchstart', 100, 100, mode === 'multi' ? 2 : 1)
        if (mode === 'horizontal') f.touch('touchmove', 260, 120)
        if (mode === 'multi') f.touch('touchmove', 100, 220, 2)
        if (mode === 'cancel') { f.touch('touchmove', 100, 220); f.touch('touchcancel', 100, 220) }
        f.ready()
        expect(f.geometry.top).toBe(1000)
    })

    it.each(['second-start', 'second-move', 'horizontal', 'zoom'])('cancels earlier drag on %s takeover', mode => {
        const f = fixture()
        f.touch('touchstart', 100, 100); f.touch('touchmove', 100, 220)
        expect(f.owner().reading.openingPending).toBe(true)
        if (mode === 'second-start') f.touch('touchstart', 100, 220, 2)
        if (mode === 'second-move') f.touch('touchmove', 100, 240, 2)
        if (mode === 'horizontal') f.touch('touchmove', 260, 240)
        if (mode === 'zoom') f.input(new WheelEvent('wheel', { bubbles: true, ctrlKey: true, deltaY: -120 }))
        f.ready()
        expect(f.geometry.top).toBe(1000)
        expect(f.owner().reading.openingPending).toBe(false)
    })

    it('converts line and page wheel modes before ordered replay', () => {
        const f = fixture()
        f.element().style.lineHeight = '20px'
        f.input(new WheelEvent('wheel', { bubbles: true, deltaY: -3, deltaMode: 1 }))
        f.input(new WheelEvent('wheel', { bubbles: true, deltaY: -1, deltaMode: 2 }))
        f.ready()
        expect(f.geometry.top).toBe(340)
    })

    it.each([
        { ctrlKey: true, deltaY: -120 },
        { shiftKey: true, deltaY: -120 },
        { deltaX: 200, deltaY: -120 },
    ])('does not replay modified/horizontal wheel $ctrlKey $shiftKey $deltaX', init => {
        const f = fixture()
        f.input(new WheelEvent('wheel', { bubbles: true, ...init }))
        f.ready()
        expect(f.geometry.top).toBe(1000)
    })

    it.each(['textarea', 'button', 'pre', 'nested'])('does not take input from %s', kind => {
        const f = fixture()
        const child = document.createElement(kind === 'nested' ? 'div' : kind)
        if (kind === 'nested') child.style.overflowY = 'auto'
        f.element().appendChild(child)
        f.input(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }), child)
        f.ready()
        expect(f.geometry.top).toBe(1000)
    })

    it('scrolling keys cancel pending replay, while editor keys do not', () => {
        const f = fixture(); f.wheel(-120)
        f.input(new KeyboardEvent('keydown', { bubbles: true, key: 'Home' }))
        f.ready()
        expect(f.geometry.top).toBe(1000)
        const g = fixture(); g.wheel(-120)
        const editor = document.createElement('textarea'); g.element().appendChild(editor)
        g.input(new KeyboardEvent('keydown', { bubbles: true, key: 'Home' }), editor)
        g.ready()
        expect(g.geometry.top).toBe(880)
    })

    it('does not capture a wheel once the reader has usable range', () => {
        const f = fixture()
        f.geometry.floor = 1000; f.geometry.top = 1000
        f.wheel(-120, false)
        f.ready()
        expect(f.geometry.top).toBe(1000)
    })

    it('waits for measured initial-tail layout before consuming input', () => {
        const f = fixture(); let measured = false
        f.viewport.isOpeningLayoutReady = () => measured
        f.wheel(-120); f.ready()
        expect(f.owner().reading.openingPending).toBe(true)
        expect(f.geometry.top).toBe(1000)
        measured = true; f.resize()
        expect(f.geometry.top).toBe(880)
        expect(f.owner().reading.openingPending).toBe(false)
        f.resize()
        expect(f.geometry.top).toBe(880) // no replay on later layout
    })

    it('new actual native movement supersedes an opening queue awaiting layout', () => {
        const f = fixture(); f.viewport.isOpeningLayoutReady = () => false
        f.wheel(-120); f.ready()
        expect(f.owner().reading.openingPending).toBe(true)
        f.wheel(-80)
        expect(f.geometry.top).toBe(920)
        expect(f.owner().reading.openingPending).toBe(false)
        f.viewport.isOpeningLayoutReady = () => true
        f.resize()
        expect(f.geometry.top).toBe(920)
    })

    it.each([1, 2, 10, 12, 25])('finishes a %ipx near-tail replay at the floor without requiring another layout callback', delta => {
        const f = fixture(); f.wheel(-delta); f.ready(1000, false)
        expect(f.owner().reading.followingTail).toBe(true)
        expect(f.geometry.top).toBe(1000)
        expect(f.owner().reading.openingPending).toBe(false)
    })

    it('releases tail ownership at 26px and needs no extra callback', () => {
        const f = fixture(); f.wheel(-26); f.ready(1000, false)
        expect(f.geometry.top).toBe(974)
        expect(f.owner().reading.followingTail).toBe(false)
        expect(f.owner().reading.openingPending).toBe(false)
    })

    it('consumes queued input for empty-success geometry without hanging', () => {
        const f = fixture(); f.wheel(-120); f.ready(0, false)
        expect(f.owner().reading.initialized).toBe(true)
        expect(f.owner().reading.openingPending).toBe(false)
        expect(f.geometry.top).toBe(0)
    })

    it('explicit opening error cancellation discards replay before retry', () => {
        const f = fixture(); f.wheel(-120)
        f.owner().reading.cancelOpeningScroll()
        f.ready()
        expect(f.geometry.top).toBe(1000)
    })

    it('terminal error disables capture until a fresh loading attempt', () => {
        const f = fixture(); f.wheel(-120)
        f.setCaptureEnabled(false)
        expect(f.owner().reading.openingPending).toBe(false)
        f.wheel(-120)
        f.touch('touchstart', 100, 100); f.touch('touchmove', 100, 220)
        expect(f.owner().reading.openingPending).toBe(false)
        f.setCaptureEnabled(true); f.ready()
        expect(f.geometry.top).toBe(1000)
    })

    it('does not inspect touch target styles after history is ready', () => {
        const f = fixture(); f.ready()
        const styles = vi.spyOn(window, 'getComputedStyle')
        f.touch('touchstart', 100, 100); f.touch('touchmove', 100, 220)
        expect(styles).not.toHaveBeenCalled()
        styles.mockRestore()
    })

    it.each(['zoom', 'horizontal', 'nested', 'shift'])('cancels queued intent after estimated range appears on %s takeover', mode => {
        const f = fixture(); f.viewport.isOpeningLayoutReady = () => false
        f.wheel(-120); f.ready()
        expect(f.owner().reading.openingPending).toBe(true)
        let target = f.element()
        if (mode === 'nested') { target = document.createElement('div'); target.style.overflowY = 'auto'; f.element().appendChild(target) }
        f.input(new WheelEvent('wheel', { bubbles: true, deltaY: -120, ctrlKey: mode === 'zoom',
            shiftKey: mode === 'shift', deltaX: mode === 'horizontal' ? 200 : 0 }), target)
        expect(f.owner().reading.openingPending).toBe(false)
        f.viewport.isOpeningLayoutReady = () => true; f.resize()
        expect(f.geometry.top).toBe(1000)
    })

    it('consumes no-op downward input and complete reversal without remaining pending', () => {
        for (const deltas of [[120], [-120, 120]]) {
            const f = fixture(); deltas.forEach(delta => f.wheel(delta)); f.ready()
            expect(f.geometry.top).toBe(1000)
            expect(f.owner().reading.openingPending).toBe(false)
        }
    })

    it('control: delivered real reader movement blocks a later resize tail write', () => {
        const f = fixture(); f.ready()
        f.wheel(-120)
        expect(f.geometry.top).toBe(880)
        f.resize()
        expect(f.geometry.top).toBe(880)
    })

    it.skip('unconfirmed ordering diagnostic, outside cold-zero-range fix: does not overwrite compositor motion observed before its scroll event', () => {
        const f = fixture(); f.ready()
        // Model Chrome moving first, then delivering passive wheel, then scroll.
        f.geometry.top = 880
        f.wheel(-120, false)
        expect(f.geometry.top).toBe(880)
        f.resize()
        expect(f.geometry.top).toBe(880)
        f.scroll()
    })

    it('control: replacing the route discards the old reader intent', () => {
        const old = fixture(); old.wheel(-120); old.view.unmount()
        const next = fixture(); next.ready()
        expect(next.geometry.top).toBe(1000)
        expect(next.owner().reading.followingTail).toBe(true)
    })

    it('control: explicit return to latest replaces pending early intent', () => {
        const f = fixture(); f.wheel(-120)
        act(() => f.owner().returnToBottom())
        f.ready()
        expect(f.geometry.top).toBe(1000)
    })
})
