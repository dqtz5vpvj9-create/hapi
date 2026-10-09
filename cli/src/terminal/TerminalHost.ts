import { Database } from 'bun:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Terminal, type ITerminalAddon } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import type { MachineTerminalCommand, MachineTerminalEvent, MachineTerminalInfo, MachineTerminalOutput, MachineTerminalReplay, MachineTerminalResult } from '@hapi/protocol/terminals'
import { MachinePathPolicy } from '@/api/machinePathPolicy'
import { killProcessTreeByPid } from '@/utils/process'
import { AsyncLock } from '@/utils/lock'
import { buildFilteredEnv, normalizeTerminalInputForHost, resolveShellCommand } from './TerminalManager'

type Runtime = {
    info: MachineTerminalInfo
    process: Bun.Subprocess | null
    screen: Terminal
    serializer: SerializeAddon
    output: MachineTerminalOutput[]
    outputBytes: number
    owner: string | null
    dirty: boolean
}
type HostOptions = { directory: string; workspaceRoots?: readonly string[]; shell?: string[]; maxTerminals?: number; outputBytes?: number; scrollback?: number }

/** Owns PTYs independently of the Runner, Hub, chats and browser connections. */
export class TerminalHost {
    private readonly db: Database
    private readonly terminals = new Map<string, Runtime>()
    private readonly pathPolicy: MachinePathPolicy
    private readonly listeners = new Set<(event: MachineTerminalEvent) => void>()
    private readonly creating = new AsyncLock()
    private readonly persistTimer: ReturnType<typeof setInterval>
    private stopped = false

    constructor(private readonly options: HostOptions) {
        mkdirSync(options.directory, { recursive: true, mode: 0o700 })
        const dbPath = join(options.directory, 'terminals.db')
        this.db = new Database(dbPath, { create: true })
        chmodSync(dbPath, 0o600)
        this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000')
        this.db.exec('CREATE TABLE IF NOT EXISTS terminals (id TEXT PRIMARY KEY, info TEXT NOT NULL, screen TEXT NOT NULL)')
        this.pathPolicy = new MachinePathPolicy({ workspaceRoots: options.workspaceRoots })
        // A new host cannot inherit the old PTY handles. Keep the original identity
        // and last screen, but report loss; never spawn a substitute for an attach.
        for (const row of this.db.query('SELECT info, screen FROM terminals').all() as { info: string; screen: string }[]) {
            const info = JSON.parse(row.info) as MachineTerminalInfo
            if (['starting', 'running', 'closing'].includes(info.status)) {
                info.status = 'lost'; info.endedAt = Date.now()
            }
            info.controllerId = null; info.controlVersion++
            const runtime = this.makeRuntime(info)
            this.terminals.set(info.terminalId, runtime)
            runtime.dirty = false
            runtime.screen.write(row.screen, () => { runtime.dirty = true })
            // Persist the lost state immediately even if another host crash follows.
            this.db.query('UPDATE terminals SET info=? WHERE id=?').run(JSON.stringify(info), info.terminalId)
        }
        this.persistTimer = setInterval(() => this.persist(), 1000)
        this.persistTimer.unref()
    }

