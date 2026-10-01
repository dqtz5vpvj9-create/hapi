import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { dir, faults } = vi.hoisted(() => {
    const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
    const { tmpdir } = require('node:os') as typeof import('node:os')
    const { join } = require('node:path') as typeof import('node:path')
    return { dir: mkdtempSync(join(tmpdir(), 'hapi-runner-lock-')), faults: { write: false } }
})

vi.mock('@/configuration', () => ({ configuration: {
    runnerLockFile: join(dir, 'runner.lock'),
    runnerStateFile: join(dir, 'runner.json'),
} }))
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await actual.open(...args)
        if (faults.write) {
            vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
        }
        return handle
    } }
})

import { acquireRunnerLock, releaseRunnerLock } from './persistence'

const lock = join(dir, 'runner.lock')
function oldLock(content: string) {
    writeFileSync(lock, content)
    const date = new Date(Date.now() - 60_000)
    utimesSync(lock, date, date)
}

afterEach(() => {
    faults.write = false
    for (const name of readdirSync(dir)) rmSync(join(dir, name), { force: true })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('runner lock recovery', () => {
    it('publishes its PID and excludes concurrent starters', async () => {
        const attempts = await Promise.all(Array.from({ length: 8 }, () => acquireRunnerLock(1, 0)))
        const owners = attempts.filter(x => x !== null)
        expect(owners).toHaveLength(1)
        expect(readFileSync(lock, 'utf8')).toBe(String(process.pid))
        expect(readdirSync(dir)).toEqual(['runner.lock'])
        await releaseRunnerLock(owners[0]!)
        expect(existsSync(lock)).toBe(false)
    })

    it.each(['', 'not-a-pid', '0', '-1'])('recovers abandoned malformed lock %j', async (content) => {
        oldLock(content)
        const handle = await acquireRunnerLock(1, 0)
        expect(handle).not.toBeNull()
        expect(readFileSync(lock, 'utf8')).toBe(String(process.pid))
        await releaseRunnerLock(handle!)
    })

    it('allows a legacy owner time to initialize its empty lock', async () => {
        writeFileSync(lock, '')
        await expect(acquireRunnerLock(1, 0)).rejects.toThrow('retry startup')
        expect(readFileSync(lock, 'utf8')).toBe('')
    })

    it('preserves a live owner even when its lock is old', async () => {
        oldLock(String(process.pid))
        expect(await acquireRunnerLock(1, 0)).toBeNull()
    })

    it('preserves an empty lock when runner state identifies a live owner', async () => {
        oldLock('')
        writeFileSync(join(dir, 'runner.json'), JSON.stringify({ pid: process.pid }))
        expect(await acquireRunnerLock(1, 0)).toBeNull()
    })

    it('does not publish an empty lock or hide a PID write failure', async () => {
        faults.write = true
        await expect(acquireRunnerLock(1, 0)).rejects.toMatchObject({ code: 'ENOSPC' })
        expect(readdirSync(dir)).toEqual([])
        faults.write = false
        const handle = await acquireRunnerLock(1, 0)
        expect(handle).not.toBeNull()
        await releaseRunnerLock(handle!)
    })

    it('keeps a single owner when starters concurrently recover an empty lock', async () => {
        oldLock('')
        const attempts = await Promise.all(Array.from({ length: 8 }, () => acquireRunnerLock(1, 0)))
        const owners = attempts.filter(x => x !== null)
        expect(owners).toHaveLength(1)
        await releaseRunnerLock(owners[0]!)
    })
})
