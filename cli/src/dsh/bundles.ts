import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { withSettingsFileLock } from '@hapi/protocol/settingsFileLock'

/** Profile HAPI launches the DeepSeek Harness agent with. */
export const HAPI_DSH_PROFILE = 'acp'

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import type { DshBundleEntry, DshBundleProfile, DshBundleState } from '@hapi/protocol/apiTypes'

export type { DshBundleState }

const BUNDLE_NAME = /^@?[a-z0-9][a-z0-9._/-]*$/i

function resolveDshHome(): string {
    const configured = process.env.DSH_HOME?.trim()
    return configured ? configured : join(homedir(), '.dsh')
}

function profilePackagePath(dshHome: string, profile: string): string {
    return join(dshHome, 'profiles', profile, 'package.json')
}

function restartMarkerPath(dshHome: string, profile: string): string {
    return join(dshHome, 'profiles', profile, '.hapi-restart-required')
}

/** A saved bundle change has not been observed by a new DSH process yet. */
export async function clearDshRestartRequired(profile = HAPI_DSH_PROFILE): Promise<void> {
    await rm(restartMarkerPath(resolveDshHome(), profile), { force: true })
}

/** Reject names that cannot be a package specifier, so a bad write cannot wedge the profile. */
export function assertBundleName(name: unknown): string {
    if (typeof name !== 'string') throw new Error('Bundle name must be a string')
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > 214 || !BUNDLE_NAME.test(trimmed)) {
        throw new Error(`Invalid bundle name: ${String(name)}`)
    }
    return trimmed
}

