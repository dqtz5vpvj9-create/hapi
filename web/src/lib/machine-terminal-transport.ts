import { Manager, type Socket } from 'socket.io-client'
import type { MachineTerminalBridgeEvent, MachineTerminalCommand, MachineTerminalReply, MachineTerminalResult } from '@hapi/protocol/terminals'

export class MachineTerminalTransport {
    private readonly socket: Socket
    private readonly events = new Set<(machineId: string, event: MachineTerminalBridgeEvent) => void>()
    private readonly connections = new Set<(connected: boolean, error?: string) => void>()
    constructor(baseUrl: string, token: string) {
        const manager = new Manager(baseUrl, {
            path: '/socket.io/', transports: ['polling', 'websocket'], rememberUpgrade: true,
            autoConnect: false, reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 5000,
        })
        this.socket = manager.socket('/terminal', { auth: { token } })
        this.socket.on('connect', () => { for (const listener of this.connections) listener(true) })
        this.socket.on('disconnect', () => { for (const listener of this.connections) listener(false) })
        this.socket.on('connect_error', error => { for (const listener of this.connections) listener(false, error.message) })
        this.socket.on('machine-terminal:event', ({ machineId, event }: { machineId: string; event: MachineTerminalBridgeEvent }) => {
            for (const listener of this.events) listener(machineId, event)
        })
    }
    get connected() { return this.socket.connected }
    connect() { this.socket.connect() }
    close() { this.socket.close() }
    onConnection(listener: (connected: boolean, error?: string) => void) { this.connections.add(listener); return () => { this.connections.delete(listener) } }
    onEvent(listener: (machineId: string, event: MachineTerminalBridgeEvent) => void) { this.events.add(listener); return () => { this.events.delete(listener) } }
    async request(machineId: string, command: MachineTerminalCommand): Promise<MachineTerminalResult> {
        // Socket.IO normally buffers emits during disconnection. Terminal input
        // must never be replayed into a later prompt after reconnection.
        if (!this.socket.connected) throw new Error('Disconnected. Input was not sent.')
        const reply = await this.socket.timeout(27_000).emitWithAck('machine-terminal:request', { machineId, command }) as MachineTerminalReply
        if (!reply.ok) throw new Error(reply.error)
        return reply.value
    }
}
