import { describe, expect, it } from 'vitest'
import type { DecryptedMessage } from '@/types/api'
import { mergeMessages } from '@/lib/messages'

function userMessage(partial: Partial<DecryptedMessage> & { id: string }): DecryptedMessage {
    return {
        id: partial.id,
        localId: partial.localId ?? partial.id,
        seq: partial.seq ?? 1,
        createdAt: partial.createdAt ?? 1_000,
        invokedAt: partial.invokedAt ?? null,
        status: partial.status,
        steered: partial.steered,
        deliveryState: partial.deliveryState,
        queueDismissed: partial.queueDismissed,
        content: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    }
}

describe('mergeMessages', () => {
    it.each(['overlay-first', 'native-first', 'same-page'])('replaces a native queue overlay by its exact accepted identity: %s', (ordering) => {
        const overlay = { ...userMessage({ id: 'hub-queue', localId: 'client-send', invokedAt: 2_700 }), seq: null }
        const native = userMessage({ id: 'native:thread:turn:item:user', localId: 'client-send', seq: 160_001, invokedAt: 2_000 })
        const other = { ...overlay, id: 'other-hub-queue', localId: 'other-send' }
        const messages = ordering === 'overlay-first' ? mergeMessages([overlay, other], [native])
            : ordering === 'native-first' ? mergeMessages([native, other], [overlay])
                : mergeMessages([], [overlay, native, other])
        expect(messages).toHaveLength(2)
        expect(messages.find(message => message.localId === 'client-send')).toEqual(native)
        expect(messages.find(message => message.localId === 'other-send')).toEqual(other)
    })
    it('preserves invokedAt when a stale snapshot omits the ack timestamp', () => {
        const invokedAt = 2_000
        const existing = [userMessage({ id: 'server-1', localId: 'local-1', invokedAt })]
        const incoming = [userMessage({ id: 'server-1', localId: 'local-1', invokedAt: null })]

        const merged = mergeMessages(existing, incoming)
        expect(merged).toHaveLength(1)
        expect(merged[0]?.invokedAt).toBe(invokedAt)
    })

    it('does not inherit optimistic "queued" onto an already-invoked server echo (steered message)', () => {
        const optimistic = userMessage({ id: 'local-1', localId: 'local-1', invokedAt: null, status: 'queued' })
        const serverInvoked = userMessage({ id: 'server-1', localId: 'local-1', invokedAt: 2_000 })

        const merged = mergeMessages([optimistic], [serverInvoked])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.invokedAt).toBe(2_000)
        expect(merged[0]?.status).not.toBe('queued')
    })

    it('keeps "queued" while the message is not yet invoked (normal queue mode)', () => {
        const optimistic = userMessage({ id: 'local-2', localId: 'local-2', invokedAt: null, status: 'queued' })
        const serverPending = userMessage({ id: 'server-2', localId: 'local-2', invokedAt: null })

        const merged = mergeMessages([optimistic], [serverPending])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.status).toBe('queued')
    })

    it('carries the live "steered" marker from the optimistic row onto the server echo', () => {
        const optimisticSteered = userMessage({ id: 'local-s', localId: 'local-s', invokedAt: 4_000, status: 'sent', steered: true })
        const serverEcho = userMessage({ id: 'server-s', localId: 'local-s', invokedAt: 4_000 })

        const merged = mergeMessages([optimisticSteered], [serverEcho])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.steered).toBe(true)
    })

    it('preserves "steered" across a refetch that omits it', () => {
        const existing = [userMessage({ id: 'server-s2', localId: 'local-s2', invokedAt: 5_000, steered: true })]
        const incoming = [userMessage({ id: 'server-s2', localId: 'local-s2', invokedAt: 5_000 })]

        const merged = mergeMessages(existing, incoming)
        expect(merged).toHaveLength(1)
        expect(merged[0]?.steered).toBe(true)
    })

    it('preserves queueDismissed across a refetch of an indeterminate row (#1839)', () => {
        const existing = [userMessage({
            id: 'server-d',
            localId: 'local-d',
            invokedAt: null,
            deliveryState: 'indeterminate',
            queueDismissed: true,
        })]
        const incoming = [userMessage({
            id: 'server-d',
            localId: 'local-d',
            invokedAt: null,
            deliveryState: 'indeterminate',
        })]

        const merged = mergeMessages(existing, incoming)
        expect(merged).toHaveLength(1)
        expect(merged[0]?.queueDismissed).toBe(true)
    })

    it('normalizes a stuck queued status on an invoked message', () => {
        const inconsistent = userMessage({ id: 'server-3', localId: 'local-3', invokedAt: 3_000, status: 'queued' })

        const merged = mergeMessages([inconsistent], [])
        expect(merged).toHaveLength(1)
        expect(merged[0]?.status).not.toBe('queued')
    })
})
