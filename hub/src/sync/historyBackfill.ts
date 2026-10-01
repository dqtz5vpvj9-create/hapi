/** Only histories requested through authorized reads are queued. Each timer
 * performs one bounded Store batch, then yields and rotates sessions. Startup
 * never scans the database; persisted Store progress survives worker restart. */
export class HistoryBackfill {
    private readonly pending = new Set<string>()
    private timer: ReturnType<typeof setTimeout> | null = null
    private stopped = false

    constructor(
        private readonly runBatch: (sessionId: string) => { complete: boolean },
        private readonly onError: (sessionId: string, error: unknown) => void =
            (sessionId, error) => console.error('History metadata backfill failed', sessionId, error),
    ) {}

    request(sessionId: string): boolean {
        if (this.stopped || (!this.pending.has(sessionId) && this.pending.size >= 32)) return false
        this.pending.add(sessionId)
        this.schedule()
        return true
    }

    stop(): void {
        this.stopped = true
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
        this.pending.clear()
    }

    private schedule(): void {
        if (this.timer || this.stopped || !this.pending.size) return
        this.timer = setTimeout(() => {
            this.timer = null
            const sessionId = this.pending.values().next().value!
            this.pending.delete(sessionId)
            try {
                const batch = this.runBatch(sessionId)
                if (!batch.complete) this.pending.add(sessionId)
            } catch (error) {
                // The Store transaction has rolled back. Retry only after a
                // new read, rather than spinning on an unavailable database.
                this.onError(sessionId, error)
            }
            this.schedule()
        }, 25)
        this.timer.unref()
    }
}
