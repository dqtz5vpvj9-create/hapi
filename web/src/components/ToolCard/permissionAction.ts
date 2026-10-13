import { useMemo, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import type { AgentState } from '@/types/api'

type Action = 'allow' | 'deny' | 'abort' | 'allEdits' | 'forSession'
type State = { action: Action | null; error: string | null; submitted: boolean }
const clients = new WeakMap<ApiClient, Map<string, PermissionAction>>()

class PermissionAction {
    private state: State = { action: null, error: null, submitted: false }
    private listeners = new Set<() => void>()
    private lease: symbol | null = null
    constructor(readonly sessionId: string, readonly requestId: string) {}
    get = () => this.state
    subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    private publish(state: State) {
        this.state = state
        this.listeners.forEach(listener => listener())
    }
    begin(action: Action): symbol | null {
        if (this.state.action || this.state.submitted) return null
        const lease = Symbol()
        this.lease = lease
        this.publish({ action, error: null, submitted: false })
        return lease
    }
    finish(lease: symbol, error: string | null): boolean {
        if (this.lease !== lease) return false
        this.lease = null
        this.publish({ action: null, error, submitted: error === null })
        return true
    }
    resolve() {
        this.lease = null
        this.publish({ action: null, error: null, submitted: true })
    }
}

/** Only full authoritative session state retires an approval, never row unmount. */
export function reconcilePermissionActions(api: ApiClient, sessionId: string, agentState: AgentState | null | undefined) {
    if (!agentState) return
    const entries = clients.get(api)
    if (!entries) return
    for (const [key, entry] of entries) {
        if (entry.sessionId !== sessionId) continue
        if (agentState.requests?.[entry.requestId] && !agentState.completedRequests?.[entry.requestId]) continue
        entry.resolve()
        entries.delete(key)
    }
    if (!entries.size) clients.delete(api)
}

/** The request ID (not toolCallId) owns both the in-flight action and its receipt. */
export function usePermissionAction(api: ApiClient, sessionId: string, requestId: string | null) {
    const store = useMemo(() => {
        if (requestId === null) return new PermissionAction(sessionId, '')
        let entries = clients.get(api)
        if (!entries) { entries = new Map(); clients.set(api, entries) }
        const key = JSON.stringify([sessionId, requestId])
        let entry = entries.get(key)
        if (!entry) { entry = new PermissionAction(sessionId, requestId); entries.set(key, entry) }
        return entry
    }, [api, sessionId, requestId])
    const state = useSyncExternalStore(store.subscribe, store.get)
    return { ...state, begin: (action: Action) => store.begin(action), finish: (lease: symbol, error: string | null) => store.finish(lease, error) }
}
