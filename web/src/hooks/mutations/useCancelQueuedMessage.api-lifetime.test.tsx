import { createElement, type ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { useCancelQueuedMessage } from '@/hooks/mutations/useCancelQueuedMessage'
import { clearMessageWindow, getMessageWindowState, ingestIncomingMessages } from '@/lib/message-window-store'
import { getHistoryPageRepository } from '@/lib/history-page-repository'

vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { notification: vi.fn() } }) }))
const ids: string[] = []
afterEach(() => { cleanup(); ids.forEach(clearMessageWindow); ids.length = 0; sessionStorage.clear() })

it.each(['null', 'replacement'])('owns the original API across a pending cancel and %s API rerender', async kind => {
    const id = crypto.randomUUID(); ids.push(id)
    const target = { id: 'server-target', localId: 'local-target', seq: 1, createdAt: 1001, invokedAt: null, content: { role: 'user', content: { type: 'text', text: 'cancel me' } } } as any
    let resolve!: (result: any) => void
    const ack = new Promise<any>(yes => { resolve = yes })
    const api = { cancelMessage: vi.fn(() => ack) } as any
    const originalRepository = getHistoryPageRepository(api)
    originalRepository.rememberPage(id, { direction: 'latest' }, { messages: [target], page: { direction: 'latest', limit: 20, epoch: 1, reset: false, hasMore: false, nextBeforeAt: 1001, nextBeforeSeq: 1, nextAfterAt: 1001, nextAfterSeq: 1, snapshotHeadAt: 1001, snapshotHeadSeq: 1 } })
    ingestIncomingMessages(id, [target])
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const hook = renderHook(({ currentApi }) => useCancelQueuedMessage(currentApi), { initialProps: { currentApi: api }, wrapper })
    let cancel!: Promise<any>
    act(() => { cancel = hook.result.current.mutateAsync({ sessionId: id, messageId: target.id, localId: target.localId, snapshot: target }) })
    await waitFor(() => expect(api.cancelMessage).toHaveBeenCalledOnce())
    hook.rerender({ currentApi: kind === 'null' ? null : {} })
    let outcome: any
    await act(async () => { resolve({ status: 'cancelled', localId: target.localId }); outcome = await cancel.catch(error => ({ error: String(error) })) })
    expect(outcome).toEqual({ status: 'cancelled', localId: target.localId })
    expect(getMessageWindowState(id).messages).toEqual([])
    expect(originalRepository.getCached(id, { direction: 'latest' })).toBeNull()
})
