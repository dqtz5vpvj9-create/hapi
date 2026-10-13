import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, renderHook, cleanup } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { useHubScratchlist } from '@/lib/use-hub-scratchlist'
import { queryKeys } from '@/lib/query-keys'
import { queryClient as productionClient } from '@/lib/query-client'
import type { ApiClient } from '@/api/client'
import { ownQueuedStateRequest } from '@/lib/queued-state-request-lifetime'

const fixture = vi.hoisted(() => ({
    api: null as ApiClient | null, startSync: vi.fn(), endSync: vi.fn(), reportConnect: vi.fn(), reportDisconnect: vi.fn(),
    recent: { refresh: vi.fn(), event: vi.fn() }, workspace: { mode: 'single', workspaces: [], activeId: null, focused: {}, zoomed: {} },
    router: { history: { location: { pathname: '/sessions', search: '', hash: '', state: {} }, replace: vi.fn() } }
}))
vi.mock('@tanstack/react-router', () => ({ Outlet: () => null, useLocation: () => '/sessions', useMatchRoute: () => () => false, useRouter: () => fixture.router }))
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ api: fixture.api, token: 'fixture', isLoading: false, needsBinding: false }) }))
vi.mock('@/hooks/useAuthSource', () => ({ useAuthSource: () => ({ authSource: { type: 'accessToken' }, isLoading: false }) }))
vi.mock('@/hooks/useServerUrl', () => ({ useServerUrl: () => ({ serverUrl: 'http://hub.test', baseUrl: 'http://hub.test' }) }))
vi.mock('@/hooks/useRecentSessionWarmup', () => ({ useRecentSessionWarmup: () => fixture.recent }))
vi.mock('@/hooks/useSyncingState', () => ({ useSyncingState: () => ({ isSyncing: false, startSync: fixture.startSync, endSync: fixture.endSync }) }))
vi.mock('@/hooks/useReconnectingState', () => ({ useReconnectingState: () => ({ isReconnecting: false, reason: null, reportConnect: fixture.reportConnect, reportDisconnect: fixture.reportDisconnect }) }))
vi.mock('@/hooks/useSessionReconnectingState', () => ({ useSessionReconnectingState: () => ({ isReconnecting: false, reason: null, reportConnect: vi.fn(), reportDisconnect: vi.fn() }) }))
vi.mock('@/hooks/usePushNotifications', () => ({ usePushNotifications: () => ({ isSupported: false }) }))
vi.mock('@/hooks/useAppBadge', () => ({ canUseAppBadging: () => false, useAppBadge: () => {} }))
vi.mock('@/hooks/useAppBadgePreference', () => ({ useAppBadgePreference: () => ({ appBadgeEnabled: false }) }))
vi.mock('@/hooks/queries/useSessions', () => ({ useSessions: () => ({ sessions: [], isLoading: false }) }))
vi.mock('@/hooks/useAppGoBack', () => ({ useAppGoBack: () => () => {} }))
vi.mock('@/hooks/useVisibilityReporter', () => ({ useVisibilityReporter: () => {} }))
vi.mock('@/hooks/useViewportHeight', () => ({ useViewportHeight: () => {} }))
vi.mock('@/hooks/useNarrowViewport', () => ({ useNarrowViewport: () => true }))
vi.mock('@/hooks/useTelegram', () => ({ getTelegramWebApp: () => null, isTelegramApp: () => false }))
vi.mock('@/hooks/useTheme', () => ({ initializeTheme: () => {} }))
vi.mock('@/hooks/useThemeColors', () => ({ initializeThemeColors: () => {} }))
vi.mock('@/hooks/useChatSurfaceColors', () => ({ initializeChatSurfaceColors: () => {} }))
vi.mock('@/chat/sessionPresentation', () => ({ clearSessionPresentations: () => {} }))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/workspace/workspaceStore', () => ({ WorkspaceStore: class {
    get = () => fixture.workspace; subscribe = () => () => {}; focusedPane = () => undefined
}, workspaceStorageKey: () => 'reconnect-test', panes: () => [] }))
vi.mock('@/workspace/workspaceSync', () => ({ WorkspaceSync: class { retry() {} invalidate() {} dispose() {} } }))
vi.mock('@/lib/voice-context', () => ({ VoiceProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/lib/pwa-update-context', () => ({ PwaUpdateProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/lib/toast-context', () => ({ ToastProvider: ({ children }: { children: ReactNode }) => children, useToast: () => ({ addToast: () => {} }) }))
vi.mock('@/components/LoginPrompt', () => ({ LoginPrompt: () => null }))
vi.mock('@/components/InstallPrompt', () => ({ InstallPrompt: () => null }))
vi.mock('@/components/OfflineBanner', () => ({ OfflineBanner: () => null }))
vi.mock('@/components/PwaUpdateBanner', () => ({ hasNetworkStatusBanner: () => false, PwaUpdateBanner: () => null, PwaUpdateBannerWithStatusOffset: () => null }))
vi.mock('@/components/SyncingBanner', () => ({ SyncingBanner: () => null }))
vi.mock('@/components/ReconnectingBanner', () => ({ ReconnectingBanner: () => null }))
vi.mock('@/components/VoiceErrorBanner', () => ({ VoiceErrorBanner: () => null }))
vi.mock('@/components/RunnerVersionSkewBanner', () => ({ RunnerVersionSkewBanner: () => null }))
vi.mock('@/components/LoadingState', () => ({ LoadingState: () => null }))
vi.mock('@/components/ToastContainer', () => ({ ToastContainer: () => null }))
class FakeEventSource {
    static instances: FakeEventSource[] = []
    static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2
    readyState = 0
    onopen: (() => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: ((error: unknown) => void) | null = null
    constructor(readonly url: string) { FakeEventSource.instances.push(this) }
    close() { this.readyState = 2 }
    open() { this.readyState = 1; this.onopen?.() }
    emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data), lastEventId: 'cursor' } as MessageEvent<string>) }
}
const clients: QueryClient[] = []
const contents = (id: string, text: string) => ({ entries: [{ entryId: `${id}-entry`, text, createdAt: 1000, updatedAt: 1000, attachments: [] }] })
async function settle(ms = 300) { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
async function setup(first = false) {
    const client = new QueryClient({ defaultOptions: productionClient.getDefaultOptions() }); clients.push(client)
    const getScratchlist = vi.fn(async (id: string) => contents(id, 'new'))
    const api = { getScratchlist, getHealth: async () => ({ capabilities: {} }) } as unknown as ApiClient
    fixture.api = api
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
    const app = render(createElement(App), { wrapper })
    act(() => FakeEventSource.instances[0].open())
    if (!first) {
        act(() => FakeEventSource.instances[0].emit({ type: 'connection-changed', data: { subscriptionId: 'initial', resume: 'gap' } }))
        await settle()
    }
    for (const id of ['a', 'b', 'inactive']) {
        client.setQueryData(queryKeys.scratchlist(id), contents(id, 'old'))
        client.setQueryData(queryKeys.session(id), { session: { id, scratchlistUpdatedAt: 1000 } })
        localStorage.setItem(`hapi.scratchlist.v2.migrated.${id}`, '1')
        localStorage.setItem(`hapi.scratchlist.v2.banner-dismissed.${id}`, '1')
    }
    const hooks = renderHook(() => ({ a: useHubScratchlist('a', api), b: useHubScratchlist('b', api) }), { wrapper })
    expect(getScratchlist).not.toHaveBeenCalled()
    return { app, api, client, hooks, getScratchlist, wrapper }
}
async function reconnect(resume?: 'gap' | 'ok') {
    vi.setSystemTime(Date.now() + 65_000)
    act(() => FakeEventSource.instances[0].onerror?.({})); await settle(600)
    act(() => { const source = FakeEventSource.instances.at(-1)!; source.open(); source.emit({ type: 'connection-changed', data: { subscriptionId: 'next', ...(resume ? { resume } : {}) } }) })
    await settle()
}
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); vi.clearAllMocks(); FakeEventSource.instances = []; vi.stubGlobal('EventSource', FakeEventSource) })
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear() })

