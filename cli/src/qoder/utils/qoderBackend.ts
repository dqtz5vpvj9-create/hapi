import { AcpSdkBackend } from '@/agent/backends/acp'
import type {
    AcpConfigOptionDescriptor,
    AcpSessionModelsMetadata
} from '@/agent/backends/acp/AcpSdkBackend'
import { getAgentLaunchCommand, resolveExecutable } from '@/agent/agentLaunchCommand'
import type { PermissionMode } from '../types'

type QoderAcpEnvironment = Record<string, string | undefined>

/** The ACP server is the only launch mode; Qoder CN is remote-only in HAPI. */
const QODER_ACP_ARGS = ['--acp'] as const

/**
 * Older Qoder CN installs expose the unified `qodercn` binary instead of the
 * split `qoderclicn` entry point. Both speak the same ACP stdio protocol.
 */
const LEGACY_QODER_COMMAND = 'qodercn'

function filterEnv(env: QoderAcpEnvironment): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    )
}

/**
 * Picks the Qoder CN executable shared by the launcher and the availability
 * probe: an explicit `HAPI_QODER_PATH`, else `qoderclicn`, else the legacy
 * `qodercn` when only that one is installed.
 */
export function resolveQoderCommand(env: QoderAcpEnvironment = process.env): string {
    const configured = getAgentLaunchCommand('qoder', env)
    if (env.HAPI_QODER_PATH?.trim()) return configured

    const lookup = { pathValue: env.PATH, pathExt: env.PATHEXT }
    if (resolveExecutable(configured, lookup)) return configured
    if (resolveExecutable(LEGACY_QODER_COMMAND, lookup)) return LEGACY_QODER_COMMAND
    // Neither install was found; keep the canonical name so the availability
    // probe reports the same command the launcher would have tried.
    return configured
}

export function resolveQoderAcpCommand(env: QoderAcpEnvironment = process.env): {
    command: string
    args: string[]
} {
    return { command: resolveQoderCommand(env), args: [...QODER_ACP_ARGS] }
}

// The live ACP session catalog uses HAPI's camelCase ids; older Qoder CLI
// builds exposed the CLI flag spelling instead, so keep those as fallbacks.
const QODER_PERMISSION_MODE_CANDIDATES: Record<PermissionMode, readonly string[]> = {
    default: ['default'],
    acceptEdits: ['acceptEdits', 'accept_edits'],
    plan: ['plan'],
    bypassPermissions: ['bypassPermissions', 'bypass_permissions']
}

/**
 * Resolve a HAPI permission id against the modes the ACP session actually
 * advertises. `available` is the server's mode list; when it is unavailable
 * the canonical id is used so an older build can still be probed.
 */
export function resolveQoderPermissionModeId(
    mode: PermissionMode | undefined,
    available?: readonly string[]
): string {
    const candidates = QODER_PERMISSION_MODE_CANDIDATES[mode ?? 'default']
    if (!available || available.length === 0) return candidates[0]
    return candidates.find((candidate) => available.includes(candidate)) ?? candidates[0]
}

/** Canonical HAPI-to-Qoder mode id (before server-side resolution). */
export function qoderPermissionModeId(mode: PermissionMode | undefined): string {
    return QODER_PERMISSION_MODE_CANDIDATES[mode ?? 'default'][0]
}

export function createQoderBackend(env: QoderAcpEnvironment = process.env): AcpSdkBackend {
    const { command, args } = resolveQoderAcpCommand(env)
    return new AcpSdkBackend({
        command,
        args,
        env: filterEnv(env),
        flavor: 'qoder',
        // An unauthenticated session/new rejects deterministically. Retrying it
        // only delays the actionable login error, and an ambiguous timeout must
        // never create a second ACP session on the agent side.
        retrySessionActivation: false
    })
}

/**
 * Qoder CN reports reasoning effort as the `reasoning_effort` config option
 * (it is misfiled under `category: 'model'`). Newer builds may use ACP's
 * standard `thought_level` category instead, so accept either.
 */
export function qoderEffortOption(
    options: AcpConfigOptionDescriptor[] | undefined
): AcpConfigOptionDescriptor | undefined {
    return options?.find((option) => option.id === 'reasoning_effort')
        ?? options?.find((option) => option.category === 'thought_level')
}

