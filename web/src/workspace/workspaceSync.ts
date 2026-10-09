import { ApiError, type ApiClient } from '@/api/client'
import { WorkspaceSnapshotSchema, type WorkspaceUpdateResult } from '@hapi/protocol/workspaces'
import type { WorkspaceStore } from './workspaceStore'

type Transport = Pick<ApiClient, 'getWorkspaces' | 'updateWorkspaces'>

/** One serialized outbox per browser, woken by the existing SSE connection. */
export class WorkspaceSync {
    private timer: ReturnType<typeof setTimeout> | undefined
    private request: AbortController | null = null
    private running = false
    private disposed = false
    private reload = true
    private requestedRevision = 0
    private failed = false
    private retryDelay = 1000
    private stopListening: () => void
    constructor(private store: WorkspaceStore, private transport: Transport) {
        this.stopListening = store.subscribe(() => {
            if (!this.running && !this.failed && this.store.hasPending()) this.schedule(180)
        })
        store.retrySync = this.retry
        this.schedule(0)
    }
    invalidate = (revision?: number) => {
        if (revision !== undefined && revision <= this.store.revision()) return
        if (revision === undefined) this.reload = true
        else this.requestedRevision = Math.max(this.requestedRevision, revision)
        this.failed = false
        this.schedule(0)
    }
    retry = () => { this.failed = false; this.reload = true; this.schedule(0) }
    private schedule(delay: number) {
        if (this.disposed || this.running) return
        clearTimeout(this.timer)
        this.timer = setTimeout(() => void this.flush(), delay)
    }
    async flush(): Promise<void> {
        if (this.disposed || this.running) return
        clearTimeout(this.timer)
        this.running = true
        this.request = new AbortController()
        this.store.setSyncStatus('syncing')
        let retry = false
        try {
            do {
                if (this.reload || this.requestedRevision > this.store.revision()) {
                    this.reload = false
                    const snapshot = WorkspaceSnapshotSchema.parse(await this.transport.getWorkspaces(this.request.signal))
                    if (this.disposed) return
                    this.store.receive(snapshot)
                }
                const request = this.store.nextRequest()
                if (!request) continue
                const result: WorkspaceUpdateResult = await this.transport.updateWorkspaces(request, this.request.signal)
                if (this.disposed) return
                const snapshot = WorkspaceSnapshotSchema.parse(result.snapshot)
                this.store.receive(snapshot, result.status === 'conflict' ? undefined : request.operation.id, result.skipped)
            } while (this.reload || this.requestedRevision > this.store.revision() || this.store.hasPending())
            this.retryDelay = 1000
            this.failed = false
            this.store.setSyncStatus('synced')
        } catch (error) {
            if (this.disposed) return
            this.reload = true
            this.failed = true
            const permanent = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
            this.store.setSyncStatus(permanent ? 'error' : 'offline', permanent ? error.message : undefined)
            this.store.initializeOffline()
            retry = !permanent
        } finally {
            this.request = null
            this.running = false
            if (!this.disposed && retry) { this.schedule(this.retryDelay); this.retryDelay = Math.min(30_000, this.retryDelay * 2) }
            else if (!this.disposed && !this.failed && (this.reload || this.requestedRevision > this.store.revision() || this.store.hasPending())) this.schedule(0)
        }
    }
    dispose() {
        this.disposed = true
        clearTimeout(this.timer)
        this.request?.abort()
        this.stopListening()
        if (this.store.retrySync === this.retry) this.store.retrySync = () => {}
    }
}
