import chalk from 'chalk'
import { QODER_PERMISSION_MODES } from '@hapi/protocol/modes'
import { initializeToken } from '@/ui/tokenInit'
import { maybeAutoStartServer } from '@/utils/autoStartServer'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { parseRemoteAgentCommandOptions } from './agentCommandOptions'
import type { CommandDefinition } from './types'

export function parseQoderCommandOptions(commandArgs: string[]) {
    const options = parseRemoteAgentCommandOptions(commandArgs, QODER_PERMISSION_MODES, ['remote'])
    return { ...options, startingMode: 'remote' as const }
}

export const qoderCommand: CommandDefinition = {
    name: 'qoder',
    requiresRuntimeAssets: true,
    run: async ({ commandArgs }) => {
        try {
            const options = parseQoderCommandOptions(commandArgs)
            await initializeToken()
            await maybeAutoStartServer()
            await authAndSetupMachineIfNeeded()

            const { runQoder } = await import('@/qoder/runQoder')
            await runQoder(options)
        } catch (error) {
            console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
            if (process.env.DEBUG) console.error(error)
            process.exit(1)
        }
    }
}
