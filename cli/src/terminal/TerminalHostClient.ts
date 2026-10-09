import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws-node'
import type { MachineTerminalCommand, MachineTerminalEvent, MachineTerminalResponse, MachineTerminalResult } from '@hapi/protocol/terminals'
import type { TerminalHostAddress } from './terminalHostServer'

/** Local machine transport. Input is deliberately never buffered or retried. */
export class TerminalHostClient {
    private readonly pending = new Map<string, { resolve: (value: MachineTerminalResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
    private readonly listeners = new Set<(event: MachineTerminalEvent) => void>()
    private readonly closeListeners = new Set<() => void>()
    private constructor(private readonly socket: WebSocket, readonly instanceId: string) {
        socket.on('message', data => {
            const message = JSON.parse(data.toString()) as MachineTerminalResponse | { event: MachineTerminalEvent }
            if ('event' in message) { for (const listener of this.listeners) listener(message.event); return }
            const pending = this.pending.get(message.requestId)
            if (!pending) return
            this.pending.delete(message.requestId); clearTimeout(pending.timer)
            if (message.ok) pending.resolve(message.value)
            else pending.reject(new Error(message.error))
        })
        socket.on('close', () => {
            for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Terminal host connection lost; command outcome unknown')) }
            this.pending.clear()
            for (const listener of this.closeListeners) listener()
        })
        socket.on('error', () => socket.terminate())
    }
    static async connect(directory: string): Promise<TerminalHostClient> {
        const address = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8')) as TerminalHostAddress
        const url = new URL(address.url)
        if (address.version !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Invalid local terminal host address')
        const socket = new WebSocket(address.url.replace('http:', 'ws:') + '/events', {
            headers: { Authorization: `Bearer ${address.token}` }, handshakeTimeout: 5000, maxPayload: 16 * 1024 * 1024,
        })
        const client = new TerminalHostClient(socket, address.instanceId)
        await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
        return client
    }
    subscribe(listener: (event: MachineTerminalEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    onClose(listener: () => void) { this.closeListeners.add(listener); return () => { this.closeListeners.delete(listener) } }
    request(command: MachineTerminalCommand): Promise<MachineTerminalResult> {
        if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Terminal host is disconnected'))
        const requestId = randomUUID()
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId)
                reject(new Error('Terminal command timed out; outcome unknown'))
                // Do not let keys queued behind a stalled request execute much
                // later, after the user has already seen a timeout.
                this.socket.terminate()
            }, 15_000)
            this.pending.set(requestId, { resolve, reject, timer })
            this.socket.send(JSON.stringify({ requestId, command }))
        })
    }
    close() { this.socket.close() }
}
