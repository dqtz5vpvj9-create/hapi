import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalOutputStream } from '@hapi/protocol'
const sockets = vi.hoisted(() => [] as any[])
vi.mock('socket.io-client', () => ({ Manager: class {
    socket(_namespace: string, options: unknown) {
        const handlers = new Map<string, (payload?: any) => void>()
        const socket = { connected: false, auth: options, emitted: [] as any[], on(event: string, handler: any) { handlers.set(event, handler); return this },
            emit(event: string, payload: unknown) { this.emitted.push({ event, payload }) },
            connect() { this.connected = true; handlers.get('connect')?.() },
            disconnect() { this.connected = false; handlers.get('disconnect')?.('io client disconnect') },
            removeAllListeners() { handlers.clear() },
            trigger(event: string, payload: unknown) { handlers.get(event)?.(payload) } }
        sockets.push(socket); return socket
    }
} }))
import { useTerminalSocket } from './useTerminalSocket'
const options = { sessionId: 's1', terminalId: 't1', token: 'synthetic', baseUrl: 'http://fixture' }
const frame = (startOffset: number, data: string, extra: Partial<TerminalOutputStream> = {}): TerminalOutputStream => ({ version: 1, epoch: 'one', startOffset, endOffset: startOffset + data.length, replay: false, ...extra })
beforeEach(() => { sockets.length = 0 })
function setup() {
    const hook = renderHook(() => useTerminalSocket(options)); const writes: string[] = []
    act(() => { hook.result.current.onOutput(data => { writes.push(data); return true }); hook.result.current.connect(80, 24) })
    const socket = sockets[0]
    const output = (data: string, stream?: TerminalOutputStream) => act(() => socket.trigger('terminal:output', { terminalId: 't1', data, stream }))
    const ready = (replayProtocol?: 1) => act(() => socket.trigger('terminal:ready', { terminalId: 't1', replayProtocol }))
    return { ...hook, socket, writes, output, ready }
}
describe('useTerminalSocket replay protocol', () => {
    it('sends v1 create, resumes its accepted cursor and does not duplicate replay', () => {
        const h = setup(); expect(h.socket.emitted[0].payload.replayProtocol).toBe(1)
        h.output('A', frame(0, 'A', { replay: true })); h.ready(1)
        act(() => { h.socket.disconnect(); h.socket.connect() })
        expect(h.socket.emitted.at(-1).payload.outputCursor).toEqual({ epoch: 'one', offset: 1 })
        h.output('AB', frame(0, 'AB', { replay: true })); h.ready(1)
        expect(h.writes.join('')).toBe('AB'); h.unmount()
    })
    it('blocks direct input until ready and continuity, including ready before replay', () => {
        const h = setup(); act(() => h.result.current.write('too early'))
        h.ready(1); act(() => h.result.current.write('still no handshake'))
        expect(h.socket.emitted.filter((x: any) => x.event === 'terminal:write')).toHaveLength(0)
        h.output('', frame(0, '', { replay: true })); act(() => h.result.current.write('allowed'))
        expect(h.socket.emitted.filter((x: any) => x.event === 'terminal:write').map((x: any) => x.payload.data)).toEqual(['allowed']); h.unmount()
    })
    it('late ready cannot reopen a gap; fresh receiver reattaches same id without close', () => {
        const h = setup(); h.output('A', frame(0, 'A', { replay: true })); h.ready(1)
        h.output('', frame(100, '', { replay: true, gap: 'history-truncated' })); h.ready(1)
        act(() => h.result.current.write('blocked'))
        expect(h.result.current.outputIssue).toBe('gap'); expect(h.socket.emitted.some((x: any) => x.event === 'terminal:write')).toBe(false)
        act(() => h.result.current.resetOutputReceiver())
        const replacement = sockets.at(-1)
        expect(replacement).not.toBe(h.socket)
        const create = replacement.emitted.at(-1); expect(create.event).toBe('terminal:create'); expect(create.payload.terminalId).toBe('t1'); expect(create.payload.outputCursor).toBeUndefined()
        expect(h.socket.emitted.some((x: any) => x.event === 'terminal:close')).toBe(false)
        act(() => { replacement.trigger('terminal:output', { terminalId: 't1', data: 'tail', stream: frame(100, 'tail', { replay: true, truncated: true }) }); replacement.trigger('terminal:ready', { terminalId: 't1', replayProtocol: 1 }) })
        expect(h.result.current.outputIssue).toBe('truncated'); act(() => h.result.current.write('ok'))
        expect(replacement.emitted.at(-1).payload.data).toBe('ok'); h.unmount()
    })
    it('legacy Hub initial attach works and retained reconnect pauses until explicit reopen', () => {
        const h = setup(); h.output('old'); h.ready(); act(() => h.result.current.write('first'))
        act(() => { h.socket.disconnect(); h.socket.connect() }); h.output('old and new'); h.ready(); act(() => h.result.current.write('blocked'))
        expect(h.writes.join('')).toBe('old'); expect(h.result.current.outputIssue).toBe('legacy')
        expect(h.socket.emitted.filter((x: any) => x.event === 'terminal:write')).toHaveLength(1); h.unmount()
    })
})
