import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { HistoryPageRequest } from '@/lib/history-page-repository'
import { useHistoryPreload } from './useHistoryPreload'

const mocks = vi.hoisted(() => ({
    request: vi.fn(),
    subscribe: vi.fn(),
    read: vi.fn(),
    cached: vi.fn(),
}))
vi.mock('@/lib/message-window-store', () => ({
    getHistoryPreloadRequest: mocks.request,
    subscribeMessageWindow: mocks.subscribe,
}))
vi.mock('@/lib/history-page-repository', () => ({
    getHistoryPageRepository: () => ({ read: mocks.read, getCached: mocks.cached }),
}))

const api = {} as ApiClient
const beforeRequest: HistoryPageRequest = { direction: 'before', cursor: { at: 100, seq: 100 }, epoch: 1 }
const afterRequest: HistoryPageRequest = { direction: 'after', cursor: { at: 200, seq: 200 }, until: { at: 300, seq: 300 }, epoch: 1 }
let now = 0
let notify = () => {}
let nextFrame = 0
let frames: Map<number, FrameRequestCallback>

function reader(initial: { visible?: boolean; height?: number; top?: number; scrollHeight?: number } = {}) {
    const layout = { visible: true, height: 600, top: 100, scrollHeight: 10_000, ...initial }
    const element = document.createElement('div')
    Object.defineProperties(element, {
        clientHeight: { get: () => layout.visible ? layout.height : 0 },
        scrollTop: { get: () => layout.visible ? layout.top : 0 },
        scrollHeight: { get: () => layout.visible ? layout.scrollHeight : 0 },
        getClientRects: { value: () => layout.visible ? [new DOMRect(0, 0, 390, layout.height)] : [] },
    })
    return { layout, ref: { current: element } }
}

function flushFrame() {
    act(() => {
        const pending = [...frames.values()]
        frames.clear()
        for (const callback of pending) callback(now)
    })
}
function publish() {
    act(() => notify())
    flushFrame()
}

beforeEach(() => {
    vi.clearAllMocks()
    now = 5000
    nextFrame = 0
    frames = new Map()
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        const id = ++nextFrame
        frames.set(id, callback)
        return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    mocks.request.mockImplementation((_session: string, direction: string) => direction === 'before' ? beforeRequest : afterRequest)
    mocks.subscribe.mockImplementation((_session: string, listener: () => void) => {
        notify = listener
        return () => { notify = () => {} }
    })
    mocks.cached.mockReturnValue(undefined)
    mocks.read.mockImplementation(() => new Promise(() => {}))
})
afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('history preload geometry', () => {
    it.each(['before', 'after'] as const)('does not treat a hidden reader as near the %s boundary', direction => {
        const { layout, ref } = reader({ top: 5000 })
        const { result } = renderHook(() => useHistoryPreload(api, 'reader', ref))
        act(() => result.current.input(direction, 20))
        flushFrame()
        expect(mocks.read).not.toHaveBeenCalled()

        // A live store update occurs while Terminal retains the reader under
        // display:none, still inside the most recent gesture's intent window.
        now += 700
        layout.visible = false
        publish()
        expect(mocks.read).not.toHaveBeenCalled()

        layout.visible = true
        publish()
        expect(mocks.read).not.toHaveBeenCalled()
        layout.top = direction === 'before' ? 100 : 9000
        act(() => result.current.input(direction, 20))
        flushFrame()
        expect(mocks.read).toHaveBeenCalledExactlyOnceWith('reader', direction === 'before' ? beforeRequest : afterRequest)
    })

    it('rechecks visibility when a scheduled frame runs and resumes valid nearby intent', () => {
        const { layout, ref } = reader()
        const { result } = renderHook(() => useHistoryPreload(api, 'reader', ref))
        act(() => result.current.input('before', 20))
        layout.visible = false
        flushFrame()
        expect(mocks.read).not.toHaveBeenCalled()

        layout.visible = true
        now += 100
        publish()
        expect(mocks.read).toHaveBeenCalledExactlyOnceWith('reader', beforeRequest)
    })

    it('does not use a zero-height layout rectangle as edge evidence', () => {
        const { layout, ref } = reader({ height: 0, top: 0, scrollHeight: 0 })
        expect(ref.current.getClientRects().length).toBe(1)
        const { result } = renderHook(() => useHistoryPreload(api, 'reader', ref))
        act(() => result.current.input('before', 20))
        flushFrame()
        expect(mocks.read).not.toHaveBeenCalled()

        layout.height = 600
        layout.scrollHeight = 10_000
        publish()
        expect(mocks.read).toHaveBeenCalledExactlyOnceWith('reader', beforeRequest)
    })

    it('does not renew expired input during hide and reveal', () => {
        const { layout, ref } = reader({ top: 5000 })
        const { result } = renderHook(() => useHistoryPreload(api, 'reader', ref))
        act(() => result.current.input('before', 20))
        flushFrame()
        layout.visible = false
        now += 1200
        publish()
        layout.visible = true
        layout.top = 100
        publish()
        expect(mocks.read).not.toHaveBeenCalled()
        act(() => result.current.input('before', 20))
        flushFrame()
        expect(mocks.read).toHaveBeenCalledExactlyOnceWith('reader', beforeRequest)
    })

    it('preserves explicit initial background warmup without geometry or input', () => {
        const { ref } = reader({ visible: false })
        renderHook(() => useHistoryPreload(api, 'reader', ref, true))
        expect(mocks.read).toHaveBeenCalledExactlyOnceWith('reader', beforeRequest)
        publish()
        expect(mocks.read).toHaveBeenCalledTimes(1)
    })

    it('lets an in-flight preload finish but does not chain from hidden geometry', async () => {
        let finish!: () => void
        mocks.read.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
        const { layout, ref } = reader()
        const { result } = renderHook(() => useHistoryPreload(api, 'reader', ref))
        act(() => result.current.input('before', 20))
        flushFrame()
        expect(mocks.read).toHaveBeenCalledTimes(1)
        const nextRequest = { ...beforeRequest, cursor: { at: 50, seq: 50 } }
        mocks.request.mockReturnValue(nextRequest)
        layout.visible = false
        publish()
        await act(async () => { finish(); await Promise.resolve() })
        flushFrame()
        expect(mocks.read).toHaveBeenCalledTimes(1)

        layout.visible = true
        publish()
        expect(mocks.read).toHaveBeenCalledTimes(2)
        expect(mocks.read).toHaveBeenLastCalledWith('reader', nextRequest)
    })

    it('still respects cache hits and same-frontier deduplication', () => {
        mocks.cached.mockReturnValue({ messages: [] })
        const { ref } = reader()
        const { result } = renderHook(() => useHistoryPreload(api, 'reader', ref))
        act(() => result.current.input('before', 20))
        flushFrame()
        publish()
        expect(mocks.cached).toHaveBeenCalledExactlyOnceWith('reader', beforeRequest)
        expect(mocks.read).not.toHaveBeenCalled()
    })
})
