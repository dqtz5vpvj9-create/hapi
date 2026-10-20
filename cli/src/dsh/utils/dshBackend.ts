import { AcpSdkBackend } from '@/agent/backends/acp'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'

type DshAcpEnvironment = Record<string, string | undefined>

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    )
}

function parseArgsJson(raw: string): string[] {
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch {
        throw new Error('HAPI_DSH_ACP_ARGS_JSON must be a JSON array of strings')
    }
    if (!Array.isArray(value) || value.some((arg) => typeof arg !== 'string')) {
        throw new Error('HAPI_DSH_ACP_ARGS_JSON must be a JSON array of strings')
    }
    return value
}

function isOfficialDshExecutable(command: string): boolean {
    const commandName = command.replaceAll('\\', '/').split('/').at(-1) ?? command
    return /^dsh(?:\.(?:exe|cmd|bat))?$/i.test(commandName)
}

/** True when this launch path enters the official DSH Cordis runtime, which
 * exposes the control-plugin services. A wrapper such as `pnpm ... dsh` can set
 * HAPI_DSH_ACP_OFFICIAL=1 to opt into the same treatment. */
export function isOfficialDshAcpCommand(command: string, env: DshAcpEnvironment = process.env): boolean {
    const override = env.HAPI_DSH_ACP_OFFICIAL?.trim().toLowerCase()
    if (override === '1' || override === 'true') return true
    if (override === '0' || override === 'false') return false
    return isOfficialDshExecutable(command)
}

export function resolveDshAcpCommand(env: DshAcpEnvironment = process.env): {
    command: string
    args: string[]
} {
    const command = getAgentLaunchCommand('dsh', env)
    if (env.HAPI_DSH_ACP_ARGS_JSON?.trim()) {
        return { command, args: parseArgsJson(env.HAPI_DSH_ACP_ARGS_JSON.trim()) }
    }
    // The official CLI serves ACP through a profile. An explicit community
    // server keeps its own argument contract; JSON arguments override either.
    const officialCli = isOfficialDshExecutable(command)
    const args = officialCli ? ['--profile', 'acp'] : []
    const config = env.HAPI_DSH_ACP_CONFIG?.trim()
    if (config) args.push(officialCli ? '--patch' : '--config', config)
    return { command, args }
}

export function dshSandboxMode(mode?: string): string {
    if (mode === 'yolo') return 'danger-full-access'
    if (mode === 'read-only') return 'read-only'
    return 'workspace-write'
}

export function createDshBackend(env: NodeJS.ProcessEnv = process.env, permissionMode?: string, controlPatch?: string): AcpSdkBackend {
    const { command, args } = resolveDshAcpCommand(env)
    if (controlPatch) args.push('--patch', controlPatch)
    return new AcpSdkBackend({
        command,
        args,
        env: { ...filterEnv(env), DSH_PERMISSION_MODE: dshSandboxMode(permissionMode) },
        flavor: 'dsh',
        retrySessionActivation: false,
        // DSH sends one committed assistant message per update (with its own
        // message identity), so two legitimate "a" blocks must both arrive.
        // The generic dedupe mode would silently drop the second one.
        textChunkMode: 'delta'
    })
}
