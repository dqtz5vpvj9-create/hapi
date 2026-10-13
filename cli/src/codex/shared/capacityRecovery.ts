import type { NativeRuntimeState } from '@hapi/protocol/schemas';

export function isCapacityError(raw: unknown): boolean {
    const error = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const info = error.codexErrorInfo ?? error.codex_error_info;
    if (info != null) return info === 'serverOverloaded';
    const message = typeof raw === 'string' ? raw : error.message;
    return typeof message === 'string'
        && /^Selected model is at capacity(?:\. Please try a different model\.)?\.?$/i.test(message.trim());
}

type Recovery = NonNullable<NativeRuntimeState['capacityRecovery']>;
export type CapacityContinuation = string | { goal: true; turnId?: string; cancel(): Promise<void> };
type Dispatch = { epoch: number; goalTurn?: string };
/** One bridge-owned timer. Never resubmit user input or retry an uncertain RPC. */
export class CapacityRecovery {
    private epoch = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private attempt = 0;
    private continuationTurn?: string;
    private request?: Promise<CapacityContinuation>;
    private dispatching?: Dispatch;
    private goalResume = false;
    private readonly terminal = new Set<string>();
    private readonly suppressed = new Set<string>();
    constructor(private readonly host: {
        inspect(turnId: string, continuation: boolean): Promise<boolean>;
        continue(): Promise<CapacityContinuation>;
        interrupt(turnId: string): Promise<void>;
        publish(state: Recovery | null): void;
        random?: () => number;
    }) {}
    get isDispatching(): boolean { return this.dispatching !== undefined; }
    get ownsGoalResume(): boolean { return this.goalResume && !this.continuationTurn; }
    cancel(): void {
        this.epoch++; clearTimeout(this.timer); this.timer = undefined;
        this.attempt = 0; this.continuationTurn = undefined; this.goalResume = false; this.host.publish(null);
    }
    suppress(turnId?: string): void {
        if (turnId) this.remember(this.suppressed, turnId);
        this.cancel();
    }
    started(turnId?: string, goalContinuation = false): void {
        if (turnId && turnId === this.continuationTurn) return;
        if (this.dispatching) {
            // A goal/set ACK has no turn ID. The root must independently prove
            // that this first started event still belongs to the resumed goal.
            if (goalContinuation && turnId && this.dispatching.epoch === this.epoch) {
                if (this.dispatching.goalTurn && this.dispatching.goalTurn !== turnId) this.cancel();
                else this.dispatching.goalTurn = turnId;
            }
            return;
        }
        if (this.goalResume && !this.continuationTurn && goalContinuation && turnId) {
            this.continuationTurn = turnId;
            return;
        }
        this.cancel();
    }
    nativeRetry(): void {
        clearTimeout(this.timer); this.timer = undefined;
        // Native error notifications own recovery until turn/completed.
        if (!this.dispatching) this.epoch++;
    }
    async failed(turnId: string): Promise<void> {
        if (this.terminal.has(turnId) || this.suppressed.has(turnId)) return;
        this.remember(this.terminal, turnId);
        const epoch = this.epoch;
        // A notification can arrive synchronously while continue() returns its promise.
        await Promise.resolve();
        if (this.request) await this.request.catch(() => {});
        if (epoch !== this.epoch || this.suppressed.has(turnId)) return;
        const continuation = this.continuationTurn === turnId;
        let safe = false;
        try { safe = await this.host.inspect(turnId, continuation); } catch { /* No read proof, no retry. */ }
        if (epoch !== this.epoch || this.suppressed.has(turnId)) return;
        if (!safe || this.attempt >= 5) {
            this.host.publish({ turnId, phase: 'failed', reason: safe ? 'exhausted' : 'unverified' }); return;
        }
        this.attempt++;
        const base = Math.min(300_000, 30_000 * 2 ** (this.attempt - 1));
        const delay = Math.min(300_000, base * (1 + (this.host.random ?? Math.random)() * 0.2));
        this.host.publish({ turnId, phase: 'waiting', retryAt: Date.now() + delay, attempt: this.attempt, maxAttempts: 5 });
        this.timer = setTimeout(() => { this.timer = undefined; void this.dispatch(epoch, turnId, continuation); }, delay);
        this.timer.unref?.();
    }
    private remember(turns: Set<string>, turnId: string): void {
        turns.add(turnId);
        if (turns.size > 64) turns.delete(turns.values().next().value!);
    }
    private async dispatch(epoch: number, turnId: string, continuation: boolean): Promise<void> {
        if (epoch !== this.epoch) return;
        let dispatch: Dispatch | undefined;
        try {
            if (!await this.host.inspect(turnId, continuation) || epoch !== this.epoch) {
                if (epoch === this.epoch) this.cancel();
                return;
            }
            this.host.publish({ turnId, phase: 'continuing', attempt: this.attempt, maxAttempts: 5 });
            dispatch = { epoch }; this.dispatching = dispatch;
            const request = this.host.continue(); this.request = request;
            try {
                const receipt = await request;
                const id = typeof receipt === 'string' ? receipt : receipt.turnId ?? dispatch.goalTurn;
                if (epoch !== this.epoch) {
                    // Stop can arrive before the ACK. A goal receipt can pause
                    // only the same goal; never guess a turn ID to interrupt.
                    // Suppress before asynchronous cleanup so a late failure
                    // waiting on this ACK cannot start another recovery chain.
                    if (id) this.remember(this.suppressed, id);
                    if (typeof receipt !== 'string') await receipt.cancel().catch(() => {});
                    if (id) await this.host.interrupt(id).catch(() => {});
                    return;
                }
                this.continuationTurn = id;
                this.goalResume = typeof receipt !== 'string';
            } finally { if (this.request === request) this.request = undefined; }
        } catch {
            if (epoch === this.epoch) {
                this.epoch++;
                this.goalResume = false;
                this.host.publish({ turnId, phase: 'failed', reason: 'unconfirmed' });
            }
            // RPC errors, timeouts and disconnects are never automatically replayed.
        } finally { if (this.dispatching === dispatch) this.dispatching = undefined; }
    }
}
