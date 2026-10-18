import { StrictMode, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_UPDATE_CHECK_INTERVAL_MS, useNativeUpdate } from './useNativeUpdate'
import { prepareNativeUpdateReload } from '@/lib/nativeUpdateReload'

const mocks = vi.hoisted(() => ({
    initialize: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    apply: vi.fn(async (_prepare?: () => Promise<void>) => {}),
    dispose: vi.fn(),
    state: { status: 'idle', needRefresh: false, progress: null, error: null, version: null },
    listeners: new Set<() => void>(),
}))
vi.mock('@/lib/nativeUpdate', () => ({
    NativeUpdateController: class {
        initialize = mocks.initialize
        check = mocks.check
        apply = mocks.apply
        dispose = mocks.dispose
        getSnapshot = () => mocks.state
        subscribe = (listener: () => void) => {
            mocks.listeners.add(listener)
            return () => { mocks.listeners.delete(listener) }
        }
    },
}))
vi.mock('@/lib/nativeUpdateReload', () => ({ prepareNativeUpdateReload: vi.fn(async () => {}) }))

describe('useNativeUpdate', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
        vi.clearAllMocks()
        mocks.initialize.mockResolvedValue(undefined)
        mocks.listeners.clear()
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    })
    afterEach(() => { vi.useRealTimers() })

    it('acknowledges mounted-shell readiness before checking the update feed', async () => {
        let ready!: () => void
        mocks.initialize.mockReturnValueOnce(new Promise(resolve => { ready = resolve }))
        const { result } = renderHook(() => useNativeUpdate())
        expect(mocks.initialize).toHaveBeenCalledOnce()
        expect(mocks.check).not.toHaveBeenCalled()
        await act(async () => { ready() })
        expect(mocks.check).toHaveBeenCalledOnce()
        expect(result.current.native).toBe(true)
        expect(mocks.apply).not.toHaveBeenCalled()
    })

    it('checks on visibility, reconnection and the periodic timer, without applying', async () => {
        const { unmount } = renderHook(() => useNativeUpdate())
        await act(async () => {})
        mocks.check.mockClear()
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
        act(() => { document.dispatchEvent(new Event('visibilitychange')) })
        expect(mocks.check).not.toHaveBeenCalled()
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
        act(() => { document.dispatchEvent(new Event('visibilitychange')) })
        act(() => { window.dispatchEvent(new Event('online')) })
        act(() => { vi.advanceTimersByTime(NATIVE_UPDATE_CHECK_INTERVAL_MS) })
        expect(mocks.check).toHaveBeenCalledTimes(3)
        expect(mocks.apply).not.toHaveBeenCalled()
        unmount()
        await Promise.resolve()
        expect(mocks.dispose).toHaveBeenCalledOnce()
        act(() => {
            document.dispatchEvent(new Event('visibilitychange'))
            window.dispatchEvent(new Event('online'))
            vi.advanceTimersByTime(NATIVE_UPDATE_CHECK_INTERVAL_MS)
        })
        expect(mocks.check).toHaveBeenCalledTimes(3)
        expect(mocks.listeners.size).toBe(0)
    })

    it('passes draft and route preparation only to explicit activation', async () => {
        const { result } = renderHook(() => useNativeUpdate())
        await act(async () => {})
        act(() => result.current.retry())
        expect(mocks.apply).not.toHaveBeenCalled()
        act(() => result.current.reload())
        expect(mocks.apply).toHaveBeenCalledExactlyOnceWith(prepareNativeUpdateReload)
    })

    it('survives StrictMode effect remount and disposes on the final unmount', async () => {
        const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
        const { unmount } = renderHook(() => useNativeUpdate(), { wrapper })
        await act(async () => {})
        expect(mocks.dispose).not.toHaveBeenCalled()
        expect(mocks.check).toHaveBeenCalledOnce()
        unmount()
        await Promise.resolve()
        expect(mocks.dispose).toHaveBeenCalledOnce()
    })
})
