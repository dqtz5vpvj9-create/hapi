import type { ApiClient } from '@/api/client'
import type {
    NativeSubagentRef,
    SubagentPage,
    SubagentReadOptions,
    SubagentSource,
} from './types'

/** The child identity in the response must be the one this source was opened for. */
function assertSameChild(actual: string, expected: string): void {
    if (actual !== expected) throw new Error('The response belongs to another subagent')
}

function toPage(fields: {
    sessionId: string
    messages: SubagentPage['messages']
    before: number | null
    hasMore: boolean
    after?: number
    epoch?: string
    hasLater?: boolean
    reset?: boolean
    truncated?: boolean
}): SubagentPage {
    return {
        sessionId: fields.sessionId,
        messages: fields.messages,
        before: fields.before,
        hasMore: fields.hasMore,
        ...(fields.after !== undefined ? { after: fields.after } : {}),
        ...(fields.epoch !== undefined ? { epoch: fields.epoch } : {}),
        ...(fields.hasLater !== undefined ? { hasLater: fields.hasLater } : {}),
        ...(fields.reset !== undefined ? { reset: fields.reset } : {}),
        ...(fields.truncated !== undefined ? { truncated: fields.truncated } : {}),
    }
}

let requestSequence = 0

/** Caller-minted id persisted on the accepted child message. */
function createRequestId(): string {
    requestSequence += 1
    return `subagent-${Date.now().toString(36)}-${requestSequence.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Build the reader for one native child. Codex children are always read-only;
 * only a DSH child in `continuable` mode can be prompted or interrupted.
 */
export function createSubagentSource(
    api: ApiClient,
    ref: NativeSubagentRef,
    auth: string | null,
): SubagentSource {
    const isCurrent = () => api.getAuthToken() === auth

    if (ref.flavor === 'codex') {
        return {
            ref,
            isCurrent,
            async read(options: SubagentReadOptions = {}) {
                const page = await api.getCodexSubagentMessages(ref.parentSessionId, ref.sessionId, options)
                assertSameChild(page.threadId, ref.sessionId)
                return toPage({
                    sessionId: page.threadId,
                    messages: page.messages,
                    before: page.before,
                    hasMore: page.hasMore,
                    after: page.after,
                    epoch: page.epoch,
                    hasLater: page.hasLater,
                    reset: page.reset,
                    truncated: page.truncated,
                })
            },
        }
    }

    const source: SubagentSource = {
        ref,
        isCurrent,
        async read(options: SubagentReadOptions = {}) {
            const page = await api.getDshSubagentMessages(ref.parentSessionId, ref.sessionId, options)
            assertSameChild(page.sessionId, ref.sessionId)
            return toPage({
                sessionId: page.sessionId,
                messages: page.messages,
                before: page.before,
                hasMore: page.hasMore,
                after: page.after,
                epoch: page.epoch,
                hasLater: page.hasLater,
                reset: page.reset,
                truncated: page.truncated,
            })
        },
    }

    if (ref.mode === 'continuable') {
        source.prompt = async (text, delivery) => {
            await api.promptDshSubagent(ref.parentSessionId, ref.sessionId, {
                text,
                delivery,
                requestId: createRequestId(),
            })
        }
        source.interrupt = async () => {
            await api.interruptDshSubagent(ref.parentSessionId, ref.sessionId)
        }
    }

    return source
}
