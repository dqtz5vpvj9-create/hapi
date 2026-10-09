import { link, open, readFile, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { getProcessStartMarker, isProcessAlive } from '@/utils/process'

/** Atomic publication, following the Runner's existing hard-link lock design.
 * The OS start marker distinguishes a restarted host from a reused PID after boot. */
export async function lockTerminalHost(path: string): Promise<() => Promise<void>> {
    const marker = getProcessStartMarker(process.pid)
    if (!marker) throw new Error('Cannot determine terminal host process identity')
    const candidate = `${path}.${process.pid}.${randomUUID()}`
    const handle = await open(candidate, 'wx', 0o600)
    try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, marker }))
        for (;;) {
            try { await link(candidate, path); break }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
                try {
                    const observed = await stat(path)
                    const owner = JSON.parse(await readFile(path, 'utf8')) as { pid: number; marker: string }
                    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.marker) throw new Error('Invalid terminal host lock')
                    const currentMarker = getProcessStartMarker(owner.pid)
                    if (currentMarker === owner.marker || (!currentMarker && isProcessAlive(owner.pid))) throw new Error('Terminal host is already running')
                    const current = await stat(path)
                    if (observed.ino === current.ino && observed.mtimeMs === current.mtimeMs) await unlink(path)
                } catch (readError) {
                    if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError
                }
            }
        }
    } finally { await handle.close(); await unlink(candidate) }
    return async () => { await unlink(path) }
}