describe('App reconnect ownership and scratchlist repair', () => {
    for (const resume of ['gap', undefined] as const) {
        it(`repairs active scratchlists and invalidates inactive ones on ${resume ?? 'legacy'} handshake`, async () => {
            const { hooks, client, getScratchlist } = await setup(); await reconnect(resume)
            expect(hooks.result.current.a.entries[0]?.text).toBe('new')
            expect(hooks.result.current.b.entries[0]?.text).toBe('new')
            expect(getScratchlist.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'b'])
            expect(client.getQueryState(queryKeys.scratchlist('inactive'))?.isInvalidated).toBe(true)
        })
    }
    it('refetches an inactive invalidated scratchlist only when mounted', async () => {
        const { client, api, wrapper, getScratchlist } = await setup(); await reconnect('gap')
        expect(client.getQueryState(queryKeys.scratchlist('inactive'))?.isInvalidated).toBe(true)
        expect(getScratchlist).toHaveBeenCalledTimes(2)
        const hook = renderHook(() => useHubScratchlist('inactive', api), { wrapper }); await settle()
        expect(hook.result.current.entries[0]?.text).toBe('new'); expect(getScratchlist).toHaveBeenCalledTimes(3)
    })
    it('does not invalidate or refetch on a successfully resumed reconnect', async () => {
        const { client, getScratchlist, hooks } = await setup(); await reconnect('ok')
        expect(getScratchlist).not.toHaveBeenCalled(); expect(hooks.result.current.a.entries[0]?.text).toBe('old')
        expect(client.getQueryState(queryKeys.scratchlist('inactive'))?.isInvalidated).toBe(false)
    })
    it('corrects the first connection even when its handshake says resumed', async () => {
        const { hooks, getScratchlist } = await setup(true)
        act(() => FakeEventSource.instances[0].emit({ type: 'connection-changed', data: { subscriptionId: 'first', resume: 'ok' } })); await settle()
        expect(hooks.result.current.a.entries[0]?.text).toBe('new'); expect(getScratchlist).toHaveBeenCalledTimes(2)
    })
    it('aborts outgoing API ownership on replacement and current ownership on unmount', async () => {
        const { app, api } = await setup(), old = ownQueuedStateRequest(api, 'outgoing')
        const nextApi = { ...api } as ApiClient, next = ownQueuedStateRequest(nextApi, 'incoming')
        try {
            fixture.api = nextApi; app.rerender(createElement(App))
            expect(old.signal.aborted).toBe(true); expect(next.signal.aborted).toBe(false)
            app.unmount(); expect(next.signal.aborted).toBe(true)
        } finally { old.finish(); next.finish() }
    })
})
