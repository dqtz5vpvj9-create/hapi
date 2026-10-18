import { isObject } from '@hapi/protocol'

/** Shared Codex command results carry execution failure in the native output. */
export function isCodexCommandResultError(output: unknown): boolean {
    // Other tools may return exit codes or status fields as ordinary data.
    // Infer execution state only from the native command-result envelope.
    if (!isObject(output) || output.type !== 'exec_command_end') return false
    const exitCode = output.exit_code
    return (typeof exitCode === 'number' && Number.isFinite(exitCode) && exitCode !== 0)
        || output.status === 'failed'
        || output.status === 'declined'
}
