export type CodexKeyProfileMeta = { id: string; label: string; homeId?: string }
export type CodexKeyProfile = CodexKeyProfileMeta & { env: Record<string, string> }

/** Secrets live only in the runner/CLI environment; metadata carries labels. */
export function readCodexKeyProfiles(env: NodeJS.ProcessEnv = process.env): CodexKeyProfile[] {
    const raw = env.HAPI_CODEX_KEY_PROFILES?.trim()
    if (!raw) return []
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return [] }
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const profiles: CodexKeyProfile[] = []
    for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue
        const value = entry as Record<string, unknown>
        const id = typeof value.id === 'string' ? value.id.trim() : ''
        const label = typeof value.label === 'string' ? value.label.trim() : id
        if (!id || seen.has(id)) continue
        if (!value.env || typeof value.env !== 'object' || Array.isArray(value.env)) continue
        const profileEnv: Record<string, string> = {}
        for (const [key, envValue] of Object.entries(value.env as Record<string, unknown>)) {
            if (typeof envValue === 'string' && key.trim()) profileEnv[key] = envValue
        }
        if (Object.keys(profileEnv).length === 0) continue
        seen.add(id)
        profiles.push({ id, label, ...(typeof value.homeId === 'string' && value.homeId.trim() ? { homeId: value.homeId.trim() } : {}), env: profileEnv })
    }
    return profiles
}

export function codexKeyProfileMetadata(env: NodeJS.ProcessEnv = process.env): CodexKeyProfileMeta[] {
    return readCodexKeyProfiles(env).map(({ id, label, homeId }) => ({ id, label, ...(homeId ? { homeId } : {}) }))
}

export function resolveCodexKeyProfile(id: string, env: NodeJS.ProcessEnv = process.env): CodexKeyProfile {
    const profile = readCodexKeyProfiles(env).find(candidate => candidate.id === id)
    if (!profile) throw new Error(`Unknown Codex key profile: ${id}`)
    return profile
}
