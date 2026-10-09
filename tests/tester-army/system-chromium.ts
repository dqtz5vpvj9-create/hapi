import type { BrowserProvider } from '@e2e-dev/web'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Optional system Chromium for isolated Linux containers with no bundled browser. */
export function systemChromium(executable: string): BrowserProvider {
    const leases = new Map<string, { child: ChildProcess; directory: string }>()
    async function dispose(child: ChildProcess, directory: string): Promise<void> {
        if (child.exitCode === null && child.signalCode === null) {
            await new Promise<void>((resolve) => {
                child.once('exit', () => resolve())
                child.kill('SIGTERM')
            })
        }
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    return {
        name: 'system-chromium',
        async acquire() {
            const directory = await mkdtemp(join(tmpdir(), 'hapi-e2e-browser-'))
            const child = spawn(executable, [
                '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
                '--remote-debugging-port=0', `--user-data-dir=${directory}`, 'about:blank',
            ], { stdio: ['ignore', 'ignore', 'pipe'] })
            try {
                const cdpEndpoint = await new Promise<string>((resolve, reject) => {
                    let log = ''
                    const timer = setTimeout(() => reject(new Error(`Chromium launch timed out: ${log}`)), 30_000)
                    child.stderr?.on('data', (chunk) => {
                        log = (log + String(chunk)).slice(-4000)
                        const match = log.match(/DevTools listening on (ws:\/\/\S+)/)
                        if (match) { clearTimeout(timer); resolve(match[1]) }
                    })
                    child.once('error', (error) => { clearTimeout(timer); reject(error) })
                    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Chromium exited ${code}: ${log}`)) })
                })
                const id = String(child.pid)
                leases.set(id, { child, directory })
                return { id, cdpEndpoint }
            } catch (error) {
                if (child.pid) await dispose(child, directory)
                else await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
                throw error
            }
        },
        async release(lease) {
            const item = leases.get(lease.id)
            if (!item) return
            leases.delete(lease.id)
            await dispose(item.child, item.directory)
        },
    }
}
