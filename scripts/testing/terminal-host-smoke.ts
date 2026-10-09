/** Real process/PTY/transport acceptance. Also compiles into one Windows test executable.
 * bun scripts/testing/terminal-host-smoke.ts run <isolated cache directory>
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TerminalHostClient } from '../../cli/src/terminal/TerminalHostClient'
import { startTerminalHost } from '../../cli/src/terminal/terminalHostServer'
import type { MachineTerminalInfo, MachineTerminalReplay } from '../../shared/src/terminals'

const [mode, directory] = process.argv.slice(2)
const compiled = Bun.main.includes('$bunfs') || Bun.main.includes('/~BUN/')
const self = (mode: string, directory: string) => [process.execPath, ...(compiled ? [] : [import.meta.path]), mode, directory]
const shell = process.platform === 'win32' ? [Bun.which('pwsh.exe') ?? 'powershell.exe', '-NoLogo', '-NoProfile'] : ['/bin/bash', '--noprofile', '--norc']
const say = (text: string) => process.platform === 'win32' ? `Write-Output '${text}'\r` : `printf '%s\\n' '${text}'\r`
const quote = (text: string) => process.platform === 'win32' ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`
const invoke = (args: string[]) => (process.platform === 'win32' ? '& ' : '') + args.map(quote).join(' ') + '\r'
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
    const start = Date.now()
    let last: T | undefined
    while (Date.now() - start < 15000) {
        last = await read()
        if (check(last)) return last
        await pause(30)
    }
    throw new Error('Condition timed out: ' + JSON.stringify(last))
}

if (mode === 'host') {
    const host = await startTerminalHost({ directory, workspaceRoots: [directory], shell, outputBytes: 256, scrollback: 100 })
    await writeFile(join(directory, 'ready.json'), JSON.stringify({ pid: process.pid, instanceId: host.address.instanceId }))
    let stopping = false
    const stop = async () => { if (stopping) return; stopping = true; await host.stop(); process.exit(0) }
    process.on('SIGTERM', stop); process.on('SIGINT', stop)
} else if (mode === 'writer') {
    // Emit enough output to evict the incremental ring, followed by a full-screen
    // TUI frame. A reconnect must reconstruct this screen, not a cut ANSI tail.
    process.stdout.write('old output\r\n'.repeat(1000))
    process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[31m长期终端 ✓\x1b[0m\r\n')
    process.stdout.write('AFTER_REPLAY_OVERFLOW\r\n')
    await pause(500)
    process.exit(0)
} else if (mode === 'bridge') {
    const client = await TerminalHostClient.connect(directory)
    const info = await client.request({ type: 'claim', terminalId: 'smoke-terminal', controllerId: 'bridge', takeover: true }) as MachineTerminalInfo
    await writeFile(join(directory, 'bridge-ready.json'), JSON.stringify(info))
    setInterval(() => {}, 1000)
} else if (mode === 'run') {
    assert.ok(directory, 'An isolated cache directory is required')
    await mkdir(directory, { recursive: true })
    const evidence: Record<string, unknown> = { platform: process.platform, bun: Bun.version, checks: [] }
    const checks = evidence.checks as string[]
    const hostLog = Bun.file(join(directory, 'host.log'))
    const launch = () => Bun.spawn(self('host', directory), { stdout: hostLog, stderr: hostLog })
    let host = launch(), bridge: Bun.Subprocess | null = null
    const clients: TerminalHostClient[] = []
    const connect = async () => { const c = await TerminalHostClient.connect(directory); clients.push(c); return c }
    async function ready(pid: number) {
        await until(async () => { try { return JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8')) as { pid: number } } catch { return null } }, value => value?.pid === pid)
    }
    try {
        await ready(host.pid)
        const address = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8'))
        assert.equal((await fetch(address.url + '/health')).status, 401)
        assert.equal((await fetch(address.url + '/health', { headers: { Authorization: 'Bearer ' + address.token, Origin: 'https://untrusted.invalid' } })).status, 401)
        checks.push('local transport rejects missing credentials and browser origins')
        const a = await connect(), b = await connect()
        const create = { type: 'create' as const, terminalId: 'smoke-terminal', cwd: directory, title: 'Real PTY smoke', cols: 100, rows: 30 }
        const first = await a.request(create) as MachineTerminalInfo
        assert.equal(first.status, 'running'); assert.ok(first.pid)
        const [duplicateA, duplicateB] = await Promise.all([a.request(create), b.request(create)]) as MachineTerminalInfo[]
        assert.equal(duplicateA.pid, first.pid); assert.equal(duplicateB.pid, first.pid)
        const secondHost = Bun.spawn(self('host', directory), { stdout: 'ignore', stderr: 'ignore' })
        assert.notEqual(await secondHost.exited, 0)
        assert.equal((await a.request(create) as MachineTerminalInfo).pid, first.pid)
        checks.push('simultaneous create retries and duplicate host startup preserve the original process')
        await assert.rejects(a.request({ ...create, terminalId: 'outside', cwd: process.platform === 'win32' ? 'C:\\Windows' : '/' }), /outside workspace roots/)
        checks.push('machine path policy still restricts terminal creation')
        await a.request({ type: 'attach', terminalId: first.terminalId })
        const ownerA = await a.request({ type: 'claim', terminalId: first.terminalId, controllerId: 'a', takeover: false }) as MachineTerminalInfo
        await assert.rejects(b.request({ type: 'claim', terminalId: first.terminalId, controllerId: 'b', takeover: false }), /Another view/)
        const ownerB = await b.request({ type: 'claim', terminalId: first.terminalId, controllerId: 'b', takeover: true }) as MachineTerminalInfo
        await assert.rejects(a.request({ type: 'input', terminalId: first.terminalId, controllerId: 'a', controlVersion: ownerA.controlVersion, data: say('STALE_INPUT_MUST_NOT_RUN') }), /control changed/)
        await b.request({ type: 'input', terminalId: first.terminalId, controllerId: 'b', controlVersion: ownerB.controlVersion, data: say('OWNER_B_OK') })
        const replay = () => b.request({ type: 'attach', terminalId: first.terminalId }) as Promise<MachineTerminalReplay>
        await until(replay, r => r.data.includes('OWNER_B_OK'))
        assert.ok(!(await replay()).data.includes('STALE_INPUT_MUST_NOT_RUN'))
        checks.push('explicit takeover rejects stale keystrokes; the new owner executes shell commands')
        await b.request({ type: 'input', terminalId: first.terminalId, controllerId: 'b', controlVersion: ownerB.controlVersion, data: invoke(self('writer', directory)) })
        const screen = await until(replay, r => r.data.includes('AFTER_REPLAY_OVERFLOW'))
        assert.ok(screen.data.includes('长期终端')); assert.equal(screen.reset, true)
        const oldCursor = await b.request({ type: 'attach', terminalId: first.terminalId, afterSeq: 0 }) as MachineTerminalReplay
        assert.equal(oldCursor.reset, true); assert.ok(oldCursor.data.includes('AFTER_REPLAY_OVERFLOW'))
        checks.push('bounded output overflow falls back to a complete UTF-8, colored, alternate-screen snapshot')
        bridge = Bun.spawn(self('bridge', directory), { stdout: 'ignore', stderr: hostLog })
        await until(async () => { try { return JSON.parse(await readFile(join(directory, 'bridge-ready.json'), 'utf8')) as MachineTerminalInfo } catch { return null } }, value => value?.controllerId === 'bridge')
        bridge.kill('SIGKILL'); await bridge.exited; bridge = null
        const afterCrash = await until(async () => (await b.request({ type: 'list' }) as MachineTerminalInfo[]).find(t => t.terminalId === first.terminalId)!, r => r.controllerId === null)
        assert.equal(afterCrash.status, 'running'); assert.equal(afterCrash.pid, first.pid)
        a.close(); b.close()
        await pause(250)
        const c = await connect()
        const afterDetach = await c.request({ type: 'attach', terminalId: first.terminalId }) as MachineTerminalReplay
        assert.equal(afterDetach.terminal.pid, first.pid); assert.equal(afterDetach.terminal.status, 'running')
        checks.push('a killed bridge process and all viewers disconnecting leave the same PTY alive and reattachable')
        await pause(1200) // Allow the ordinary periodic screen checkpoint to reach disk.
        host.kill('SIGKILL'); await host.exited
        host = launch(); await ready(host.pid)
        const d = await connect()
        const lost = await d.request({ type: 'attach', terminalId: first.terminalId }) as MachineTerminalReplay
        assert.equal(lost.terminal.status, 'lost'); assert.equal(lost.terminal.pid, first.pid)
        assert.ok(lost.data.includes('AFTER_REPLAY_OVERFLOW'))
        const noRespawn = await d.request(create) as MachineTerminalInfo
        assert.equal(noRespawn.status, 'lost'); assert.equal(noRespawn.pid, first.pid)
        checks.push('host crash recovers saved screen and reports the original process lost; create/attach never silently respawn it')
        const fresh = await d.request({ ...create, terminalId: randomUUID(), title: 'Explicit new terminal' }) as MachineTerminalInfo
        assert.equal(fresh.status, 'running'); assert.notEqual(fresh.pid, first.pid)
        await d.request({ type: 'terminate', terminalId: fresh.terminalId })
        await until(async () => (await d.request({ type: 'list' }) as MachineTerminalInfo[]).find(t => t.terminalId === fresh.terminalId)!, r => r.status === 'exited')
        checks.push('explicitly creating a new terminal and terminating it updates the resource state')
        evidence.passed = true; evidence.originalPid = first.pid
    } catch (error) { evidence.error = String(error); throw error }
    finally {
        for (const c of clients) c.close()
        if (bridge?.exitCode === null) { bridge.kill('SIGKILL'); await bridge.exited }
        if (host.exitCode === null) { host.kill('SIGTERM'); await host.exited }
        await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2))
        console.log(JSON.stringify(evidence))
    }
} else throw new Error('Expected run, host, bridge or writer')
