import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_TERMINAL_TOOL_DISPLAY_MODE,
    getInitialTerminalToolDisplayMode,
    getTerminalToolDisplayModeOptions,
    useTerminalToolDisplayMode,
} from './useTerminalToolDisplayMode'

describe('useTerminalToolDisplayMode helpers', () => {
    beforeEach(() => {
        window.localStorage.clear()
    })

    it('returns the allowed terminal tool display options', () => {
        expect(getTerminalToolDisplayModeOptions()).toEqual([
            { value: 'compact', labelKey: 'settings.chat.terminalToolDisplay.compact' },
            { value: 'detailed', labelKey: 'settings.chat.terminalToolDisplay.detailed' },
        ])
    })

    it('falls back to the default display mode for missing or invalid storage values', () => {
        expect(DEFAULT_TERMINAL_TOOL_DISPLAY_MODE).toBe('detailed')
        expect(getInitialTerminalToolDisplayMode()).toBe(DEFAULT_TERMINAL_TOOL_DISPLAY_MODE)

        window.localStorage.setItem('hapi-terminal-tool-display-mode', 'invalid')
        expect(getInitialTerminalToolDisplayMode()).toBe(DEFAULT_TERMINAL_TOOL_DISPLAY_MODE)
    })

    it.each(['compact', 'detailed'] as const)('preserves a stored %s preference', mode => {
        window.localStorage.setItem('hapi-terminal-tool-display-mode', mode)
        expect(getInitialTerminalToolDisplayMode()).toBe(mode)
    })

    it('retains an explicit compact choice across hook remounts', () => {
        const first = renderHook(() => useTerminalToolDisplayMode())
        expect(first.result.current.terminalToolDisplayMode).toBe('detailed')
        act(() => first.result.current.setTerminalToolDisplayMode('compact'))
        expect(window.localStorage.getItem('hapi-terminal-tool-display-mode')).toBe('compact')
        first.unmount()

        const reopened = renderHook(() => useTerminalToolDisplayMode())
        expect(reopened.result.current.terminalToolDisplayMode).toBe('compact')
        act(() => reopened.result.current.setTerminalToolDisplayMode('detailed'))
        expect(window.localStorage.getItem('hapi-terminal-tool-display-mode')).toBeNull()
        expect(reopened.result.current.terminalToolDisplayMode).toBe('detailed')
    })
})
