import { describe, it, expect } from 'bun:test'
import { appendUserTerminalOutput, getUserTerminalBuffer, clearUserTerminalBuffer, getUserTerminalReplay, MAX_TERMINAL_BUFFER_UNITS } from './userTerminalBuffer'

describe('userTerminalBuffer', () => {
    it('stores and retrieves output per terminal', () => {
        appendUserTerminalOutput('s1', 't1', 'hello ')
        appendUserTerminalOutput('s1', 't1', 'world')
        expect(getUserTerminalBuffer('s1', 't1')).toBe('hello world')
    })

    it('keeps sessions isolated', () => {
        appendUserTerminalOutput('sa', 't1', 'alpha')
        appendUserTerminalOutput('sb', 't1', 'beta')
        expect(getUserTerminalBuffer('sa', 't1')).toBe('alpha')
        expect(getUserTerminalBuffer('sb', 't1')).toBe('beta')
    })

    it('keeps independent terminals of the same session isolated', () => {
        appendUserTerminalOutput('s2', 'tA', 'output-from-A')
        appendUserTerminalOutput('s2', 'tB', 'output-from-B')
        // Each terminal replays only its own output — never the other shell's.
        expect(getUserTerminalBuffer('s2', 'tA')).toBe('output-from-A')
        expect(getUserTerminalBuffer('s2', 'tB')).toBe('output-from-B')
    })

    it('clearing one terminal does not wipe a sibling terminal of the same session', () => {
        appendUserTerminalOutput('s6', 'tA', 'keep-A')
        appendUserTerminalOutput('s6', 'tB', 'keep-B')
        clearUserTerminalBuffer('s6', 'tA')
        expect(getUserTerminalBuffer('s6', 'tA')).toBe('')
        expect(getUserTerminalBuffer('s6', 'tB')).toBe('keep-B')
    })

    it('returns empty string for unknown terminal', () => {
        expect(getUserTerminalBuffer('nonexistent', 't1')).toBe('')
    })

    it('ignores empty data', () => {
        appendUserTerminalOutput('s3', 't1', 'keep')
        appendUserTerminalOutput('s3', 't1', '')
        expect(getUserTerminalBuffer('s3', 't1')).toBe('keep')
    })

    it('clears buffer on demand', () => {
        appendUserTerminalOutput('s4', 't1', 'data')
        clearUserTerminalBuffer('s4', 't1')
        expect(getUserTerminalBuffer('s4', 't1')).toBe('')
    })

    it('rolls over at max size', () => {
        const small = 'a'.repeat(100)
        // Fill buffer to near capacity
        for (let i = 0; i < 2600; i++) {
            appendUserTerminalOutput('s5', 't1', small)
        }
        const buf = getUserTerminalBuffer('s5', 't1')
        // Should be at most MAX_BUFFER_BYTES (256KB)
        const MAX = 256 * 1024
        expect(buf.length).toBeLessThanOrEqual(MAX)
        // Should contain the most recent data (tail preserved)
        expect(buf.endsWith(small)).toBe(true)
    })
})

describe('userTerminalBuffer output cursors', () => {
    it('establishes an empty epoch and returns only the missing range', () => {
        const first = getUserTerminalReplay('cursor', 't1')
        expect(first.data).toBe(''); expect(first.stream.endOffset).toBe(0)
        const live = appendUserTerminalOutput('cursor', 't1', 'AAAA')
        expect(live.epoch).toBe(first.stream.epoch)
        expect(getUserTerminalReplay('cursor', 't1', { epoch: live.epoch, offset: 2 }).data).toBe('AA')
        expect(getUserTerminalReplay('cursor', 't1', { epoch: live.epoch, offset: 4 }).data).toBe('')
        clearUserTerminalBuffer('cursor', 't1')
    })
    it('reports bounded history gaps and epoch changes without pretending they are snapshots', () => {
        const first = appendUserTerminalOutput('cursor-gap', 't1', 'old')
        appendUserTerminalOutput('cursor-gap', 't1', 'x'.repeat(MAX_TERMINAL_BUFFER_UNITS + 5))
        const replay = getUserTerminalReplay('cursor-gap', 't1', { epoch: first.epoch, offset: 3 })
        expect(replay.stream.gap).toBe('history-truncated'); expect(replay.data).toBe('')
        expect(getUserTerminalReplay('cursor-gap', 't1').stream.truncated).toBe(true)
        clearUserTerminalBuffer('cursor-gap', 't1')
        expect(getUserTerminalReplay('cursor-gap', 't1', { epoch: first.epoch, offset: 3 }).stream.gap).toBe('epoch-changed')
        clearUserTerminalBuffer('cursor-gap', 't1')
    })
    it('does not leave a low surrogate at the trimmed replay head', () => {
        const text = '😀' + 'x'.repeat(MAX_TERMINAL_BUFFER_UNITS - 1)
        appendUserTerminalOutput('unicode', 't1', text)
        const replay = getUserTerminalReplay('unicode', 't1')
        expect(replay.stream.startOffset).toBe(2)
        expect(replay.stream.endOffset).toBe(text.length)
        expect(replay.data).toBe('x'.repeat(MAX_TERMINAL_BUFFER_UNITS - 1))
        clearUserTerminalBuffer('unicode', 't1')
    })
    it('retained cursors preserve surrogate and ANSI continuations across frames', () => {
        const first = appendUserTerminalOutput('unicode-split', 't1', '\x1b[3\uD83D')
        appendUserTerminalOutput('unicode-split', 't1', '\uDE001m')
        expect(getUserTerminalReplay('unicode-split', 't1', { epoch: first.epoch, offset: first.endOffset }).data).toBe('\uDE001m')
        clearUserTerminalBuffer('unicode-split', 't1')
    })
})
