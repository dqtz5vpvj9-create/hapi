import type { MessagesResponse } from '@hapi/protocol/apiTypes'
import type { Store } from '../store'

/** Pending input is a Hub queue overlay. Its seq/position must never become a
 * cursor into native history, whose completed conversation stays native. */
export function withNativeQueuePage(store: Store, sessionId: string, page: MessagesResponse): MessagesResponse {
    const accepted = new Set(page.messages.filter(message => message.invokedAt != null
        && (message.content as { role?: string } | null)?.role === 'user').map(message => message.localId))
    const pending = store.messages.getUninvokedLocalMessages(sessionId)
        .filter(message => !accepted.has(message.localId))
        .map(({ sessionId: _sessionId, ...message }) => ({ ...message, seq: null }))
    return { ...page, messages: [...page.messages, ...pending] }
}
