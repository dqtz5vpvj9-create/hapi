import { describe, expect, it } from 'vitest'
import { ApiError, type ApiClient } from '@/api/client'
import type { MessageContextResponse } from '@hapi/protocol/apiTypes'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { HistoryPageRepository } from './history-page-repository'

function repository() {
    const message = { id: 'r1', seq: 1, localId: null, createdAt: 1,
        content: { role: 'user', content: { type: 'text', text: 'Authorized cached content' } } } as DecryptedMessage
    const response: MessagesResponse = { messages: [message], page: {
        direction: 'latest', epoch: 1, limit: 200, reset: false, hasMore: false,
        nextBeforeAt: 1, nextBeforeSeq: 1, nextAfterAt: 1, nextAfterSeq: 1,
        snapshotHeadAt: 1, snapshotHeadSeq: 1,
    } }
    return new HistoryPageRepository({ getMessages: async () => response } as Pick<ApiClient, 'getMessages'>)
}

describe('context authorization uses the shared cache generation', () => {
    for (const status of [401, 403]) {
        it(`clears cached payloads after the current context returns ${status}`, async () => {
            const repo = repository()
            await repo.read('s', { direction: 'latest' })
            expect(repo.getCached('s', { direction: 'latest' })?.messages).toHaveLength(1)
            await expect(repo.readContext('s', async () => { throw new ApiError('Denied', status) })).rejects.toBeInstanceOf(ApiError)
            expect(repo.getCached('s', { direction: 'latest' })).toBeNull()
        })
        it(`does not clear a new cache when an old context returns ${status}`, async () => {
            const repo = repository()
            let reject!: (error: Error) => void
            const pending = repo.readContext('s', () => new Promise<MessageContextResponse>((_resolve, fail) => { reject = fail }))
            const rejection = expect(pending).rejects.toBeInstanceOf(ApiError)
            repo.invalidate()
            await repo.read('s', { direction: 'latest' })
            reject(new ApiError('Old request denied', status))
            await rejection
            expect(repo.getCached('s', { direction: 'latest' })?.messages).toHaveLength(1)
        })
    }
})
