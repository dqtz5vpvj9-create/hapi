import { randomUUID } from 'node:crypto';

/** Opt-in timings only; never include RPC arguments, paths, credentials or content. */
export class SessionStartupTrace {
    private readonly started = performance.now();
    constructor(readonly id = randomUUID(), private readonly enabled = process.env.HAPI_TRACE_SESSION_STARTUP === '1') {}

    mark(stage: string, durationMs?: number, outcome: 'ok' | 'error' = 'ok'): void {
        if (!this.enabled) return;
        process.stderr.write(`[session-startup] ${JSON.stringify({ id: this.id, pid: process.pid, stage,
            elapsedMs: performance.now() - this.started, durationMs, outcome })}\n`);
    }

    async measure<T>(stage: string, work: () => Promise<T>): Promise<T> {
        const started = performance.now();
        try {
            const result = await work();
            this.mark(stage, performance.now() - started);
            return result;
        } catch (error) {
            this.mark(stage, performance.now() - started, 'error');
            throw error;
        }
    }
}
