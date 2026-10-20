import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const roots: string[] = []
afterEach(async () => {
    vi.unstubAllEnvs()
    vi.resetModules()
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function loadRegistry() {
    const root = await mkdtemp(join(tmpdir(), 'hapi-codex-homes-'))
    roots.push(root)
    vi.stubEnv('HAPI_HOME', root)
    vi.resetModules()
    return await import('./codexHomesRegistry')
}

describe('codex home registry', () => {
    it('starts with the default official home and adds an isolated home', async () => {
        const registry = await loadRegistry()
        expect((await registry.listCodexHomes())[0]).toMatchObject({ id: 'default', official: true })
        const homes = await registry.saveCodexHome({ label: 'IPADS', path: join(process.cwd(), '..') })
        expect(homes.some(home => home.label === 'IPADS')).toBe(true)
        expect((await registry.listCodexHomes()).length).toBe(2)
    })

    it('does not allow a second official home or deleting the default', async () => {
        const registry = await loadRegistry()
        await expect(registry.saveCodexHome({ label: 'Official 2', path: process.cwd(), official: true }))
            .rejects.toThrow('official Codex home')
        await expect(registry.deleteCodexHome('default')).rejects.toThrow('cannot be deleted')
    })
})
