/** Isolated real Hub + Runner machine client + TerminalHost + browser transport.
 * No model calls, production data or production credentials.
 * HAPI_HOME=<cache>/home bun --tsconfig-override cli/tsconfig.json hub/scripts/machine-terminal-integration.ts run <cache>/case
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { MachineTerminalInfo, MachineTerminalReplay } from '../../shared/src/terminals'
import { MachineTerminalTransport } from '../../web/src/lib/machine-terminal-transport'

const [mode, directory] = process.argv.slice(2)
const compiled = Bun.main.includes('$bunfs') || Bun.main.includes('/~BUN/')
const self = (mode: string) => [process.execPath, ...(compiled ? [] : [import.meta.path]), mode, directory]
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(read: () => Promise<T> | T, accepts: (value: T) => boolean): Promise<T> {
    const deadline = Date.now() + 20000
    let last: T | undefined
    while (Date.now() < deadline) {
        last = await read()
        if (accepts(last)) return last
        await pause(50)
    }
    throw Error('Condition timed out: ' + JSON.stringify(last))
}
const configPath = join(directory, 'config.json')
type Config = { token: string; secret: string; url?: string; port?: number }
const readConfig = async () => JSON.parse(await readFile(configPath, 'utf8')) as Config
const hostDirectory = join(directory, 'home', 'terminal-host')
process.env.HAPI_HOME = join(directory, mode === 'hub' ? 'hub-home' : 'home')

if (mode === 'host') {
    const { startTerminalHost } = await import('../../cli/src/terminal/terminalHostServer')
    const host = await startTerminalHost({ directory: hostDirectory, workspaceRoots: [directory], shell: process.platform === 'win32' ? [Bun.which('pwsh.exe') ?? 'powershell.exe', '-NoLogo', '-NoProfile'] : ['/bin/bash', '--noprofile', '--norc'] })
    await writeFile(join(directory, 'host-ready.json'), JSON.stringify({ pid: process.pid }))
    process.on('SIGTERM', async () => { await host.stop(); process.exit(0) })
} else if (mode === 'hub') {
    const config = await readConfig()
    process.env.CLI_API_TOKEN = config.token
    const { createConfiguration } = await import('../../hub/src/configuration')
    await createConfiguration()
    const { Store } = await import('../../hub/src/store')
    const { createSocketServer } = await import('../../hub/src/socket/server')
    const store = new Store(join(directory, 'hub.db'))
    const machine = store.machines.getOrCreateMachine('test-machine', { host: 'fixture', platform: process.platform, happyCliVersion: 'test', homeDir: directory }, null, 'team')
    const { io, engine, rpcRegistry } = createSocketServer({ store, jwtSecret: Buffer.from(config.secret, 'base64'), corsOrigins: ['*'] })
    const handlers = engine.handler()
    const server = Bun.serve({ ...handlers, hostname: '127.0.0.1', port: config.port ?? 0,
        fetch(request, server) {
            if (new URL(request.url).pathname === '/ready') return Response.json({ machine: !!rpcRegistry.getSocketIdForMethod('test-machine:machine-terminal') })
            return handlers.fetch(request, server)
        },
    })
    await writeFile(join(directory, 'hub-ready.json'), JSON.stringify({ pid: process.pid, url: `http://127.0.0.1:${server.port}`, machine: { ...machine, active: true, activeAt: Date.now() } }))
    process.on('SIGTERM', async () => { await io.close(); server.stop(true); store.close(); process.exit(0) })
} else if (mode === 'machine') {
    const config = await readConfig()
    process.env.HAPI_API_URL = config.url
    const { ApiMachineClient } = await import('../../cli/src/api/apiMachine')
    const machine = JSON.parse(await readFile(join(directory, 'hub-ready.json'), 'utf8')).machine
    const client = new ApiMachineClient(`${config.token}:team`, machine, [directory])
    client.connect()
    process.on('SIGTERM', () => { client.shutdown(); process.exit(0) })
} else if (mode === 'run') {
    await mkdir(directory, { recursive: true })
    const config: Config = { token: randomUUID(), secret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') }
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
    const evidence = { platform: process.platform, checks: [] as string[], passed: false, originalPid: 0, error: '' }
    const children = new Set<Bun.Subprocess>(), browsers: MachineTerminalTransport[] = []
    function launch(mode: string) {
        const proc = Bun.spawn(self(mode), { stdout: Bun.file(join(directory, mode + '.log')), stderr: Bun.file(join(directory, mode + '.log')) })
        children.add(proc); return proc
    }
    async function ready(file: string, pid: number) {
        return until(async () => { try { return JSON.parse(await readFile(join(directory, file), 'utf8')) } catch { return null } }, value => value?.pid === pid)
    }
    const kill = async (proc: Bun.Subprocess) => { proc.kill('SIGKILL'); await proc.exited; children.delete(proc) }
    try {
        const host = launch('host'); await ready('host-ready.json', host.pid)
        let hub = launch('hub')
        const initial = await ready('hub-ready.json', hub.pid)
        config.url = initial.url; config.port = new URL(initial.url).port ? Number(new URL(initial.url).port) : undefined
        await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
        let machine = launch('machine')
        const machineReady = () => until(async () => (await (await fetch(config.url + '/ready')).json()).machine, Boolean)
        await machineReady()
        const { SignJWT } = await import('jose')
        async function browser(namespace: string) {
            const token = await new SignJWT({ uid: 1, ns: namespace }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(Buffer.from(config.secret, 'base64'))
            const transport = new MachineTerminalTransport(config.url!, token)
            browsers.push(transport); transport.connect()
            await until(() => transport.connected, Boolean)
            return transport
        }
        const a = await browser('team'), b = await browser('team'), other = await browser('other')
        const command = { type: 'create' as const, terminalId: randomUUID(), cwd: directory, title: 'Wire test', cols: 100, rows: 30 }
        const request = a.request.bind(a, 'test-machine'), second = b.request.bind(b, 'test-machine')
        await assert.rejects(other.request('test-machine', { type: 'list' }), /Machine not found/)
        await assert.rejects(request({ ...command, terminalId: 'outside', cwd: process.platform === 'win32' ? 'C:\\Windows' : '/' }), /outside workspace roots/)
        evidence.checks.push('real JWT namespaces and Runner path policy restrict machine terminal access')
        const first = await request(command) as MachineTerminalInfo
        evidence.originalPid = first.pid!
        assert.equal(first.status, 'running')
        assert.equal((await request(command) as MachineTerminalInfo).pid, first.pid)
        const events: string[] = []
        b.onEvent((_, event) => { if (event.type === 'output') events.push(event.data) })
        await request({ type: 'attach', terminalId: first.terminalId })
        await second({ type: 'attach', terminalId: first.terminalId })
        const owner = await request({ type: 'claim', terminalId: first.terminalId, controllerId: 'a', takeover: false }) as MachineTerminalInfo
        await assert.rejects(second({ type: 'claim', terminalId: first.terminalId, controllerId: 'b', takeover: false }), /Another view/)
        const takeover = await second({ type: 'claim', terminalId: first.terminalId, controllerId: 'b', takeover: true }) as MachineTerminalInfo
        await assert.rejects(request({ type: 'input', terminalId: first.terminalId, controllerId: 'a', controlVersion: owner.controlVersion, data: 'MUST_NOT_RUN\r' }), /control changed/)
        await second({ type: 'input', terminalId: first.terminalId, controllerId: 'b', controlVersion: takeover.controlVersion,
            data: process.platform === 'win32' ? "Write-Output ('OUTPUT_' + 'CONFIRMED')\r" : "printf 'OUTPUT_%s\\n' 'CONFIRMED'\r" })
        await until(() => events.join(''), text => text.includes('OUTPUT_CONFIRMED'))
        const replay = () => second({ type: 'attach', terminalId: first.terminalId }) as Promise<MachineTerminalReplay>
        assert.ok((await replay()).data.includes('OUTPUT_CONFIRMED'))
        evidence.checks.push('two real socket viewers receive PTY output; takeover rejects stale input and executes the new owner command')
        a.close()
        await pause(100)
        assert.equal((await replay()).terminal.controllerId, 'b')
        evidence.checks.push('closing an observer does not release the other viewer control or kill the process')
        await kill(machine)
        await until(async () => (await (await fetch(config.url + '/ready')).json()).machine, value => !value)
        await assert.rejects(second({ type: 'input', terminalId: first.terminalId, controllerId: 'b', controlVersion: takeover.controlVersion, data: 'MUST_NOT_REPLAY\r' }), /unavailable/)
        machine = launch('machine'); await machineReady()
        const restored = await replay()
        assert.equal(restored.terminal.pid, first.pid); assert.equal(restored.terminal.status, 'running'); assert.equal(restored.terminal.controllerId, null)
        assert.ok(restored.data.includes('OUTPUT_CONFIRMED')); assert.ok(!restored.data.includes('MUST_NOT_REPLAY'))
        evidence.checks.push('killing and restarting the actual Runner machine-client process preserves the original PTY and screen')
        await kill(hub)
        await until(() => b.connected, value => !value)
        await assert.rejects(second({ type: 'input', terminalId: first.terminalId, controllerId: 'b', controlVersion: takeover.controlVersion, data: 'MUST_NOT_BUFFER\r' }), /not sent/)
        hub = launch('hub'); await ready('hub-ready.json', hub.pid); await machineReady()
        await until(() => b.connected, Boolean)
        const afterHub = await replay()
        assert.equal(afterHub.terminal.pid, first.pid); assert.equal(afterHub.terminal.status, 'running')
        assert.ok(afterHub.data.includes('OUTPUT_CONFIRMED')); assert.ok(!afterHub.data.includes('MUST_NOT_BUFFER'))
        evidence.checks.push('real Hub process restart reconnects both transports and preserves the same PTY without buffering offline keystrokes')
        await second({ type: 'terminate', terminalId: first.terminalId })
        await until(replay, r => r.terminal.status === 'exited')
        evidence.checks.push('explicit termination travels through the authenticated machine path and ends the real shell')
        evidence.passed = true
    } catch(error) { evidence.error = String(error); throw error }
    finally {
        for (const browser of browsers) browser.close()
        for (const child of children) if (child.exitCode === null) { child.kill('SIGTERM'); await child.exited }
        await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2))
        console.log(JSON.stringify(evidence))
    }
} else throw Error('Expected run, host, hub or machine')
