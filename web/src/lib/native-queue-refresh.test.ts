import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { clearMessageWindow, getMessageWindowState, invalidateMessageWindow, syncTailMessages } from './message-window-store'
import { isQueuedForInvocation } from './messages'

const clients = ['native-queue-first-client', 'native-queue-second-client']
afterEach(() => { for (const id of clients) clearMessageWindow(id) })
const row = (id: string, localId: string, invokedAt: number | null, deliveryState?: 'indeterminate'): DecryptedMessage => ({
    id, localId, seq: 1, createdAt: 1000, invokedAt, scheduledAt: null, deliveryState,
    content: { role: 'user', content: { type: 'text', text: id } }
})
const page = (messages: DecryptedMessage[]): MessagesResponse => ({ messages, page: {
    direction: 'latest', limit: 20, epoch: 1, reset: false, hasMore: false,
    nextBeforeAt: null, nextBeforeSeq: null, nextAfterAt: null, nextAfterSeq: null,
    snapshotHeadAt: 1000, snapshotHeadSeq: 1
} })

describe('native queue projection refresh', () => {
    it('removes retired mirrors on invalidation for existing and reconnected clients while retaining actionable HAPI sends', async () => {
        const stale = row('stale-native-mirror', 'external-client', null, 'indeterminate')
        const unknown = row('genuine-hapi-unknown', 'hapi-unknown', null, 'indeterminate')
        const pending = row('genuine-hapi-pending', 'hapi-pending', null)
        const accepted = row('native:thread:turn:item:accepted-client', 'accepted-client', 1000)
        const current = page([unknown, pending, accepted])
        const getMessages = vi.fn().mockResolvedValueOnce(page([stale, unknown, pending])).mockResolvedValue(current)
        const api = { getMessages } as unknown as ApiClient
        await syncTailMessages(api, clients[0])
        expect(getMessageWindowState(clients[0]).messages.filter(isQueuedForInvocation)).toHaveLength(3)
        invalidateMessageWindow(clients[0])
        await syncTailMessages(api, clients[0])
        await syncTailMessages(api, clients[1]) // new client / refresh with no prior cache
        for (const client of clients) {
            const messages = getMessageWindowState(client).messages
            expect(messages.map(message => message.localId)).not.toContain('external-client')
            expect(messages.filter(isQueuedForInvocation).map(message => message.localId)).toEqual(['hapi-pending', 'hapi-unknown'])
            expect(messages.find(message => message.localId === 'hapi-unknown')).toMatchObject({ invokedAt: null, deliveryState: 'indeterminate' })
            expect(messages.find(message => message.localId === 'accepted-client')?.invokedAt).toBe(1000)
        }
    })
})
