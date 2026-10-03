import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSessionReconnectingState } from './useSessionReconnectingState'
import { RECONNECTING_BANNER_DELAY_MS } from './useReconnectingState'

afterEach(() => vi.useRealTimers())
describe('session stream reconnect visibility', () => {
    it('exposes a session-only outage after the existing grace period and clears on handshake', () => {
        vi.useFakeTimers()
        const { result } = renderHook(() => useSessionReconnectingState('session-1'))
        act(() => result.current.reportDisconnect('transport-error'))
        expect(result.current.isReconnecting).toBe(false)
        act(() => vi.advanceTimersByTime(RECONNECTING_BANNER_DELAY_MS))
        const globalDisconnected = false
        expect(globalDisconnected || result.current.isReconnecting).toBe(true)
        expect(result.current.reason).toBe('transport-error')
        act(() => result.current.reportConnect())
        expect(globalDisconnected || result.current.isReconnecting).toBe(false)
    })
    it('drops pending and visible outage state on route changes', () => {
        vi.useFakeTimers()
        const { result, rerender } = renderHook(({ id }) => useSessionReconnectingState(id), { initialProps: { id: 'first' as string | null } })
        act(() => result.current.reportDisconnect('closed'))
        rerender({ id: 'second' })
        act(() => vi.advanceTimersByTime(RECONNECTING_BANNER_DELAY_MS))
        expect(result.current.isReconnecting).toBe(false)
        act(() => result.current.reportDisconnect('closed'))
        act(() => vi.advanceTimersByTime(RECONNECTING_BANNER_DELAY_MS))
        expect(result.current.isReconnecting).toBe(true)
        rerender({ id: null })
        expect(result.current.isReconnecting).toBe(false)
    })
})
