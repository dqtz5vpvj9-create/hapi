import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { useSessionListOrder } from './useSessionListOrder'

const session = (id: string, updatedAt: number) => ({ id, updatedAt }) as SessionSummary

describe('useSessionListOrder unchanged-input work', () => {
    it.each([100, 1000])('does not rescan %i unchanged IDs on parent renders', count => {
        const sessions = Array.from({ length: count }, (_, i) => session(String(i), i))
        const scan = vi.spyOn(sessions, 'some')
        const { result, rerender } = renderHook(() => useSessionListOrder(sessions, 'hub'))
        expect(scan).toHaveBeenCalledTimes(1)
        const compare = result.current.compare
        scan.mockClear()
        for (let i = 0; i < 5; i++) rerender()
        expect(scan).not.toHaveBeenCalled()
        expect(result.current.compare).toBe(compare)
    })

    it('retains frozen ordering across updates/removal/reappearance and refreshes explicitly', () => {
        const original = [session('a', 10), session('b', 20)]
        const { result, rerender } = renderHook(({ sessions, hub }) => useSessionListOrder(sessions, hub), {
            initialProps: { sessions: original, hub: 'one' }
        })
        const updated = [session('a', 30), session('b', 40)]
        const scan = vi.spyOn(updated, 'some')
        rerender({ sessions: updated, hub: 'one' })
        expect(scan).toHaveBeenCalledTimes(1)
        expect(result.current.timeFor(updated[0])).toBe(10)
        expect(result.current.compare(updated[0], updated[1])).toBeGreaterThan(0)
        rerender({ sessions: [updated[1]], hub: 'one' })
        const added = [...updated, session('c', 50)]
        rerender({ sessions: added, hub: 'one' })
        expect(result.current.timeFor(added[0])).toBe(10)
        expect(result.current.timeFor(added[2])).toBe(50)
        act(() => result.current.refreshOrder())
        expect(result.current.timeFor(added[0])).toBe(30)
        const nextHub = [session('a', 70), session('d', 80)]
        rerender({ sessions: nextHub, hub: 'two' })
        expect(result.current.timeFor(nextHub[0])).toBe(70)
        expect(result.current.timeFor(nextHub[1])).toBe(80)
        // Hub reset drops the old snapshot; reappearing IDs seed fresh clocks.
        rerender({ sessions: [...nextHub, session('b', 90)], hub: 'two' })
        expect(result.current.timeFor(session('b', 90))).toBe(90)
    })
})
