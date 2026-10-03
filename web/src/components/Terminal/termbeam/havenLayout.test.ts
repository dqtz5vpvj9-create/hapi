import { describe, expect, it } from 'vitest'
import { alignedColumns, placeKey, toolbarRows } from './havenLayout'
import { DEFAULT_TOUCHBAR_KEYS } from './defaultKeys'
import { exportLayout, importLayout, parseSendSequence } from './keyCatalog'
import { applyTerminalModifiers } from '../useTerminalKeys'

describe('Haven layout semantics', () => {
    it('pairs navigation independently of saved row and position, including a missing counterpart', () => {
        const keys = DEFAULT_TOUCHBAR_KEYS.filter(key => key.id !== 'down').map(key => key.id === 'up' ? { ...key, row: 2 as const, col: 1 } : key)
        const columns = alignedColumns(keys)
        expect(columns.find(column => column[0]?.id === 'up')).toEqual([expect.objectContaining({ id: 'up' }), undefined])
        expect(columns.find(column => column[0]?.id === 'home')?.[1]?.id).toBe('left')
        expect(columns.filter(column => column.some(key => key?.id === 'up'))).toHaveLength(1)
    })
    it('moves a key between rows without resetting other keys, and preserves hidden macros', () => {
        const before = toolbarRows(DEFAULT_TOUCHBAR_KEYS)[0]!.map(key => key.id).filter(id => id !== 'esc')
        let keys = placeKey(DEFAULT_TOUCHBAR_KEYS, 'esc', 2, 'ctrl')
        expect(toolbarRows(keys)[0]!.map(key => key.id)).toEqual(before)
        expect(toolbarRows(keys)[1]!.map(key => key.id)).toEqual(['enter', 'ctrl-d', 'shift', 'esc', 'ctrl', 'snippets', 'left', 'down', 'right'])
        keys = placeKey(keys, 'ctrl-d', 0)
        expect(keys.find(key => key.id === 'ctrl-d')?.send).toBe('\x04')
        expect(toolbarRows(keys).flat().some(key => key.id === 'ctrl-d')).toBe(false)
    })
    it('imports Haven built-in IDs and round-trips multi-command macros without changing bytes', () => {
        const keys = importLayout('[["keyboard","esc_key","sym_pipe"],[{"label":"run","send":"echo one\\r\\u001b[A"},"arrow_left"]]')
        expect(keys.find(key => key.label === 'run')?.send).toBe('echo one\r\x1b[A')
        expect(JSON.parse(exportLayout(keys))).toEqual(JSON.parse('[["keyboard","esc_key","sym_pipe"],[{"label":"run","send":"echo one\\r\\u001b[A"},"arrow_left"]]'))
        expect(() => importLayout('[["unknown-key"]]')).toThrow('Unknown key')
    })
    it('parses literal text with escaped terminal bytes and encodes modified function keys', () => {
        expect(parseSendSequence('你好\\r\\e[A\\x03\\u0004\\\\n')).toBe('你好\r\x1b[A\x03\x04\\n')
        expect(applyTerminalModifiers('\x1bOP', { ctrl: true, alt: false, shift: false })).toBe('\x1b[1;5P')
    })
})
