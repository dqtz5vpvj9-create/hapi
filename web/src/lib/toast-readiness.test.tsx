import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSSE } from '@/hooks/useSSE'
import { queryKeys } from './query-keys'
import { incomingToastKind } from './input-request-toast'
import { ToastProvider, useToast } from './toast-context'

class EventSourceFixture {
    static current: EventSourceFixture
    static OPEN = 1
    readyState = 1
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    constructor() { EventSourceFixture.current = this }
    close() {}
    send(data: unknown, cursor = '') { this.onmessage?.({ data: JSON.stringify(data), lastEventId: cursor } as MessageEvent<string>) }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function setup() {
    vi.stubGlobal('EventSource', EventSourceFixture)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(queryKeys.sessions, { sessions: ['a', 'b'].map(id => ({ id, thinking: false, active: true, updatedAt: 1, metadataVersion: 0, agentStateVersion: 0, todosUpdatedAt: 0, pendingRequestKinds: [], pendingRequests: [] })) })
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, createElement(ToastProvider, null, children))
    const hook = renderHook(() => {
        const toast = useToast()
        useSSE({ enabled: true, token: '', baseUrl: '', scope: 'global', subscription: { all: true }, onEvent: () => {},
            onToast: event => toast.addToast({ ...event.data, kind: incomingToastKind(event.data.title) }),
        })
        return toast
    }, { wrapper })
    const send = (event: unknown, cursor = '') => act(() => EventSourceFixture.current.send(event, cursor))
    const ready = (id: string) => ({ type: 'toast', data: { title: 'Ready for input', body: 'wire ready', sessionId: id, url: `/sessions/${id}` } })
    const thinking = (id: string, value: boolean) => ({ type: 'session-updated', sessionId: id, data: { thinking: value } })
    return { ...hook, client, send, ready, thinking }
}

describe('readiness notification lifecycle with real SSE cache updates', () => {
    it('removes only the running session readiness and preserves other sessions and notification kinds', () => {
        const h = setup()
        h.send(h.ready('a')); h.send(h.ready('b'))
        h.send({ type: 'toast', data: { title: 'Task failed', body: 'kept', sessionId: 'a', url: '/sessions/a' } })
        expect(h.result.current.toasts).toHaveLength(3)
        h.send(h.thinking('a', true))
        expect(h.result.current.toasts.map(t => [t.sessionId, t.title])).toEqual([['b', 'Ready for input'], ['a', 'Task failed']])
        expect(h.client.getQueryData<{ sessions: { id: string; thinking: boolean }[] }>(queryKeys.sessions)?.sessions.find(s => s.id === 'a')?.thinking).toBe(true)
    })

    it('rejects delayed/replayed ready while running, then accepts next completion readiness', () => {
        const h = setup()
        h.send(h.ready('a'), 'before-turn')
        h.send(h.thinking('a', true), 'start-turn')
        h.send(h.ready('a'), 'before-turn')
        expect(h.result.current.toasts).toHaveLength(0)
        h.send(h.thinking('a', false), 'finish-turn')
        h.send(h.ready('a'), 'new-ready')
        expect(h.result.current.toasts).toHaveLength(1)
    })

    it('also dismisses stale readiness on REST/session detail resync', () => {
        const h = setup()
        h.send(h.ready('a'))
        act(() => h.client.setQueryData(queryKeys.session('a'), { session: { id: 'a', thinking: true } }))
        expect(h.result.current.toasts).toHaveLength(0)
        // Localized UI text has no bearing on the already classified kind.
        act(() => h.result.current.addToast({ title: '准备接收输入', body: '', sessionId: 'a', url: '', kind: 'ready' }))
        expect(h.result.current.toasts).toHaveLength(0)
    })
})