async function readProfileFile(dshHome: string, profile: string): Promise<Record<string, unknown>> {
    const raw = await readFile(profilePackagePath(dshHome, profile), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Profile package is not a JSON object: ${profile}`)
    }
    return parsed as Record<string, unknown>
}

function bundlesOf(profilePackage: Record<string, unknown>): string[] {
    const dsh = profilePackage.dsh
    if (dsh === null || typeof dsh !== 'object') return []
    const profile = (dsh as Record<string, unknown>).profile
    if (profile === null || typeof profile !== 'object') return []
    const bundles = (profile as Record<string, unknown>).bundles
    if (!Array.isArray(bundles)) return []
    return bundles.filter((entry): entry is string => typeof entry === 'string')
}

/** Read the bundle list of one profile. */
export async function readDshBundles(profile = HAPI_DSH_PROFILE): Promise<DshBundleProfile> {
    const dshHome = resolveDshHome()
    const packageJson = await readProfileFile(dshHome, profile)
    return { profile, dshHome, bundles: bundlesOf(packageJson) }
}

/**
 * Replace the bundle list of one profile, keeping every other profile field.
 * @param bundles - bundle package names in load order.
 * @param profile - profile directory name.
 * @returns the state after the write.
 */
async function writeDshBundlesUnlocked(bundles: readonly string[], profile: string, dshHome: string): Promise<DshBundleProfile> {
    const path = profilePackagePath(dshHome, profile)
    const next = [...new Set(bundles.map(assertBundleName))]
    const packageJson = await readProfileFile(dshHome, profile)
    const dsh = typeof packageJson.dsh === 'object' && packageJson.dsh !== null ? packageJson.dsh as Record<string, unknown> : {}
    const profileLayer = typeof dsh.profile === 'object' && dsh.profile !== null ? dsh.profile as Record<string, unknown> : {}
    packageJson.dsh = { ...dsh, profile: { ...profileLayer, bundles: next } }
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(packageJson, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
    return { profile, dshHome, bundles: next }
}

export async function writeDshBundles(bundles: readonly string[], profile = HAPI_DSH_PROFILE): Promise<DshBundleProfile> {
    const dshHome = resolveDshHome()
    const path = profilePackagePath(dshHome, profile)
    return await withSettingsFileLock(path, () => writeDshBundlesUnlocked(bundles, profile, dshHome))
}

/**
 * Locate the dsh installation that HAPI launches, so the bundle catalog is the
 * real set of packages that installation can compose.
 * @returns the directory that contains `node_modules/@deepseek-ai`, or null.
 */
/** Walk up to the package that owns one entry file. */
function packageRootOf(start: string): string | null {
    let directory = start
    for (let depth = 0; depth < 6; depth += 1) {
        if (existsSync(join(directory, 'package.json'))) return directory
        const parent = dirname(directory)
        if (parent === directory) break
        directory = parent
    }
    return null
}

function resolveDshInstallRoot(): string | null {
    const configured = process.env.HAPI_DSH_INSTALL_ROOT?.trim()
    if (configured && existsSync(configured)) return configured
    let candidate: string
    try {
        candidate = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
    } catch {
        return null
    }
    if (!candidate) return null
    try {
        let target = realpathSync(candidate)
        // A wrapper script forwards to the real entry point on its exec line,
        // which may be `exec node /path/bin.js` or `exec /path/hapi`.
        if (target.endsWith('.js')) return packageRootOf(dirname(target))
        const script = readFileSync(target, 'utf8')
        const line = /^exec\s+(.+)$/m.exec(script)?.[1] ?? ''
        const entry = line.split(/\s+/).map((token) => token.replace(/^["']|["']$/g, ''))
            .find((token) => token.endsWith('.js'))
        if (entry === undefined) return null
        const resolved = realpathSync(entry)
        return packageRootOf(dirname(resolved))
    } catch {
        return null
    }
}

/**
 * The bundles a dsh installation offers to switch on, mirroring
 * `OPTIONAL_BUNDLES` in `@deepseek-ai/dsh-app-boot` (packages/boot/app-boot).
 * Profile templates such as base/web-app/headless are excluded upstream: they
 * define a runtime, they are not options inside one.
 */
/** Product subagent provider layers are optional even though upstream's
 * OPTIONAL_BUNDLES list only contains app-boot experimental layers. Keeping
 * them in the switchable set means disabling one leaves a row that can enable
 * it again, instead of vanishing from the catalog. */
const PROVIDER_BUNDLE_NAMES: readonly string[] = [
    '@deepseek-ai/dsh-subagent-codex',
    '@deepseek-ai/dsh-subagent-claude-code'
]

const OPTIONAL_BUNDLE_NAMES: readonly string[] = [
    '@deepseek-ai/dsh-experimental-session-search',
    '@deepseek-ai/dsh-experimental-ralph-bundle',
    '@deepseek-ai/dsh-experimental-terminal-bundle',
    '@deepseek-ai/dsh-experimental-badge-skill-bundle',
    '@deepseek-ai/dsh-experimental-session-titles-bundle',
    '@deepseek-ai/dsh-experimental-agent-team-profile',
    '@deepseek-ai/dsh-experimental-voice-input-bundle',
    '@deepseek-ai/dsh-experimental-cot-translation-bundle',
    '@deepseek-ai/dsh-experimental-auto-review',
    '@deepseek-ai/dsh-experimental-inspector-profile',
    '@deepseek-ai/dsh-experimental-plugin-market-bundle',
    '@deepseek-ai/dsh-experimental-tool-worktree'
]

const SWITCHABLE_BUNDLE_NAMES = new Set([...OPTIONAL_BUNDLE_NAMES, ...PROVIDER_BUNDLE_NAMES])

type BundleManifest = { name?: unknown; description?: unknown; dsh?: { bundle?: unknown } }

/**
 * Read every bundle package the dsh installation ships.
 * @param root - directory whose `node_modules/@deepseek-ai` holds the packages.
 * @returns package name -> one-line description.
 */
function scanInstalledBundles(root: string | null): Map<string, string> {
    const found = new Map<string, string>()
    if (!root) return found
    const scope = join(root, 'node_modules', '@deepseek-ai')
    let names: string[] = []
    try {
        names = readdirSync(scope)
    } catch {
        return found
    }
    for (const name of names) {
        try {
            const manifest = JSON.parse(readFileSync(join(scope, name, 'package.json'), 'utf8')) as BundleManifest
            if (typeof manifest.dsh?.bundle !== 'object' || manifest.dsh.bundle === null) continue
            if (typeof manifest.name !== 'string') continue
            found.set(manifest.name, typeof manifest.description === 'string' ? manifest.description : '')
        } catch {
            // A malformed package manifest is not a catalog entry.
        }
    }
    return found
}

/** Compose the bundle list with every bundle the installation can add. */
export async function listDshBundleCatalog(profile = HAPI_DSH_PROFILE): Promise<DshBundleState> {
    const state = await readDshBundles(profile)
    const installed = scanInstalledBundles(resolveDshInstallRoot())
    const enabled = new Set(state.bundles)
    const available: DshBundleEntry[] = state.bundles.map((name) => ({
        name,
        description: installed.get(name) ?? '',
        enabled: true,
        // Foundation/runtime layers stay visible but cannot be removed by a
        // profile switch; only optional and product-provider layers may move.
        switchable: SWITCHABLE_BUNDLE_NAMES.has(name)
    }))
    for (const [name, description] of [...installed].sort(([a], [b]) => a.localeCompare(b))) {
        if (enabled.has(name)) continue
        if (!SWITCHABLE_BUNDLE_NAMES.has(name)) continue
        available.push({ name, description, enabled: false, switchable: true })
    }
    return { ...state, available, restartRequired: existsSync(restartMarkerPath(state.dshHome, profile)) }
}

/** Toggle one bundle that the installation actually ships. */
export async function setDshBundle(name: string, enabled: boolean): Promise<DshBundleState> {
    const bundle = assertBundleName(name)
    const dshHome = resolveDshHome()
    const path = profilePackagePath(dshHome, HAPI_DSH_PROFILE)
    // Read, decide and write under the same lock: two clients toggling
    // different bundles must not overwrite each other's catalog snapshot.
    return await withSettingsFileLock(path, async () => {
        const catalog = await listDshBundleCatalog()
        const entry = catalog.available.find((candidate) => candidate.name === bundle)
        if (!entry) throw new Error(`Unknown bundle: ${bundle}`)
        if (!entry.switchable) throw new Error(`Bundle ${bundle} is required by the ${catalog.profile} profile`)
        const next = enabled
            ? [...catalog.bundles, entry.name]
            : catalog.bundles.filter((entryName) => entryName !== entry.name)
        await writeDshBundlesUnlocked(next, catalog.profile, catalog.dshHome)
        await writeFile(restartMarkerPath(catalog.dshHome, catalog.profile), new Date().toISOString(), { encoding: 'utf8', mode: 0o600 })
        // ACP disables HMR: the running DSH process keeps the composition it
        // booted with, so a saved change is not an applied change.
        return { ...(await listDshBundleCatalog()), restartRequired: true }
    })
}