    subscribe(listener: (event: MachineTerminalEvent) => void): () => void {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
    }
    private emit(event: MachineTerminalEvent) { for (const listener of this.listeners) listener(event) }
    private changed(runtime: Runtime) {
        runtime.dirty = true
        this.emit({ type: 'state', terminal: { ...runtime.info } })
    }
    private makeRuntime(info: MachineTerminalInfo): Runtime {
        const screen = new Terminal({ cols: info.cols, rows: info.rows, scrollback: this.options.scrollback ?? 2000, allowProposedApi: true })
        const serializer = new SerializeAddon()
        // Both xterm implementations expose the buffer API used by serialize;
        // their addon interfaces differ only by browser-specific Terminal methods.
        screen.loadAddon(serializer as unknown as ITerminalAddon)
        const runtime: Runtime = { info, process: null, screen, serializer, output: [], outputBytes: 0, owner: null, dirty: true }
        // Headless xterm answers terminal queries even with no browser attached.
        screen.onData(data => { if (runtime.info.status === 'running') runtime.process?.terminal?.write(data) })
        return runtime
    }
    private get(id: string) {
        const runtime = this.terminals.get(id)
        if (!runtime) throw new Error('Terminal not found')
        return runtime
    }
    private running(id: string) {
        const runtime = this.get(id)
        if (runtime.info.status !== 'running' || !runtime.process) throw new Error('The original terminal process is no longer running')
        return runtime
    }
    private controlled(peer: string, command: { terminalId: string; controllerId: string; controlVersion: number }) {
        const runtime = this.running(command.terminalId)
        if (runtime.owner !== peer || runtime.info.controllerId !== command.controllerId || runtime.info.controlVersion !== command.controlVersion) {
            throw new Error('Terminal control changed; claim control before typing')
        }
        return runtime
    }
    private release(runtime: Runtime) {
        runtime.owner = null; runtime.info.controllerId = null; runtime.info.controlVersion++
        this.changed(runtime)
    }
    releasePeer(peer: string) {
        for (const runtime of this.terminals.values()) if (runtime.owner === peer) this.release(runtime)
    }

    async execute(peer: string, command: MachineTerminalCommand): Promise<MachineTerminalResult> {
        if (this.stopped) throw new Error('Terminal host is shutting down')
        if (command.type === 'list') return [...this.terminals.values()].map(r => ({ ...r.info }))
        if (command.type === 'create') return this.creating.inLock(() => this.create(command))
        const runtime = this.get(command.terminalId)
        switch (command.type) {
            case 'attach': return this.replay(runtime, command.afterSeq)
            // A bridge may multiplex multiple viewers. Detaching an observer
            // must not release a different viewer's control lease.
            case 'detach': return null
            case 'claim': {
                this.running(command.terminalId)
                if (runtime.info.controllerId && (runtime.owner !== peer || runtime.info.controllerId !== command.controllerId) && !command.takeover) {
                    throw new Error('Another view controls this terminal')
                }
                if (runtime.owner !== peer || runtime.info.controllerId !== command.controllerId) {
                    runtime.owner = peer; runtime.info.controllerId = command.controllerId; runtime.info.controlVersion++
                    this.changed(runtime)
                }
                return { ...runtime.info }
            }
            case 'release': this.controlled(peer, command); this.release(runtime); return null
            case 'input': this.controlled(peer, command).process!.terminal!.write(normalizeTerminalInputForHost(command.data)); return null
            case 'resize': {
                this.controlled(peer, command)
                runtime.process!.terminal!.resize(command.cols, command.rows)
                // Complete all earlier parser work before changing its geometry.
                await new Promise<void>(resolve => runtime.screen.write('', resolve))
                runtime.screen.resize(command.cols, command.rows)
                runtime.info.cols = command.cols; runtime.info.rows = command.rows
                this.changed(runtime)
                return { ...runtime.info }
            }
            case 'rename': runtime.info.title = command.title; this.changed(runtime); this.persist(); return { ...runtime.info }
            case 'terminate': await this.terminate(runtime); return { ...runtime.info }
        }
    }

