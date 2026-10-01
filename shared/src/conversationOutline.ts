import { unwrapRoleWrappedRecordEnvelope } from './messages'
import { isObject, safeStringify } from './utils'

const CLI_TAG_REGEX = /<(?:local-command-[a-z-]+|command-(?:name|message|args))>/i

export function isCliOutputText(text: string, meta: unknown): boolean {
    return isObject(meta) && meta.sentFrom === 'cli' && CLI_TAG_REGEX.test(text)
}

export function truncateOutlineLabel(value: string, maxLength = 96): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    return normalized.length <= maxLength ? normalized
        : `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

/** Content classification for the directory's sparse metadata index. Delivery
 * eligibility and canonical position belong to the stored message, not its JSON.
 * Keep parity with normalizeDecryptedMessage -> reducer -> buildConversationOutline. */
export function extractConversationOutlineLabel(content: unknown): string | null {
    const record = unwrapRoleWrappedRecordEnvelope(content)
    if (!record) return null
    let text: string
    if (record.role === 'user') {
        const body = record.content
        text = typeof body === 'string' ? body
            : isObject(body) && body.type === 'text' && typeof body.text === 'string'
                ? body.text : safeStringify(body)
    } else if (record.role === 'agent' && isObject(record.content) && record.content.type === 'output') {
        const data = record.content.data
        if (!isObject(data) || data.type !== 'user' || data.isMeta || data.isCompactSummary || data.isSidechain) return null
        const blocks = isObject(data.message) ? data.message.content : null
        // SDK strings are injected/sidechain prompts in the current renderer;
        // only a nonempty, entirely textual array enters its user lane.
        if (!Array.isArray(blocks) || blocks.length === 0
            || !blocks.every(block => isObject(block) && block.type === 'text' && typeof block.text === 'string')) return null
        text = blocks.map(block => block.text as string).join('\n\n')
    } else {
        return null
    }
    if (isCliOutputText(text, record.meta)) return null
    return truncateOutlineLabel(text) || 'Empty message'
}
