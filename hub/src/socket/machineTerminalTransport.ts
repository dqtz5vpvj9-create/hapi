import { MachineTerminalBridgePayloadSchema, MachineTerminalRequestSchema, type MachineTerminalReply, type MachineTerminalRpcRequest } from '@hapi/protocol/terminals'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { Store } from '../store'
import type { RpcRegistry } from './rpcRegistry'
import type { CliSocketWithData, SocketServer, SocketWithData } from './socketTypes'

/** Browser JWT/namespace -> machine-scoped Runner -> independent PTY owner.
 * Bindings contain transport identities only. The Hub never owns a terminal,
 * retains its screen, or retries a keystroke. */
export function registerMachineTerminalTransport(io: SocketServer, store: Store, rpc: RpcRegistry) {
    const browsers = io.of('/terminal'), machines = io.of('/cli')
    const bindings = new Map<string, Map<string, string>>()
    const method = (machineId: string) => `${machineId}:${RPC_METHODS.MachineTerminal}`

    async function call(cli: SocketWithData, machineId: string, request: MachineTerminalRpcRequest): Promise<MachineTerminalReply> {
        const raw: unknown = await cli.timeout(25_000).emitWithAck('rpc-request', { method: method(machineId), params: JSON.stringify(request) })
        const result = typeof raw === 'string' ? JSON.parse(raw) : raw
        // RpcHandlerManager also returns {error} when the command throws.
        if (result?.ok === true) return { ok: true, value: result.value }
        return { ok: false, error: typeof result?.error === 'string' ? result.error : 'Terminal request failed' }
    }

    browsers.on('connection', socket => {
        const targets = new Map<string, string>()
        bindings.set(socket.id, targets)
        socket.on('machine-terminal:request', async (data: unknown, acknowledge: (reply: MachineTerminalReply) => void) => {
            if (typeof acknowledge !== 'function') return
            const parsed = MachineTerminalRequestSchema.safeParse(data)
            if (!parsed.success) { acknowledge({ ok: false, error: 'Invalid terminal request' }); return }
            const { machineId, command } = parsed.data, namespace = socket.data.namespace
            if (!namespace || !store.machines.getMachineByNamespace(machineId, namespace)) {
                acknowledge({ ok: false, error: 'Machine not found' }); return
            }
            const targetId = rpc.getSocketIdForMethod(method(machineId))
            const cli = targetId ? machines.sockets.get(targetId) : undefined
            if (!cli || cli.data.namespace !== namespace || cli.handshake.auth.machineId !== machineId) {
                acknowledge({ ok: false, error: 'Machine terminal service is unavailable' }); return
            }
            targets.set(machineId, cli.id)
            try { acknowledge(await call(cli, machineId, { viewerId: socket.id, command })) }
            catch { acknowledge({ ok: false, error: 'Machine connection lost or timed out; command outcome unknown' }) }
            finally {
                // Disconnect may race an in-flight connect/create/claim. A late
                // successful command must not retain an abandoned control lease.
                if (!socket.connected) void call(cli, machineId, { viewerId: socket.id, command: null }).catch(() => {})
            }
        })
        socket.on('disconnect', () => {
            bindings.delete(socket.id)
            for (const [machineId, targetId] of targets) {
                const cli = machines.sockets.get(targetId)
                if (cli) void call(cli, machineId, { viewerId: socket.id, command: null }).catch(() => {})
            }
        })
    })

    machines.on('connection', base => {
        const socket = base as CliSocketWithData
        socket.on('machine-terminal:event', data => {
            const parsed = MachineTerminalBridgePayloadSchema.safeParse(data)
            if (!parsed.success) return
            const { machineId, viewerId, event } = parsed.data
            const browser = browsers.sockets.get(viewerId)
            if (!browser || browser.data.namespace !== socket.data.namespace
                || socket.handshake.auth.machineId !== machineId
                || bindings.get(viewerId)?.get(machineId) !== socket.id
                || rpc.getSocketIdForMethod(method(machineId)) !== socket.id) return
            browser.emit('machine-terminal:event', { machineId, event })
        })
        socket.on('disconnect', () => {
            for (const [viewerId, targets] of bindings) for (const [machineId, targetId] of targets) {
                if (targetId !== socket.id) continue
                targets.delete(machineId)
                browsers.sockets.get(viewerId)?.emit('machine-terminal:event', {
                    machineId, event: { type: 'disconnected', error: 'Machine disconnected. The terminal continues on its host.' },
                })
            }
        })
    })
}