    private async create(command: Extract<MachineTerminalCommand, { type: 'create' }>): Promise<MachineTerminalInfo> {
        const cwd = await realpath(command.cwd)
        if (!this.pathPolicy.isWithinSpawnRoots(cwd) || !(await stat(cwd)).isDirectory()) throw new Error('Terminal directory is outside workspace roots or unavailable')
        const existing = this.terminals.get(command.terminalId)
        if (existing) {
            if (existing.info.cwd !== cwd) throw new Error('Terminal identity is already bound to another directory')
            return { ...existing.info }
        }
        const running = [...this.terminals.values()].filter(r => ['starting', 'running', 'closing'].includes(r.info.status))
        if (running.length >= (this.options.maxTerminals ?? 16)) throw new Error('Too many running terminals on this machine')
        const info: MachineTerminalInfo = { terminalId: command.terminalId, title: command.title, cwd,
            cols: command.cols, rows: command.rows, createdAt: Date.now(), endedAt: null, pid: null,
            status: 'starting', exitCode: null, seq: 0, controllerId: null, controlVersion: 0 }
        const runtime = this.makeRuntime(info)
        this.terminals.set(command.terminalId, runtime)
        this.persist()
        const decoder = new TextDecoder()
        try {
            const proc = Bun.spawn(this.options.shell ?? resolveShellCommand(), {
                cwd, env: buildFilteredEnv(),
                terminal: { cols: command.cols, rows: command.rows,
                    data: (_terminal, data) => this.output(runtime, decoder.decode(data, { stream: true })) },
                onExit: (_proc, code) => {
                    this.output(runtime, decoder.decode())
                    runtime.screen.write('', () => {
                        info.status = 'exited'; info.exitCode = code ?? null; info.endedAt = Date.now()
                        runtime.process = null
                        this.release(runtime); this.persist()
                    })
                },
            })
            if (!proc.terminal) { proc.kill(); throw new Error('PTY is unavailable in this runtime') }
            runtime.process = proc; info.pid = proc.pid; info.status = 'running'
            this.changed(runtime); this.persist()
            return { ...info }
        } catch (error) {
            info.status = 'lost'; info.endedAt = Date.now()
            this.changed(runtime); this.persist()
            throw error
        }
    }
    private output(runtime: Runtime, data: string) {
        if (!data) return
        runtime.screen.write(data, () => {
            const frame: MachineTerminalOutput = { type: 'output', terminalId: runtime.info.terminalId, seq: ++runtime.info.seq, data }
            runtime.output.push(frame); runtime.outputBytes += Buffer.byteLength(data)
            while (runtime.outputBytes > (this.options.outputBytes ?? 1024 * 1024) && runtime.output.length) {
                runtime.outputBytes -= Buffer.byteLength(runtime.output.shift()!.data)
            }
            runtime.dirty = true
            this.emit(frame)
        })
    }
    private async replay(runtime: Runtime, afterSeq?: number): Promise<MachineTerminalReplay> {
        await new Promise<void>(resolve => runtime.screen.write('', resolve))
        const first = runtime.output[0]?.seq ?? runtime.info.seq + 1
        const reset = afterSeq === undefined || afterSeq < first - 1 || afterSeq > runtime.info.seq
        return { terminal: { ...runtime.info }, reset, seq: runtime.info.seq,
            data: reset ? runtime.serializer.serialize() : runtime.output.filter(frame => frame.seq > afterSeq!).map(frame => frame.data).join('') }
    }
    private persist() {
        if (this.stopped) return
        const save = this.db.query('INSERT INTO terminals (id,info,screen) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET info=excluded.info,screen=excluded.screen')
        this.db.transaction(() => {
            for (const r of this.terminals.values()) if (r.dirty) {
                save.run(r.info.terminalId, JSON.stringify(r.info), r.serializer.serialize()); r.dirty = false
            }
        })()
    }
    private async terminate(runtime: Runtime) {
        const proc = runtime.process
        if (!proc || runtime.info.status !== 'running') return
        runtime.info.status = 'closing'; this.release(runtime)
        await killProcessTreeByPid(proc.pid, true)
        proc.terminal?.close()
        await proc.exited
        await new Promise<void>(resolve => runtime.screen.write('', resolve))
    }
    async stop() {
        clearInterval(this.persistTimer)
        await Promise.all([...this.terminals.values()].map(r => this.terminate(r)))
        this.persist(); this.stopped = true
        for (const r of this.terminals.values()) r.screen.dispose()
        this.db.close()
    }
}
