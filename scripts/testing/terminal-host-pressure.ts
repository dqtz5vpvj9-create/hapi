import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { join } from 'node:path'
import { TerminalHost } from '../../cli/src/terminal/TerminalHost'
import type { MachineTerminalInfo, MachineTerminalReplay } from '../../shared/src/terminals'

const [mode, directory, countArg = '1', mibArg = '128'] = process.argv.slice(2)
const compiled = Bun.main.includes('$bunfs') || Bun.main.includes('/~BUN/')
const args = (mode: string) => [process.execPath, ...(compiled ? [] : [import.meta.path]), mode, directory, countArg, mibArg]
const count = Number(countArg), bytes = Number(mibArg) * 1024 * 1024
if (mode === 'writer') {
    const chunk = 'terminal output 0123456789 abcdefghijklmnopqrstuvwxyz\r\n'.repeat(1024)
    for (let written = 0; written < bytes; written += chunk.length) {
        if (!process.stdout.write(chunk)) await once(process.stdout, 'drain')
    }
    process.stdout.write('\r\nPRESSURE_OUTPUT_COMPLETE\r\n')
} else if (mode === 'run') {
    await mkdir(directory, { recursive: true })
    const host = new TerminalHost({ directory, workspaceRoots: [directory], shell: args('writer') })
    const start = performance.now(), initialRss = process.memoryUsage().rss
    let peakRss = initialRss, peakPending = 0, largestLoopGap = 0, lastSample = start
    // Test-only inspection of the parser queue, never a production dependency.
    const runtimes = (host as unknown as { terminals: Map<string, { screen: { _core: { _writeBuffer: { _pendingData: number } } } }> }).terminals
    const sample = setInterval(() => {
        const now = performance.now()
        largestLoopGap = Math.max(largestLoopGap, now - lastSample); lastSample = now
        peakRss = Math.max(peakRss, process.memoryUsage().rss)
        peakPending = Math.max(peakPending, ...[...runtimes.values()].map(r => r.screen._core._writeBuffer._pendingData))
    }, 5)
    const result = { platform: process.platform, count, bytesPerTerminal: bytes, initialRss, peakRss: 0, peakPendingBytes: 0, largestLoopGapMs: 0, elapsedMs: 0, passed: false }
    try {
        for (let i = 0; i < count; i++) await host.execute('pressure', { type: 'create', terminalId: `terminal-${i}`, cwd: directory, title: `Pressure ${i}`, cols: 100, rows: 30 })
        const deadline = Date.now() + 120_000
        while (Date.now() < deadline) {
            const terminals = await host.execute('pressure', { type: 'list' }) as MachineTerminalInfo[]
            if (terminals.every(t => t.status === 'exited')) break
            await new Promise(resolve => setTimeout(resolve, 20))
        }
        for (let i = 0; i < count; i++) {
            const replay = await host.execute('pressure', { type: 'attach', terminalId: `terminal-${i}` }) as MachineTerminalReplay
            assert.equal(replay.terminal.status, 'exited')
            assert.equal(replay.terminal.exitCode, 0)
            assert.ok(replay.data.includes('PRESSURE_OUTPUT_COMPLETE'))
        }
        result.passed = true
    } finally {
        clearInterval(sample)
        Object.assign(result, { peakRss, peakPendingBytes: peakPending, largestLoopGapMs: Math.round(largestLoopGap), elapsedMs: Math.round(performance.now() - start) })
        await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2))
        console.log(JSON.stringify(result))
        await host.stop()
    }
} else throw Error('Expected run or writer')
