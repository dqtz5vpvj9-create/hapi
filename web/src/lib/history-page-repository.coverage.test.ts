import { expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'
import { HistoryPageRepository } from './history-page-repository'

function fixture(sameAt = false) {
    let calls = 0
    const rows: DecryptedMessage[] = Array.from({ length: 500 }, (_, index) => ({
        id: `r${index + 1}`, seq: index + 1, createdAt: sameAt ? 1 : index + 1, localId: null,
        content: { role: 'user', content: { type: 'text', text: `Message ${index + 1}` } },
    }))
    const api = { getMessages: async (_session: string, options: { beforeSeq?: number; afterSeq?: number; untilSeq?: number } = {}): Promise<MessagesResponse> => {
        calls++
        const before = options.beforeSeq !== undefined
        const messages = before ? rows.filter(row => row.seq! < options.beforeSeq!).slice(-200)
            : rows.filter(row => row.seq! > options.afterSeq! && row.seq! <= options.untilSeq!).slice(0, 200)
        const first = messages[0]?.seq ?? null, last = messages.at(-1)?.seq ?? null
        return { messages, page: { direction: before ? 'before' : 'after', epoch: 1, reset: false, limit: 200,
            nextBeforeAt: first === null ? null : sameAt ? 1 : first, nextBeforeSeq: first, nextAfterAt: last === null ? null : sameAt ? 1 : last, nextAfterSeq: last,
            snapshotHeadAt: sameAt ? 1 : 500, snapshotHeadSeq: 500,
            hasMore: before ? first !== 1 : last !== options.untilSeq } }
    } } as Pick<ApiClient, 'getMessages'>
    return { repository: new HistoryPageRepository(api), calls: () => calls }
}

it('reads forward from cached before ranges with the correct continuation and no HTTP', async () => {
    const { repository, calls } = fixture()
    await repository.read('s', { direction: 'before', cursor: { at: 301, seq: 301 }, epoch: 1 })
    await repository.read('s', { direction: 'before', cursor: { at: 501, seq: 501 }, epoch: 1 })
    const first = await repository.read('s', { direction: 'after', cursor: { at: 250, seq: 250 }, until: { at: 500, seq: 500 }, epoch: 1 })
    expect(first.messages).toHaveLength(200)
    expect(first.page).toMatchObject({ nextAfterSeq: 450, hasMore: true })
    const last = await repository.read('s', { direction: 'after', cursor: { at: 450, seq: 450 }, until: { at: 500, seq: 500 }, epoch: 1 })
    expect(last.messages).toHaveLength(50)
    expect(last.page).toMatchObject({ nextAfterSeq: 500, hasMore: false })
    expect(calls()).toBe(2)
})

it('reuses the consumed native tail even when its cursor extends beyond the last visible message', async () => {
    const api = { getMessages: async () => { throw new Error('already consumed tail was requested again') } } as Pick<ApiClient, 'getMessages'>
    const repository = new HistoryPageRepository(api)
    repository.rememberPage('s', { direction: 'latest' }, {
        messages: [{ id: 'last-visible', seq: 100, createdAt: 1, localId: null,
            content: { role: 'user', content: { type: 'text', text: 'Last visible input' } } }],
        page: { direction: 'latest', epoch: 1, reset: false, limit: 20, hasMore: true,
            nextBeforeAt: 1, nextBeforeSeq: 100, nextAfterAt: 1, nextAfterSeq: 100,
            snapshotHeadAt: 1, snapshotHeadSeq: 999 },
    })
    const tail = await repository.read('s', { direction: 'after', cursor: { at: 1, seq: 100 }, until: { at: 1, seq: 999 }, epoch: 1 })
    expect(tail.messages).toEqual([])
    expect(tail.page).toMatchObject({ nextAfterAt: 1, nextAfterSeq: 999, hasMore: false })
    expect(repository.getCached('s', { direction: 'after', cursor: { at: 1, seq: 100 }, until: { at: 1, seq: 1000 }, epoch: 1 })).toBeNull()
})

it('does not synthesize a reader page across an uncovered cache hole', async () => {
    const { repository, calls } = fixture()
    await repository.read('s', { direction: 'before', cursor: { at: 201, seq: 201 }, epoch: 1 })
    await repository.read('s', { direction: 'before', cursor: { at: 501, seq: 501 }, epoch: 1 })
    const request = { direction: 'after' as const, cursor: { at: 100, seq: 100 }, until: { at: 500, seq: 500 }, epoch: 1 }
    expect(repository.getCached('s', request)).toBeNull()
    const page = await repository.read('s', request)
    expect(calls()).toBe(3)
    expect(page.messages).toHaveLength(200)
    expect(page.messages.some(row => row.seq === 250)).toBe(true)
    expect(page.page).toMatchObject({ nextAfterSeq: 300, hasMore: true })
})

for (const sameAt of [false, true]) {
    it(`keeps earlier history available after a non-aligned cached page (sameAt=${sameAt})`, async () => {
        const { repository, calls } = fixture(sameAt)
        const point = (seq: number) => ({ at: sameAt ? 1 : seq, seq })
        await repository.read('s', { direction: 'before', cursor: point(201), epoch: 1 })
        await repository.read('s', { direction: 'before', cursor: point(401), epoch: 1 })
        const middle = await repository.read('s', { direction: 'before', cursor: point(350), epoch: 1 })
        expect(middle.messages).toHaveLength(200)
        expect(middle.page).toMatchObject({ nextBeforeSeq: 150, hasMore: true })
        const beginning = await repository.read('s', { direction: 'before', cursor: point(150), epoch: 1 })
        expect(beginning.messages).toHaveLength(149)
        expect(beginning.page).toMatchObject({ nextBeforeSeq: 1, hasMore: false })
        expect(calls()).toBe(2)
    })
}

it('context admission preserves its exact coverage and remains bounded across jumps', () => {
    const api = { getMessages: async () => { throw new Error('unexpected network read') } } as Pick<ApiClient, 'getMessages'>
    const repository = new HistoryPageRepository(api, { totalBytes: 6000, sessionBytes: 3000, sessions: 2 })
    for (let i = 1; i <= 10; i++) {
        const seq = i * 100
        repository.rememberContext('s', {
            messages: [{ id: `r${seq}`, seq, createdAt: seq, localId: null,
                content: { role: 'user', content: { type: 'text', text: 'Context passage '.repeat(20) } } }],
            page: { epoch: 1, reset: false, beforeCursor: { at: seq, seq }, afterCursor: { at: seq, seq },
                hasMoreBefore: true, hasMoreAfter: true, snapshotHead: { at: 2000, seq: 2000 } }
        })
        expect(repository.stats().totalBytes).toBeLessThanOrEqual(3000)
    }
    expect(repository.findCachedMessagePage('s', 1, 'r100')).toBeNull()
    expect(repository.findCachedMessagePage('s', 1, 'r1000')?.messages[0].id).toBe('r1000')
    // A context around 1000 is not proof that 1001..2000 have been read.
    expect(repository.readCachedRange('s', 1, { at: 1000, seq: 1000 }, { at: 2000, seq: 2000 })).toBeNull()
    repository.observeEpoch('s', 2)
    expect(repository.findCachedMessagePage('s', 1, 'r1000')).toBeNull()
    expect(repository.stats().totalBytes).toBe(0)
})
