import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { applyTerminalModifiers, useTerminalKeys } from './useTerminalKeys'

describe('terminal modifier sequences', () => {
    it('encodes Shift+Left for Codex follow-ups and Ctrl+arrows for shell navigation', () => {
        expect(applyTerminalModifiers('\u001b[D', { shift: true, ctrl: false, alt: false })).toBe('\u001b[1;2D')
        expect(applyTerminalModifiers('\u001bOC', { shift: false, ctrl: true, alt: false })).toBe('\u001b[1;5C')
        expect(applyTerminalModifiers('\u001b[5~', { shift: true, ctrl: true, alt: false })).toBe('\u001b[5;6~')
        expect(applyTerminalModifiers('\t', { shift: true, ctrl: false, alt: false })).toBe('\u001b[Z')
    })

    it('applies Ctrl before Alt for combined letter chords', () => {
        expect(applyTerminalModifiers('c', { shift: false, ctrl: true, alt: true })).toBe('\u001b\u0003')
        expect(applyTerminalModifiers(' ', { shift: false, ctrl: true, alt: false })).toBe('\u0000')
        expect(applyTerminalModifiers('你好', { shift: false, ctrl: false, alt: false })).toBe('你好')
    })

    it('respects application cursor mode for unmodified toolbar arrows', () => {
        expect(applyTerminalModifiers('\u001b[D', { shift: false, ctrl: false, alt: false }, true)).toBe('\u001bOD')
        expect(applyTerminalModifiers('\u001b[D', { shift: true, ctrl: false, alt: false }, true)).toBe('\u001b[1;2D')
    })

    it('lets a mounted terminal callback consume current modifiers once', () => {
        const send = vi.fn()
        const { result } = renderHook(() => useTerminalKeys(send))
        const mountedDispatch = result.current.dispatch
        act(() => { result.current.toggleModifier('shift') })
        act(() => { mountedDispatch('\u001b[D'); mountedDispatch('\u001b[D') })
        expect(send.mock.calls).toEqual([['\u001b[1;2D'], ['\u001b[D']])
        expect(result.current.shiftActive).toBe(false)
    })

    it('keeps a locked modifier through keys until it is tapped or explicitly cleared', () => {
        const send = vi.fn()
        const { result } = renderHook(() => useTerminalKeys(send))
        act(() => { result.current.lockModifier('ctrl') })
        act(() => { result.current.dispatch('c'); result.current.dispatch('d') })
        expect(send.mock.calls).toEqual([['\x03'], ['\x04']])
        expect(result.current.lockedModifiers.ctrl).toBe(true)
        act(() => { result.current.toggleModifier('ctrl'); result.current.dispatch('c') })
        expect(send).toHaveBeenLastCalledWith('c')
        act(() => { result.current.lockModifier('alt'); result.current.resetModifiers(); result.current.dispatch('x') })
        expect(send).toHaveBeenLastCalledWith('x')
    })
})
