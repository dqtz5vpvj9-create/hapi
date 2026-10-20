import { useCallback, useMemo, useRef } from 'react'
import type { AppendMessage, AssistantRuntime, ThreadMessage, ThreadMessageLike } from '@assistant-ui/react'
import { bindExternalStoreMessage, fromThreadMessageLike, useExternalStoreRuntime } from '@assistant-ui/react'
import { safeStringify } from '@hapi/protocol'
import type { ToolCallBlock } from '@/chat/types'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'

export type SubagentRuntimeOptions = {
    blocks: readonly VisibleChatBlock[]
    /** The child is executing; the last assistant block renders as running. */
    running?: boolean
    /**
     * Provided only for continuable children that accept input. The runtime
     * forwards the raw text; delivery (queue/steer) belongs to the caller's
     * composer, which may either capture it in this closure or call
     * `source.prompt(text, delivery)` directly and leave the runtime read-only.
     */
    onSend?: (text: string) => void | Promise<void>
}

function blockTimestamp(block: VisibleChatBlock): number {
    if (block.kind === 'user-text') return block.invokedAt ?? block.createdAt
    if (block.kind === 'tool-call') return Math.max(block.createdAt, block.tool.completedAt ?? block.createdAt)
    if (block.kind === 'tool-group') {
        return block.tools.reduce(
            (latest, tool) => Math.max(latest, tool.tool.completedAt ?? tool.createdAt),
            block.createdAt,
        )
    }
    return block.createdAt
}

function toThreadMessageLike(block: VisibleChatBlock, id: string, timestamp: number): ThreadMessageLike | null {
    if (block.kind === 'user-text') {
        return {
            role: 'user',
            id,
            createdAt: new Date(timestamp),
            content: [{ type: 'text', text: block.text }],
            metadata: {
                custom: {
                    kind: 'user',
                    status: block.status,
                    localId: block.localId,
                    originalText: block.originalText,
                    attachments: block.attachments,
                    parts: block.parts,
                    invokedAt: block.invokedAt,
                    steered: block.steered,
                } satisfies HappyChatMessageMetadata,
            },
        }
    }
    if (block.kind === 'agent-text') {
        return {
            role: 'assistant',
            id,
            createdAt: new Date(timestamp),
            content: [{ type: 'text', text: block.text }],
            metadata: {
                custom: {
                    kind: 'assistant',
                    invokedAt: block.invokedAt,
                    durationMs: block.durationMs,
                    usage: block.usage,
                    model: block.model,
                } satisfies HappyChatMessageMetadata,
            },
        }
    }
    if (block.kind === 'agent-reasoning') {
        return {
            role: 'assistant',
            id,
            createdAt: new Date(timestamp),
            content: [{ type: 'reasoning', text: block.text }],
            metadata: {
                custom: {
                    kind: 'assistant',
                    invokedAt: block.invokedAt,
                    durationMs: block.durationMs,
                    usage: block.usage,
                    model: block.model,
                } satisfies HappyChatMessageMetadata,
            },
        }
    }
    if (block.kind === 'tool-group') {
        return {
            role: 'assistant',
            id,
            createdAt: new Date(timestamp),
            content: [{
                type: 'tool-call',
                toolCallId: block.id,
                toolName: 'ToolGroup',
                argsText: '',
                artifact: block,
            }],
            metadata: {
                custom: {
                    kind: 'tool',
                    toolCallId: block.id,
                    invokedAt: block.invokedAt ?? null,
                } satisfies HappyChatMessageMetadata,
            },
        }
    }
    if (block.kind === 'tool-call') {
        const toolBlock: ToolCallBlock = block
        return {
            role: 'assistant',
            id,
            createdAt: new Date(timestamp),
            content: [{
                type: 'tool-call',
                toolCallId: toolBlock.id,
                toolName: toolBlock.tool.name,
                argsText: safeStringify(toolBlock.tool.input),
                result: toolBlock.tool.result,
                isError: toolBlock.tool.state === 'error',
                artifact: toolBlock,
            }],
            metadata: {
                custom: {
                    kind: 'tool',
                    toolCallId: toolBlock.id,
                    invokedAt: toolBlock.invokedAt,
                    durationMs: toolBlock.durationMs,
                    usage: toolBlock.usage,
                    model: toolBlock.model,
                } satisfies HappyChatMessageMetadata,
            },
        }
    }
    if (block.kind === 'cli-output') {
        return {
            role: block.source === 'user' ? 'user' : 'assistant',
            id,
            createdAt: new Date(timestamp),
            content: [{ type: 'text', text: block.text }],
            metadata: {
                custom: {
                    kind: 'cli-output',
                    source: block.source,
                    invokedAt: block.invokedAt,
                } satisfies HappyChatMessageMetadata,
            },
        }
    }
    // `projectSubagentBlocks` never emits the remaining block kinds; degrade
    // any future text-bearing block to an assistant message instead of dropping
    // transcript content.
    const fallback = block as { text?: unknown; invokedAt?: number | null }
    if (typeof fallback.text === 'string') {
        return {
            role: 'assistant',
            id,
            createdAt: new Date(timestamp),
            content: [{ type: 'text', text: fallback.text }],
            metadata: {
                custom: { kind: 'assistant', invokedAt: fallback.invokedAt } satisfies HappyChatMessageMetadata,
            },
        }
    }
    return null
}

function extractText(message: AppendMessage): string {
    return message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof (part as { text?: unknown }).text === 'string')
        .map(part => part.text)
        .join('\n')
        .trim()
}

/**
 * Read-only (or send-enabled) assistant-ui runtime over a projected child
 * transcript. Mirrors the native branch of `useHappyRuntime` so child views can
 * reuse the root thread components: one ThreadMessage per visible block, tool
 * cards carry the original `ToolCallBlock` as their artifact.
 */
export function useSubagentRuntime(options: SubagentRuntimeOptions): AssistantRuntime {
    const { blocks, running = false, onSend } = options
    const cache = useRef(new WeakMap<VisibleChatBlock, { message: ThreadMessage; running: boolean }>())
    const messages = useMemo(() => blocks.flatMap((block, index): ThreadMessage[] => {
        const isLiveTail = running && index === blocks.length - 1 && block.kind === 'agent-text'
        const cached = cache.current.get(block)
        if (cached && cached.running === isLiveTail) return [cached.message]
        const id = `${block.kind}:${block.id}`
        const value = toThreadMessageLike(block, id, blockTimestamp(block))
        if (!value) return []
        const message = fromThreadMessageLike(
            value,
            id,
            isLiveTail ? { type: 'running' } : { type: 'complete', reason: 'unknown' },
        )
        bindExternalStoreMessage(message, [block])
        for (const part of message.content) bindExternalStoreMessage(part, [value])
        cache.current.set(block, { message, running: isLiveTail })
        return [message]
    }), [blocks, running])

    const messageRepository = useMemo(() => ({
        headId: messages.at(-1)?.id ?? null,
        messages: messages.map((message, index) => ({
            message,
            parentId: messages[index - 1]?.id ?? null,
        })),
    }), [messages])

    const onNew = useCallback(async (message: AppendMessage) => {
        if (!onSend) return
        const text = extractText(message)
        if (!text) return
        await onSend(text)
    }, [onSend])

    const adapter = useMemo(() => ({
        messageRepository,
        isDisabled: running || !onSend,
        isRunning: running,
        onNew,
        unstable_capabilities: { copy: true },
    }), [messageRepository, running, onSend, onNew])

    return useExternalStoreRuntime<ThreadMessage>(adapter)
}
