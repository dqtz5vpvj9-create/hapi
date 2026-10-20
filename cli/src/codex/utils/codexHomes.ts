import { resolveCodexHome } from './codexHome'

export type CodexHomePreset = {
    id: string
    label: string
    path: string
    official?: boolean
}

/**
 * Runner-local presets for the New Session picker. This is deliberately an
 * environment allowlist, not a Hub-owned registry: the Hub never needs to
 * write to the filesystem, and a path only becomes selectable when the machine
 * owner opted in.
 *
 * HAPI_CODEX_HOMES='[{"id":"ipads","label":"IPADS","path":"/home/me/.codex-ipads"}]'
 */
export function readCodexHomes(env: NodeJS.ProcessEnv = process.env): CodexHomePreset[] {
    const raw = env.HAPI_CODEX_HOMES?.trim()
    if (!raw) return []
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return [] }
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const homes: CodexHomePreset[] = []
    for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue
        const value = entry as Record<string, unknown>
        const id = typeof value.id === 'string' ? value.id.trim() : ''
        const label = typeof value.label === 'string' ? value.label.trim() : id
        const path = typeof value.path === 'string' ? value.path.trim() : ''
        if (!id || !path || seen.has(id)) continue
        seen.add(id)
        homes.push({ id, label, path, ...(value.official === true ? { official: true } : {}) })
    }
    return homes
}

/** Default home is always selectable even when no presets are configured. */
export function codexHomesForMachine(env: NodeJS.ProcessEnv = process.env): CodexHomePreset[] {
    const presets = readCodexHomes(env)
    if (presets.some(home => home.official === true)) return presets
    return [{ id: 'default', label: 'Default', path: resolveCodexHome(env), official: true }, ...presets]
}
