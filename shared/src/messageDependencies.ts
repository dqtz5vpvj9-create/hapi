import { AGENT_MESSAGE_PAYLOAD_TYPE } from './modes'
import { isClaudeChatVisibleMessage, unwrapRoleWrappedRecordEnvelope } from './messages'
import { asString, isObject } from './utils'

export const MESSAGE_DEPENDENCY_VERSION = 4
export type MessageDependencyKind = 'tool_call' | 'tool_result' | 'subagent_call' | 'parent_tool_use'
    | 'sdk_uuid' | 'sdk_parent' | 'task_prompt' | 'sidechain_prompt' | 'text_stream' | 'reasoning_stream'
    | 'agent_run_agent' | 'agent_run_card' | 'agent_run_orphan'
export type MessageDependencyFact = { kind: MessageDependencyKind; key: string; ordinal: number }
export type MessageDependencyFacts = {
    status: 'indexed' | 'unsupported'
    isSidechain: boolean
    facts: MessageDependencyFact[]
}
export type MessageDependencyIssue = {
    messageId: string
    reason: 'index-incomplete' | 'unsupported' | 'missing-parent' | 'ambiguous-parent' | 'budget' | 'unreadable'
    relation?: MessageDependencyKind
}

export function isSubagentToolName(name: string): boolean {
    return name === 'Task' || name === 'Agent' || name.startsWith('Agent:') || name.startsWith('Task:')
}

export function sdkMessageIdentity(messageId: string, data: Record<string, unknown>) {
    return {
        uuid: asString(data.uuid) ?? messageId,
        parentUUID: asString(data.parentUuid),
        isSidechain: Boolean(data.isSidechain),
        parentToolUseId: asString(data.parentToolUseId),
    }
}

/** Exact prompt representation used by the legacy SDK sidechain matcher. */
export function sdkSidechainPrompt(content: unknown, isSidechain: boolean): string | null {
    if (typeof content === 'string') return content
    if (!isSidechain || !Array.isArray(content)) return null
    const text = content.filter(block => isObject(block) && block.type === 'text' && typeof block.text === 'string')
        .map(block => (block as { text: string }).text)
    return text.length ? text.join('\n\n') : null
}

/** Shared with the reducer: orphan starts with the same fingerprint replace
 * one another, while identified agents are joined by agent/card identity. */
export function getAgentRunFingerprint(event: Record<string, unknown>): string | null {
    const summary = asString(event.summary)
    if (summary) return summary
    const input = isObject(event.input) ? event.input : null
    const direct = input ? asString(input.message) ?? asString(input.prompt) : null
    if (direct) return direct.replace(/\s+/g, ' ').trim()
    if (input && Array.isArray(input.items)) {
        const text = input.items.map(item => isObject(item) ? asString(item.text) : null)
            .filter((part): part is string => Boolean(part)).join('\n\n').replace(/\s+/g, ' ').trim()
        return text.length ? text : null
    }
    return null
}

export function getAgentRunIdentity(event: Record<string, unknown>) {
    return {
        agentId: asString(event.agentId) ?? asString(event.agent_id),
        cardId: asString(event.cardId) ?? asString(event.card_id),
    }
}

/** Extract sparse relationships from canonical, already-truncated stored content.
 * Does not select parents or construct a rendering tree. Unsupported envelopes
 * remain explicit so an index reader cannot claim complete dependency coverage. */
