import { describe, expect, it } from 'bun:test'
import { NativeCodexHistory } from '../cli/src/codex/shared/nativeHistory'
import { Store } from '../hub/src/store'
import { withNativeQueuePage } from '../hub/src/sync/nativeQueuePage'
import type { MessagesResponse } from '@hapi/protocol/apiTypes'

function reader(clientId?: string) {
    return new NativeCodexHistory('thread', { request: async <T>() => ({ data: [{
        turnId: 'turn', startedAtMs: 1000, completedAtMs: 1000,
        item: { id: 'item', type: 'userMessage', clientId, content: [{ type: 'text', text: 'same text' }] }
    }], nextCursor: null }) as T })
}
const user = { role: 'user', content: { type: 'text', text: 'same text' }, meta: { sentFrom: 'web' } }

describe('native reader and durable queue integration', () => {
    it('deduplicates authoritative native identity with the Hub ACK delayed and keeps different uncertain inputs actionable', async () => {
        const store = new Store(':memory:')
        try {
            const session = store.sessions.getOrCreateSession('native-identity', {}, null, 'default')
            store.messages.addMessage(session.id, user, 'client-one')
            store.messages.addMessage(session.id, user, 'client-two')
            store.messages.setMessagesDeliveryState(session.id, ['client-two'], 'indeterminate')
            const native = await reader('client-one').read({ limit: 20 }) as MessagesResponse
            expect(native.messages[0].localId).toBe('client-one')
            const result = withNativeQueuePage(store, session.id, native)
            expect(result.messages.filter(message => message.localId === 'client-one')).toHaveLength(1)
            expect(result.messages.find(message => message.localId === 'client-one')?.invokedAt).toBe(1000)
            expect(result.messages.find(message => message.localId === 'client-two')).toMatchObject({ invokedAt: null, deliveryState: 'indeterminate', seq: null })
            expect(result.page).toEqual(native.page)
            // View deduplication is identity proof, never a synthetic DB ACK.
            expect(store.messages.lookupQueuedMessage(session.id, 'client-one').status).toBe('queued')
            store.messages.markMessagesInvoked(session.id, ['client-one'], 1100)
            store.messages.markMessagesInvoked(session.id, ['client-one'], 1200)
            expect(store.messages.getLocalMessageStates(session.id, ['client-one'])[0].invokedAt).toBe(1100)
        } finally { store.close() }
    })

    it('uses the native item identity when no client ID exists and never consumes a same-text HAPI send', async () => {
        const store = new Store(':memory:')
        try {
            const session = store.sessions.getOrCreateSession('native-fallback', {}, null, 'default')
            store.messages.addMessage(session.id, user, 'unproven-client')
            const native = await reader().read({ limit: 20 }) as MessagesResponse
            expect(native.messages[0].localId).toBe('codex:thread:user:item')
            expect(withNativeQueuePage(store, session.id, native).messages).toHaveLength(2)
            expect(store.messages.lookupQueuedMessage(session.id, 'unproven-client').status).toBe('queued')
        } finally { store.close() }
    })
})
