import type { ApiClient } from '@/api/client'
import type { SyncEvent } from '@/types/api'
import { getMessageWindowState, ingestIncomingMessages, openMessageTailFromCache, releaseMessageWindow, warmMessageTail } from './message-window-store'

export const RECENT_SESSION_LIMIT = 5
type Network = { saveData?: boolean; effectiveType?: string }

/** Reuses the global SSE feed. No per-session sockets or idle polling. */
export class RecentSessionWarmup {
    private recent = new Set<string>()
    private pending = new Set<string>()
    private switched = new Set<string>()
    private active = new Set<string>()
    private timer: ReturnType<typeof setTimeout> | null = null
    private running: { id: string; abort: AbortController } | null = null
    private nextReadAt = 0
    private disposed = false
    prepare: (id: string) => void = () => {}

    constructor(private api: ApiClient, private network: () => Network = () =>
        (navigator as Navigator & { connection?: Network }).connection ?? {}) {}

    visit(id: string | null): void { this.setVisible(id ? [id] : []) }

    setVisible(ids: readonly string[]): void {
        const previous = this.active
        this.active = new Set(ids)
        for (const id of ids) {
            this.recent.delete(id); this.recent.add(id); this.pending.delete(id)
            if (this.running?.id === id) this.running.abort.abort()
        }
        const idle = [...this.recent].filter(id => !this.active.has(id))
        for (const evicted of idle.slice(0, Math.max(0, idle.length - Math.max(0, RECENT_SESSION_LIMIT - this.active.size)))) {
            this.recent.delete(evicted); this.pending.delete(evicted); this.switched.delete(evicted)
            if (this.running?.id === evicted) this.running.abort.abort()
            releaseMessageWindow(evicted)
        }
        for (const id of previous) if (!this.active.has(id) && this.recent.has(id)) this.pending.add(id)
        this.schedule()
    }

    switchTo(id: string): void {
        openMessageTailFromCache(this.api, id)
        // Evicted/cold sessions also open the tail, but still need the normal
        // latest-page refresh instead of incrementing a potentially old cursor.
        if (this.recent.has(id)) this.switched.add(id)
    }

    consumeSwitch(id: string): boolean { return this.switched.delete(id) }

    event(event: SyncEvent): void {
        if (!('sessionId' in event) || !this.recent.has(event.sessionId)) return
        const id = event.sessionId
        if (event.type === 'session-removed') {
            this.recent.delete(id); this.pending.delete(id); this.switched.delete(id)
            if (this.running?.id === id) this.running.abort.abort()
            return
        }
        if (this.active.has(id)) return
        if (event.type === 'message-received' && getMessageWindowState(id).viewMode === 'tail') {
            ingestIncomingMessages(id, [event.message])
            // Preparing happens after the store's throttled update, outside the
            // selected chat's render. A bounded read also reconciles raw cursors.
        } else if (event.type !== 'messages-invalidated' && event.type !== 'message-received' && event.type !== 'message-updated') return
        this.pending.add(id)
        this.schedule()
    }

    refresh(): void {
        for (const id of this.recent) if (!this.active.has(id)) this.pending.add(id)
        this.schedule()
    }

    environmentChanged(): void {
        if (!this.allowed()) {
            if (this.timer) clearTimeout(this.timer)
            this.timer = null
            if (this.running) { this.pending.add(this.running.id); this.running.abort.abort() }
        } else this.schedule()
    }

    private allowed(): boolean {
        const network = this.network()
        return !this.disposed && navigator.onLine !== false && document.visibilityState === 'visible'
            && !network.saveData && !['slow-2g', '2g'].includes(network.effectiveType ?? '')
    }

    schedule = (): void => {
        if (this.timer || this.running || !this.pending.size || !this.allowed()) return
        this.timer = setTimeout(() => { this.timer = null; void this.drain() }, Math.max(0, this.nextReadAt - Date.now()))
    }

    private async drain(): Promise<void> {
        if (!this.allowed()) return
        if ([...this.active].some(id => { const state = getMessageWindowState(id); return state.isSyncingTail || state.isLoadingMore })) return
        const id = this.pending.values().next().value
        if (!id) return
        this.pending.delete(id)
        if (this.active.has(id) || !this.recent.has(id)) { this.schedule(); return }
        const job = { id, abort: new AbortController() }
        this.running = job
        this.nextReadAt = Date.now() + (this.network().effectiveType === '3g' ? 5_000 : 1_000)
        try {
            await warmMessageTail(this.api, id, job.abort.signal, () => !this.active.has(id) && this.recent.has(id))
            if (!job.abort.signal.aborted && !this.active.has(id)) this.prepare(id)
        } catch {
            // A new change/reconnect can retry. Background failures neither
            // clear readable content nor start independent retry loops.
        } finally {
            if (this.running === job) this.running = null
            this.schedule()
        }
    }

    dispose(): void {
        this.disposed = true
        if (this.timer) clearTimeout(this.timer)
        this.running?.abort.abort()
        this.pending.clear(); this.recent.clear(); this.switched.clear()
    }
}

const clients = new WeakMap<ApiClient, RecentSessionWarmup>()
export function getRecentSessionWarmup(api: ApiClient): RecentSessionWarmup {
    let warmup = clients.get(api)
    if (!warmup) { warmup = new RecentSessionWarmup(api); clients.set(api, warmup) }
    return warmup
}
export function clearRecentSessionWarmup(api: ApiClient): void {
    clients.get(api)?.dispose()
    clients.delete(api)
}
