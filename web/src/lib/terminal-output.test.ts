import { describe, expect, it } from 'vitest'
import { TerminalOutputTracker } from './terminal-output'
import type { TerminalOutputStream } from '@hapi/protocol'
const frame = (startOffset: number, data: string, extra: Partial<TerminalOutputStream> = {}): TerminalOutputStream => ({ version: 1, epoch: 'one', startOffset, endOffset: startOffset + data.length, replay: false, ...extra })
function harness() { const tracker = new TerminalOutputTracker(), writes: string[] = []; const write = (data: string) => { writes.push(data); return true }; return { tracker, writes, write } }

describe('terminal output continuity', () => {
    it('uses an empty replay handshake before live output', () => {
        const h = harness(); h.tracker.receive('', frame(0, '', { replay: true }), h.write)
        h.tracker.receive('A', frame(0, 'A'), h.write)
        expect(h.tracker.cursor).toEqual({ epoch: 'one', offset: 1 }); expect(h.writes.join('')).toBe('A')
    })
    it('deduplicates full and overlapping replays by position, not text', () => {
        const h = harness(); h.tracker.receive('same', frame(0, 'same', { replay: true }), h.write)
        h.tracker.receive('samesame', frame(0, 'samesame', { replay: true }), h.write)
        h.tracker.receive('samesame', frame(0, 'samesame', { replay: true }), h.write)
        expect(h.writes.join('')).toBe('samesame'); expect(h.tracker.cursor?.offset).toBe(8)
    })
    it('accepts repeated reconnect catch-up and interleaved live exactly once', () => {
        const h = harness(); h.tracker.receive('', frame(0, '', { replay: true }), h.write)
        for (let i = 0; i < 4; i++) { h.tracker.reconnect(); h.tracker.receive('x', frame(i, 'x', { replay: true }), h.write); h.tracker.receive('x', frame(i, 'x'), h.write) }
        expect(h.writes.join('')).toBe('xxxx'); expect(h.tracker.blocked).toBe(false)
    })
    it('preserves split ANSI and split Unicode frames without content filtering', () => {
        const h = harness(); h.tracker.receive('\x1b[3', frame(0, '\x1b[3', { replay: true }), h.write)
        h.tracker.receive('1m\uD83D', frame(3, '1m\uD83D'), h.write)
        h.tracker.reconnect(); h.tracker.receive('\uDE00\x1b[0m', frame(6, '\uDE00\x1b[0m', { replay: true }), h.write)
        expect(h.writes.join('')).toBe('\x1b[31m😀\x1b[0m')
    })
    it('keeps old writes on a gap and suppresses all later output until explicit reset', () => {
        const h = harness(); h.tracker.receive('old history', frame(0, 'old history', { replay: true }), h.write)
        h.tracker.receive('', frame(100, '', { replay: true, gap: 'history-truncated' }), h.write)
        h.tracker.receive('later', frame(100, 'later'), h.write); h.tracker.reconnect()
        expect(h.writes.join('')).toBe('old history'); expect(h.tracker.blocked).toBe(true); expect(h.tracker.cursor?.offset).toBe(11)
        h.tracker.reset(); h.tracker.receive('tail', frame(100, 'tail', { replay: true, truncated: true }), h.write)
        expect(h.tracker.blocked).toBe(false); expect(h.tracker.issue).toBe('truncated'); expect(h.tracker.cursor?.offset).toBe(104)
    })
    it('rejects epoch changes, cursor holes, and invalid ranges', () => {
        for (const next of [frame(1, 'B', { epoch: 'two' }), frame(2, 'B'), frame(1, 'B', { endOffset: 99 })]) {
            const h = harness(); h.tracker.receive('A', frame(0, 'A', { replay: true }), h.write); h.tracker.receive('B', next, h.write)
            expect(h.tracker.issue).toBe('gap'); expect(h.writes.join('')).toBe('A')
        }
    })
    it('legacy initial display works but reconnect cannot silently append full replay', () => {
        const h = harness(); h.tracker.receive('A', undefined, h.write); h.tracker.reconnect(); h.tracker.receive('AB', undefined, h.write)
        expect(h.writes.join('')).toBe('A'); expect(h.tracker.issue).toBe('legacy')
        h.tracker.reset(); h.tracker.receive('AB', undefined, h.write); expect(h.tracker.blocked).toBe(false)
    })
    it('does not advance without a receiver; fresh receiver starts without a cursor', () => {
        const h = harness(); h.tracker.receive('A', frame(0, 'A', { replay: true }), () => false); expect(h.tracker.cursor).toBeUndefined()
        h.tracker.receive('A', frame(0, 'A', { replay: true }), h.write); h.tracker.reset(); expect(h.tracker.cursor).toBeUndefined()
        h.tracker.receive('AB', frame(0, 'AB', { replay: true }), h.write); expect(h.tracker.cursor?.offset).toBe(2)
    })
    it('tracks accepted queued writes before ready or reconnect', () => {
        const tracker = new TerminalOutputTracker(), queued: string[] = []
        tracker.receive('A', frame(0, 'A', { replay: true }), data => { queued.push(data) })
        tracker.reconnect(); tracker.receive('AB', frame(0, 'AB', { replay: true }), data => { queued.push(data) })
        expect(queued).toEqual(['A', 'B']); expect(tracker.cursor?.offset).toBe(2)
    })
})
