import type { MachineTerminalBridgeEvent, MachineTerminalCommand, MachineTerminalInfo, MachineTerminalResult, MachineTerminalRpcRequest } from '@hapi/protocol/terminals'
import type { MachinePathPolicy } from '@/api/machinePathPolicy'
import { TerminalHostClient } from './TerminalHostClient'

type Viewer = { client: Promise<TerminalHostClient>; terminals: Map<string, MachineTerminalInfo> }

/** Runner-side transport only. The separately supervised host owns every PTY.
 * Each authenticated browser connection gets its own local peer, so a stale
 * socket can neither release nor write through another viewer's control lease. */
export class TerminalHostBridge {
    private readonly viewers = new Map<string, Viewer>()
    private online = false
    constructor(private readonly options: {
        directory: string
        pathPolicy: MachinePathPolicy
        send: (viewerId: string, event: MachineTerminalBridgeEvent) => void
    }) {}

    start() { this.online = true }
    stop() {
        this.online = false
        for (const id of this.viewers.keys()) this.disconnect(id)
    }
    private disconnect(id: string) {
        const viewer = this.viewers.get(id)
        this.viewers.delete(id)
        void viewer?.client.then(client => client.close()).catch(() => {})
    }
    private permitted(info: MachineTerminalInfo) { return this.options.pathPolicy.isWithinSpawnRoots(info.cwd) }

    private viewer(id: string): Viewer {
        const previous = this.viewers.get(id)
        if (previous) return previous
        const terminals = new Map<string, MachineTerminalInfo>()
        const client = TerminalHostClient.connect(this.options.directory).then(async client => {
            if (this.viewers.get(id) !== viewer || !this.online) { client.close(); throw new Error('Terminal viewer disconnected') }
            client.onClose(() => {
                if (this.viewers.get(id) !== viewer) return
                this.viewers.delete(id)
                this.options.send(id, { type: 'disconnected', error: 'Terminal service disconnected. Reconnect to restore the screen.' })
            })
            client.subscribe(event => {
                if (this.viewers.get(id) !== viewer || !this.online) return
                if (event.type === 'state') terminals.set(event.terminal.terminalId, event.terminal)
                const info = event.type === 'state' ? event.terminal : terminals.get(event.terminalId)
                if (info && this.permitted(info)) this.options.send(id, event)
            })
            try {
                for (const info of await client.request({ type: 'list' }) as MachineTerminalInfo[]) terminals.set(info.terminalId, info)
            } catch (error) { client.close(); throw error }
            return client
        }).catch(error => {
            if (this.viewers.get(id) === viewer) this.viewers.delete(id)
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Terminal service is not running on this machine')
            throw error
        })
        const viewer = { client, terminals }
        this.viewers.set(id, viewer)
        return viewer
    }

    async request({ viewerId, command }: MachineTerminalRpcRequest): Promise<MachineTerminalResult> {
        if (!command) { this.disconnect(viewerId); return null }
        if (!this.online) throw new Error('Machine transport is disconnected')
        if (command.type === 'create') {
            const cwd = await this.options.pathPolicy.resolveForCheck(command.cwd)
            if (!this.options.pathPolicy.isWithinSpawnRoots(cwd)) throw new Error('Terminal directory is outside workspace roots')
            command = { ...command, cwd }
        }
        const viewer = this.viewer(viewerId), client = await viewer.client
        if (this.viewers.get(viewerId) !== viewer || !this.online) throw new Error('Terminal viewer disconnected')
        if (command.type !== 'list' && command.type !== 'create') this.authorize(viewer, command)
        const result = await client.request(command)
        if (command.type === 'list') return (result as MachineTerminalInfo[]).filter(info => this.permitted(info))
        return result
    }

    private authorize(viewer: Viewer, command: Exclude<MachineTerminalCommand, { type: 'list' } | { type: 'create' }>) {
        const info = viewer.terminals.get(command.terminalId)
        if (!info || !this.permitted(info)) throw new Error('Terminal not found')
    }
}
