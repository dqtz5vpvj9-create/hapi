import { isObject } from '@hapi/protocol'
import type { ToolCallBlock } from '@/chat/types'
import type { SubagentMessage } from './codexSubagentHistory'
import { getCommandPresentation } from './ToolCard/commandPresentation'

export type SubagentTranscriptEntry = { message: SubagentMessage; tool?: ToolCallBlock; incomplete?: boolean }
const COMMAND_NAMES = new Set(['exec_command', 'shell_command', 'shell', 'local_shell', 'exec', 'CodexBash'])

/** Pair only explicit native call IDs, including results on a later page. */
export function projectSubagentTranscript(messages: SubagentMessage[]): SubagentTranscriptEntry[] {
    const calls = new Map<string, SubagentMessage>()
    const results = new Map<string, SubagentMessage>()
    for (const message of messages) {
        if (!message.callId) continue
        if (message.kind === 'tool-call') calls.set(message.callId, message)
        if (message.kind === 'tool-result') results.set(message.callId, message)
    }
    return messages.flatMap(message => {
        if (message.kind === 'tool-result' && message.callId && calls.has(message.callId)) return []
        if (message.kind !== 'tool-call') return [{ message }]
        const result = message.callId ? results.get(message.callId) : undefined
        const name = message.toolName ?? 'Tool'
        const output = result?.output ?? result?.text
        const error = result?.isError || (isObject(output) && (output.is_error === true || output.isError === true || output.success === false))
        const tool: ToolCallBlock = { kind: 'tool-call', id: message.id, localId: null, createdAt: message.createdAt, children: [],
            tool: { id: message.callId ?? message.id, name: COMMAND_NAMES.has(name) ? 'CodexBash' : name,
                input: message.input ?? message.text, result: output, state: error ? 'error' : result ? 'completed' : 'pending',
                createdAt: message.createdAt, startedAt: message.createdAt || null, completedAt: result?.createdAt || null,
                execStartedAt: message.createdAt || null, execCompletedAt: result?.createdAt || null, description: null } }
        if (result && COMMAND_NAMES.has(name) && getCommandPresentation(tool.tool).isError) tool.tool.state = 'error'
        return [{ message, tool, incomplete: !result }]
    })
}
