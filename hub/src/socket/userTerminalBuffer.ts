import type { TerminalOutputCursor, TerminalOutputStream } from '@hapi/protocol'

// Offsets and the bounded tail use UTF-16 code units, matching String.slice.
// Each real removal discards the epoch; a detached/rebound viewer keeps it.
export const MAX_TERMINAL_BUFFER_UNITS = 256 * 1024

type BufferState = { epoch: string; data: string; start: number; end: number }
const buffers = new Map<string, BufferState>()
const keyFor = (sessionId: string, terminalId: string): string => `${sessionId}:${terminalId}`
function bufferFor(sessionId: string, terminalId: string): BufferState {
    const key = keyFor(sessionId, terminalId)
    let buffer = buffers.get(key)
    if (!buffer) {
        buffer = { epoch: crypto.randomUUID(), data: '', start: 0, end: 0 }
        buffers.set(key, buffer)
    }
    return buffer
}

export function appendUserTerminalOutput(sessionId: string, terminalId: string, data: string): TerminalOutputStream {
    const buffer = bufferFor(sessionId, terminalId)
    const startOffset = buffer.end
    buffer.end += data.length
    const next = buffer.data + data
    let trim = Math.max(0, next.length - MAX_TERMINAL_BUFFER_UNITS)
    // A new viewer must not begin with the low half of a retained surrogate pair.
    if (trim > 0 && /[\uDC00-\uDFFF]/.test(next[trim] ?? '') && /[\uD800-\uDBFF]/.test(next[trim - 1])) trim++
    buffer.data = next.slice(trim)
    buffer.start += trim
    return { version: 1, epoch: buffer.epoch, startOffset, endOffset: buffer.end, replay: false }
}

export function getUserTerminalReplay(sessionId: string, terminalId: string, cursor?: TerminalOutputCursor): { data: string; stream: TerminalOutputStream } {
    const buffer = bufferFor(sessionId, terminalId)
    const gap = cursor && (cursor.epoch !== buffer.epoch ? 'epoch-changed' : cursor.offset < buffer.start ? 'history-truncated' : cursor.offset > buffer.end ? 'cursor-ahead' : undefined)
    const startOffset = gap || !cursor ? buffer.start : cursor.offset
    return {
        data: gap ? '' : buffer.data.slice(startOffset - buffer.start),
        stream: { version: 1, epoch: buffer.epoch, startOffset, endOffset: buffer.end, replay: true,
            ...(buffer.start > 0 && !cursor ? { truncated: true } : {}), ...(gap ? { gap } : {}) }
    }
}

export function getUserTerminalBuffer(sessionId: string, terminalId: string): string {
    return buffers.get(keyFor(sessionId, terminalId))?.data ?? ''
}
export function clearUserTerminalBuffer(sessionId: string, terminalId: string): void {
    buffers.delete(keyFor(sessionId, terminalId))
}
