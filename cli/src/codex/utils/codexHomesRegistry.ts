import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { configuration } from '@/configuration'
import { expandCodexHomePath, resolveCodexHome } from './codexHome'
import type { CodexHome } from '@hapi/protocol/apiTypes'

const FILE_NAME = 'codex-homes.json'

function registryPath(): string {
    return join(configuration.happyHomeDir, FILE_NAME)
}

function defaultHome(): CodexHome {
    return { id: 'default', label: 'Default', path: resolveCodexHome(), official: true }
}

function isHome(value: unknown): value is CodexHome {
    if (!value || typeof value !== 'object') return false
    const home = value as Record<string, unknown>
    return typeof home.id === 'string' && home.id.length > 0
        && typeof home.label === 'string' && home.label.length > 0
        && typeof home.path === 'string' && home.path.length > 0
}

async function readPersisted(): Promise<CodexHome[]> {
    try {
        const parsed = JSON.parse(await readFile(registryPath(), 'utf8'))
        const homes = Array.isArray(parsed?.homes) ? parsed.homes.filter(isHome) : []
        return homes.map((home: CodexHome) => ({ ...home, path: resolve(home.path) }))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
    }
}

async function writePersisted(homes: CodexHome[]): Promise<void> {
    await mkdir(configuration.happyHomeDir, { recursive: true, mode: 0o700 })
    const target = registryPath()
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, homes }, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, target)
}

function validatePath(path: string): string {
    const absolute = resolve(expandCodexHomePath(path))
    if (!existsSync(absolute)) throw new Error(`Codex home does not exist: ${absolute}`)
    if (!statSync(absolute).isDirectory()) throw new Error(`Codex home is not a directory: ${absolute}`)
    return absolute
}

export async function listCodexHomes(): Promise<CodexHome[]> {
    const defaultEntry = defaultHome()
    const persisted = await readPersisted()
    const seen = new Set<string>([defaultEntry.id])
    const homes: CodexHome[] = [defaultEntry]
    for (const home of persisted) {
        if (seen.has(home.id)) continue
        seen.add(home.id)
        homes.push(home)
    }
    return homes
}

export async function saveCodexHome(input: { id?: string; label: string; path: string; official?: boolean }): Promise<CodexHome[]> {
    const path = validatePath(input.path)
    const homes = await readPersisted()
    if (input.official) throw new Error('The official Codex home is managed by the default account switcher')
    const id = input.id?.trim() || `home-${randomUUID().slice(0, 8)}`
    if (id === 'default') throw new Error('The default Codex home cannot be replaced')
    const next = homes.filter(home => home.id !== id)
    next.push({ id, label: input.label.trim(), path, ...(input.official ? { official: true } : {}) })
    await writePersisted(next)
    return listCodexHomes()
}

export async function deleteCodexHome(id: string): Promise<CodexHome[]> {
    if (id === 'default') throw new Error('The default Codex home cannot be deleted')
    const homes = await readPersisted()
    if (!homes.some(home => home.id === id)) throw new Error(`Unknown Codex home: ${id}`)
    await writePersisted(homes.filter(home => home.id !== id))
    return listCodexHomes()
}
