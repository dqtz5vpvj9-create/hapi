import { isObject } from '@hapi/protocol'
import type {
    AgentReasoningBlock,
    AgentTextBlock,
    ChatBlock,
    ToolCallBlock,
    UserTextBlock,
} from '@/chat/types'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import { getCommandPresentation } from '@/components/ToolCard/commandPresentation'
import type { SubagentMessage } from './types'

/** Codex shell invocations render through the same command card as the root chat. */
const COMMAND_NAMES = new Set(['exec_command', 'shell_command', 'shell', 'local_shell', 'exec', 'CodexBash'])

type ToolPair = {
    call?: SubagentMessage
    result?: SubagentMessage
}

function textBlock(message: SubagentMessage): VisibleChatBlock | null {
    if (!message.text) return null
    if (message.role === 'user') {
        const block: UserTextBlock = {
            kind: 'user-text',
            id: message.id,
            localId: null,
            createdAt: message.createdAt,
            // A child transcript user message has already been delivered; it is
            // never a queued root input, so mark it invoked for the runtime.
            invokedAt: message.createdAt,
            text: message.text,
        }
        return block
    }
    if (message.kind === 'reasoning') {
        const block: AgentReasoningBlock = {
            kind: 'agent-reasoning',
            id: message.id,
            localId: null,
            createdAt: message.createdAt,
            text: message.text,
        }
        return block
    }
    const block: AgentTextBlock = {
        kind: 'agent-text',
        id: message.id,
        localId: null,
        createdAt: message.createdAt,
        text: message.text,
    }
    return block
}

function resultError(result: SubagentMessage | undefined): boolean {
    if (!result) return false
    if (result.isError === true) return true
    const output = result.output
    return isObject(output) && (output.is_error === true || output.isError === true || output.success === false)
}

function toolBlock(call: SubagentMessage | undefined, result: SubagentMessage | undefined, fallback: SubagentMessage): ToolCallBlock {
    const owner = call ?? fallback
    const name = owner.toolName ?? 'Tool'
    const output = result?.output ?? result?.text
    const error = resultError(result)
    const tool: ToolCallBlock = {
        kind: 'tool-call',
        id: owner.id,
        localId: null,
        createdAt: owner.createdAt,
        children: [],
        tool: {
            id: owner.callId ?? owner.id,
            name: COMMAND_NAMES.has(name) ? 'CodexBash' : name,
            input: call?.input ?? call?.text,
            result: output,
            state: error ? 'error' : result ? 'completed' : 'pending',
            createdAt: owner.createdAt,
            startedAt: owner.createdAt || null,
            completedAt: result?.createdAt || null,
            execStartedAt: owner.createdAt || null,
            execCompletedAt: result?.createdAt || null,
            description: null,
        },
    }
    if (result && COMMAND_NAMES.has(name) && getCommandPresentation(tool.tool).isError) tool.tool.state = 'error'
    return tool
}

/**
 * Project a child transcript onto the root chat block vocabulary so the same
 * assistant-ui thread components can render it. Tool calls pair with their
 * results by explicit `callId`; an orphan result still surfaces as a tool block
 * instead of being dropped, and unpaired calls stay `pending`.
 */
export function projectSubagentBlocks(messages: readonly SubagentMessage[]): VisibleChatBlock[] {
    const pairs = new Map<string, ToolPair>()
    for (const message of messages) {
        if (!message.callId) continue
        const pair = pairs.get(message.callId) ?? {}
        if (message.kind === 'tool-call') {
            pair.call ??= message
        } else if (message.kind === 'tool-result') {
            pair.result ??= message
        } else {
            continue
        }
        pairs.set(message.callId, pair)
    }

    const blocks: VisibleChatBlock[] = []
    const seen = new Set<string>()
    const emittedCalls = new Set<string>()
    for (const message of messages) {
        if (seen.has(message.id)) continue
        seen.add(message.id)
        const pair = message.callId ? pairs.get(message.callId) : undefined
        if (message.kind === 'tool-result') {
            if (!message.callId || !pair?.call) {
                blocks.push(toolBlock(undefined, message, message))
            }
            continue
        }
        if (message.kind === 'tool-call' || message.role === 'tool') {
            if (message.callId && pair?.call && pair.call !== message) {
                // A duplicate call row for the same native call id; the first
                // row already owns the tool block.
                continue
            }
            const callKey = message.callId ?? message.id
            if (message.kind === 'tool-call') {
                if (emittedCalls.has(callKey)) continue
                emittedCalls.add(callKey)
                blocks.push(toolBlock(message, pair?.result, message))
                continue
            }
        }
        const block = textBlock(message)
        if (block) blocks.push(block)
    }
    return blocks
}

/** Convenience for consumers that only need the concrete chat blocks. */
export function projectSubagentChatBlocks(messages: readonly SubagentMessage[]): ChatBlock[] {
    return projectSubagentBlocks(messages) as ChatBlock[]
}
