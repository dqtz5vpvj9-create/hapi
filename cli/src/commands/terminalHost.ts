import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveHapiHomeDir } from '@/configuration'
import type { CommandDefinition } from './types'

export const terminalHostCommand: CommandDefinition = {
    name: 'terminal-host', requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        const { values } = parseArgs({ args: commandArgs, strict: true, options: {
            directory: { type: 'string' }, 'workspace-root': { type: 'string', multiple: true },
        } })
        const { startTerminalHost } = await import('@/terminal/terminalHostServer')
        const host = await startTerminalHost({ directory: values.directory ?? join(resolveHapiHomeDir(), 'terminal-host'), workspaceRoots: values['workspace-root'] })
        console.log(`Terminal host ready (pid ${process.pid})`)
        let stopping = false
        const stop = async () => {
            if (stopping) return
            stopping = true
            await host.stop()
            process.exit(0)
        }
        process.once('SIGTERM', stop); process.once('SIGINT', stop)
    },
}