export function extractMessageDependencyFacts(messageId: string, content: unknown): MessageDependencyFacts {
    const result: MessageDependencyFacts = { status: 'indexed', isSidechain: false, facts: [] }
    const add = (kind: MessageDependencyKind, key: string | null, ordinal = 0) => {
        if (key !== null) result.facts.push({ kind, key, ordinal })
    }
    const tool = (id: string, name: string, input: unknown, ordinal: number) => {
        add('tool_call', id, ordinal)
        if (isSubagentToolName(name)) {
            add('subagent_call', id, ordinal)
            if (isObject(input)) add('task_prompt', asString(input.prompt), ordinal)
        }
    }
    const record = unwrapRoleWrappedRecordEnvelope(content)
    if (record?.role === 'user') return result
    if (!record || record.role !== 'agent' || !isObject(record.content)) return { ...result, status: 'unsupported' }
    const envelope = record.content
    const data = isObject(envelope.data) ? envelope.data : null
    if ((envelope.type === 'event' || envelope.type === AGENT_MESSAGE_PAYLOAD_TYPE) && data
        && ['agent-run-start', 'agent-run-update', 'agent-run-trace'].includes(String(data.type))) {
        // All records of a card are reduced together, including nested traces.
        // Its raw inner call IDs must not join a different agent's tools.
        const { agentId, cardId } = getAgentRunIdentity(data)
        add('agent_run_agent', agentId)
        add('agent_run_card', cardId ?? (agentId ? `codex-agent:${agentId}` : messageId))
        if (!agentId && data.type === 'agent-run-start') add('agent_run_orphan', getAgentRunFingerprint(data))
        return result
    }
    if (envelope.type === 'event' && data && typeof data.type === 'string') return result
    if (envelope.type === 'output' && data) {
        if (data.isMeta || data.isCompactSummary || !isClaudeChatVisibleMessage({ type: data.type, subtype: data.subtype })) return result
        if (data.type === 'summary' && typeof data.summary === 'string') return result
        if (data.type === 'system') {
            if (data.subtype === 'turn_duration') {
                result.isSidechain = Boolean(data.isSidechain)
                if (result.isSidechain) add('parent_tool_use', asString(data.parentToolUseId))
            }
            return result
        }
        if (data.type !== 'assistant' && data.type !== 'user') return { ...result, status: 'unsupported' }
        const identity = sdkMessageIdentity(messageId, data)
        const message = isObject(data.message) ? data.message : null
        if (!message) return { ...result, status: 'unsupported' }
        const prompt = data.type === 'user' ? sdkSidechainPrompt(message.content, identity.isSidechain) : null
        result.isSidechain = prompt !== null || identity.isSidechain
        if (result.isSidechain) add('parent_tool_use', identity.parentToolUseId)
        let ordinal = 0
        if (prompt !== null) {
            add('sidechain_prompt', prompt)
            ordinal++
        } else if (typeof message.content === 'string' && data.type === 'assistant') {
            ordinal++
        } else if (Array.isArray(message.content)) {
            // All-text non-sidechain user arrays normalize into the user lane.
            if (data.type === 'user' && !identity.isSidechain && message.content.length
                && message.content.every(block => isObject(block) && block.type === 'text' && typeof block.text === 'string')) return result
            for (const block of message.content) {
                if (!isObject(block)) continue
                if ((block.type === 'text' && typeof block.text === 'string')
                    || (data.type === 'assistant' && block.type === 'thinking' && typeof block.thinking === 'string')) ordinal++
                else if (data.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
                    tool(block.id, asString(block.name) ?? 'Tool', block.input, ordinal++)
                } else if (data.type === 'user' && block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                    add('tool_result', block.tool_use_id, ordinal++)
                }
            }
        }
        // The tracer uses only the first normalized agent block's SDK identity.
        if (ordinal > 0) {
            add('sdk_uuid', identity.uuid)
            add('sdk_parent', identity.parentUUID)
        }
        return result
    }
    if (envelope.type === AGENT_MESSAGE_PAYLOAD_TYPE && data) {
        if (['error', 'context_compacted', 'compact-summary', 'token_count', 'thread_goal_updated', 'thread_goal_cleared'].includes(String(data.type))) return result
        if (data.type === 'tool-call' && typeof data.callId === 'string') {
            tool(data.callId, asString(data.name) ?? 'Tool', data.input, 0)
            add('sdk_uuid', asString(data.id) ?? messageId)
        } else if (data.type === 'tool-call-result' && typeof data.callId === 'string') {
            add('tool_result', data.callId)
            add('sdk_uuid', asString(data.id) ?? messageId)
        } else if (data.type === 'reasoning' && typeof data.message === 'string') {
            add('reasoning_stream', asString(data.id) ?? messageId)
            add('sdk_uuid', messageId)
        } else if (data.type === 'message' && typeof data.message === 'string') {
            // Non-stream review JSON has additional normalization semantics;
            // retain an explicit unsupported state until that parser is shared.
            const streamId = asString(data.id)
            const streamSnapshot = data.streamSnapshot === true || (streamId !== null && /^pi-.+-turn-\d+-message-\d+-text-\d+$/.test(streamId))
            if (!streamSnapshot && data.message.trim().startsWith('{')) return { ...result, status: 'unsupported' }
            add('text_stream', streamId)
            add('sdk_uuid', messageId)
        } else return { ...result, status: 'unsupported' }
        return result
    }
    return { ...result, status: 'unsupported' }
}