/**
 * Resolve a requested effort against the session's advertised levels. `null`
 * means "restore the launch-time default"; an unadvertised level is rejected so
 * the composer never silently keeps a different setting.
 */
export function resolveQoderEffortValue(
    requested: string | null,
    option: AcpConfigOptionDescriptor | undefined,
    fallback: string | null
): string | null {
    if (!option) throw new Error('Qoder CN does not advertise a reasoning effort option')
    const values = option.options.map((entry) => entry.value)
    if (requested === null) {
        const preferred = fallback ?? option.currentValue ?? values[0] ?? null
        return preferred !== null && values.includes(preferred) ? preferred : (values[0] ?? null)
    }
    if (!values.includes(requested)) {
        throw new Error(`Qoder CN does not advertise reasoning effort "${requested}"`)
    }
    return requested
}

/**
 * Qoder's ACP session advertises its model catalog through the standard
 * `models`/`availableModels` shape, not always through `configOptions`. The web
 * composer reads `qoderConfigOptions`, so synthesize the `model` option from
 * the catalog when the server did not already send one. A server-provided
 * option always wins so groups/labels and reasoning metadata are preserved.
 */
export function configOptionsWithModels(
    options: AcpConfigOptionDescriptor[],
    models: AcpSessionModelsMetadata | undefined
): AcpConfigOptionDescriptor[] {
    if (!models || models.availableModels.length === 0) return options
    if (options.some((option) => option.category === 'model' || option.id === 'model')) return options
    return [
        ...options,
        {
            id: 'model',
            name: 'Model',
            category: 'model',
            currentValue: models.currentModelId ?? undefined,
            options: models.availableModels.map((model) => ({
                value: model.modelId,
                name: model.name
            }))
        }
    ]
}

function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim() !== '') return error.message
    if (typeof error === 'object' && error !== null) {
        const message = (error as { message?: unknown }).message
        if (typeof message === 'string' && message.trim() !== '') return message
        try { return JSON.stringify(error) } catch { return String(error) }
    }
    return String(error)
}

function diagnosticSuffix(error: unknown): string {
    if (typeof error !== 'object' || error === null) return ''
    const rpc = error as { code?: unknown; data?: unknown; raw?: unknown }
    const parts: string[] = []
    if (typeof rpc.code === 'number') parts.push(`code ${rpc.code}`)
    if (rpc.data !== undefined) {
        try { parts.push(JSON.stringify(rpc.data).slice(0, 2_000)) } catch { parts.push(String(rpc.data)) }
    }
    if (typeof rpc.raw === 'string' && rpc.raw.trim() !== '') parts.push(rpc.raw.trim().slice(0, 2_000))
    return parts.length > 0 ? `\n${parts.join(' · ')}` : ''
}

export const QODER_LOGIN_MESSAGE = 'Qoder CN is not signed in on this machine. Run "qoderclicn login" once, then retry.'

/**
 * Normalizes Qoder/ACP failures into an operator-facing message. The common
 * failure on a fresh host is `session/new` rejecting with "Authentication
 * required"; HAPI must surface the one-time login command instead of a raw
 * JSON-RPC error.
 */
export function formatQoderError(
    error: unknown,
    source: 'prompt' | 'stderr' | 'activation' = 'prompt'
): { message: string; details: string } {
    const base = errorMessage(error)
    const details = `${base}${diagnosticSuffix(error)}`
    if (details.includes(QODER_LOGIN_MESSAGE)) return { message: QODER_LOGIN_MESSAGE, details }
    if (/authentication required|not logged in|not signed in|please run \/login|qoderclicn\s+login/i.test(details)) {
        return { message: QODER_LOGIN_MESSAGE, details }
    }
    if (/does not declare image input|does not support image/i.test(base)) {
        return {
            message: 'The selected Qoder CN model does not declare image input. Switch models or describe the image in text.',
            details
        }
    }
    return {
        message: source === 'stderr'
            ? 'Qoder CN reported an error; expand the details for the agent output.'
            : source === 'activation'
                ? 'Qoder CN failed to start the ACP session; expand the details for the underlying error.'
                : 'Qoder CN request failed; expand the details for the underlying error.',
        details
    }
}
