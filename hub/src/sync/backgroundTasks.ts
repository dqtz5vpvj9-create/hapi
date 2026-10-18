import { isObject } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'

export type BackgroundTaskEvent = {
    taskId: string
    state: 'running' | 'completed' | 'failed' | 'cancelled'
}

function taskId(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const id = value.trim()
    return /^[A-Za-z0-9_.:-]{1,256}$/.test(id) ? id : null
}

function textContent(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content.map(block => isObject(block) && typeof block.text === 'string' ? block.text : '').join('\n')
}

function terminalState(value: unknown): Exclude<BackgroundTaskEvent['state'], 'running'> {
    if (value === 'failed') return 'failed'
    if (value === 'cancelled' || value === 'canceled' || value === 'stopped') return 'cancelled'
    return 'completed'
}

/** Only agent-origin tool results/system injections can change runtime state.
 * Human prose and assistant prose containing the same marker are ignored.
 * Unknown completion IDs never decrement an unrelated running task.
 */
export function extractBackgroundTaskEvents(messageContent: unknown): BackgroundTaskEvent[] {
    const record = unwrapRoleWrappedRecordEnvelope(messageContent)
    if (record?.role !== 'agent' || !isObject(record.content) || record.content.type !== 'output') return []
    const data = record.content.data
    if (!isObject(data)) return []
    const events = new Map<string, BackgroundTaskEvent>()
    const resultBlocks = data.type === 'tool_result'
        ? [data]
        : (data.type === 'assistant' || data.type === 'user') && isObject(data.message) && Array.isArray(data.message.content)
            ? data.message.content
            : []
    for (const block of resultBlocks) {
        if (!isObject(block) || block.type !== 'tool_result') continue
        for (const match of textContent(block.content).matchAll(/(?:^|\n)\s*Command running in background with ID:\s*([^\s<]+)/g)) {
            const id = taskId(match[1])
            if (id) events.set(id, { taskId: id, state: 'running' })
        }
    }
    if (data.type === 'user') {
        const text = textContent(isObject(data.message) ? data.message.content : data.content).trimStart()
        if (text.startsWith('<task-notification>')) {
            const id = taskId(text.match(/<task-id>\s*([^<]+?)\s*<\/task-id>/)?.[1])
            if (id) events.set(id, { taskId: id, state: terminalState(text.match(/<status>\s*([^<]+?)\s*<\/status>/)?.[1]) })
        }
    }
    return [...events.values()]
}
