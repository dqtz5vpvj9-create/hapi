import { isCapacityError } from './capacityRecovery';
import type { NativeRuntimeState } from '@hapi/protocol/schemas';
import { record, string } from './gateway';

function nativeTime(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value)
        ? value < 1e12 ? value * 1000 : value : null;
}

/** State of this root's owning transport, never of another daemon reading its history. */
export class NativeRuntimeStateTracker {
    private status: NativeRuntimeState['status'] = 'idle';
    private waitingOn: NativeRuntimeState['waitingOn'] = [];
    private turnId: string | null = null;
    private startedAt: number | null = null;
    private completedAt: number | null = null;
    private sequence = 0;
    private capacityRecovery: NativeRuntimeState['capacityRecovery'] = null;
    private compaction: { turnId: string; itemId: string } | null = null;
    private readonly terminal = new Set<string>();
    private readonly completedCompactions = new Set<string>();
    constructor(private readonly owner: string, private readonly generation: string) {}

    started(turn: Record<string, unknown>): boolean {
        const id = string(turn.id);
        if (!id || this.terminal.has(id)) return false;
        // Native UUIDv7 turn ids have chronological order. Do not apply that
        // assumption to arbitrary legacy/test ids.
        const uuid7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/i;
        if (this.turnId && uuid7.test(id) && uuid7.test(this.turnId) && id < this.turnId) return false;
        if (id !== this.turnId) {
            this.startedAt = nativeTime(turn.startedAt ?? turn.started_at);
            this.completedAt = null;
            this.capacityRecovery = null;
            this.compaction = null;
            this.completedCompactions.clear();
        } else this.startedAt ??= nativeTime(turn.startedAt ?? turn.started_at);
        this.turnId = id; this.status = 'active'; this.waitingOn = [];
        return true;
    }
    completed(turn: Record<string, unknown>): void {
        const id = string(turn.id);
        if (!id) return;
        this.terminal.add(id);
        if (this.terminal.size > 64) this.terminal.delete(this.terminal.values().next().value!);
        if (this.turnId && this.turnId !== id) return;
        this.turnId = id;
        this.compaction = null;
        this.status = turn.status === 'failed' ? 'systemError' : 'idle';
        this.capacityRecovery = turn.status === 'failed' && (isCapacityError(turn.error)
            || turn.error == null && this.capacityRecovery?.turnId === id)
            ? this.capacityRecovery?.turnId === id && this.capacityRecovery.phase !== 'retrying'
                ? this.capacityRecovery : { turnId: id, phase: 'failed' } : null;
        this.waitingOn = [];
        this.completedAt = nativeTime(turn.completedAt ?? turn.completed_at);
    }
    /** Notifications are scoped by the root and must match its live turn. */
    error(params: Record<string, unknown>): void {
        const id = string(params.turnId);
        if (!id || id !== this.turnId || this.terminal.has(id) || this.status !== 'active') return;
        this.capacityRecovery = isCapacityError(params.error) && typeof params.willRetry === 'boolean'
            ? { turnId: id, phase: params.willRetry ? 'retrying' : 'failed' } : null;
    }
    progress(turnId: unknown): void {
        if (turnId === this.turnId && this.status === 'active' && !this.terminal.has(String(turnId))) this.capacityRecovery = null;
    }
    clearCapacity(): void { this.capacityRecovery = null; }
    recovery(state: NativeRuntimeState['capacityRecovery']): void { this.capacityRecovery = state; }
    acceptStatus(raw: unknown): void {
        const status = record(raw);
        if (!['active', 'idle', 'notLoaded', 'systemError'].includes(String(status.type))) return;
        this.status = status.type as NativeRuntimeState['status'];
        if (this.capacityRecovery?.phase === 'retrying' && this.status !== 'active') {
            this.capacityRecovery = this.status === 'systemError'
                ? { ...this.capacityRecovery, phase: 'failed' } : null;
        }
        if (this.status !== 'active') this.compaction = null;
        const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
        this.waitingOn = [];
        if (flags.includes('waitingOnApproval')) this.waitingOn.push('approval');
        if (flags.includes('waitingOnUserInput')) this.waitingOn.push('input');
    }
    /** Called on the owning transport before asynchronous history/queue work. */
    observeCompaction(method: string, raw: unknown): boolean {
        if (method !== 'item/started' && method !== 'item/completed') return false;
        const params = record(raw), item = record(params.item);
        const turnId = string(params.turnId), itemId = string(item.id);
        if (item.type !== 'contextCompaction' || !turnId || !itemId || this.terminal.has(turnId)
            || this.turnId && this.turnId !== turnId) return false;
        if (method === 'item/started') {
            if (this.completedCompactions.has(itemId)) return false;
            this.compaction = { turnId, itemId };
            return true;
        }
        this.completedCompactions.add(itemId);
        if (this.compaction?.turnId !== turnId || this.compaction.itemId !== itemId) return false;
        this.compaction = null;
        return true;
    }
    snapshot(thread: Record<string, unknown>, turns: Record<string, unknown>[], acceptStatus = true): void {
        const priorStatus = this.status; const priorWaiting = this.waitingOn; const priorCompaction = this.compaction;
        const latest = turns.at(-1);
        if (latest?.status === 'inProgress') this.started(latest);
        else if (latest) this.completed(latest);
        else { this.status = 'idle'; this.waitingOn = []; this.capacityRecovery = null; this.compaction = null; }
        // History can retain inProgress after unloading. Runtime status wins.
        if (acceptStatus) this.acceptStatus(thread.status);
        else { this.status = priorStatus; this.waitingOn = priorWaiting; this.compaction = priorCompaction; }
    }
    disconnected(): void { this.status = 'disconnected'; this.waitingOn = []; this.capacityRecovery = null; this.compaction = null; }
    get canContinue(): boolean { return this.status === 'idle' || this.status === 'systemError'; }
    get running(): boolean { return this.status === 'active'; }
    report(connected: boolean): NativeRuntimeState {
        return { owner: this.owner, generation: this.generation, sequence: ++this.sequence,
            status: connected ? this.status : 'disconnected', waitingOn: connected ? this.waitingOn : [],
            turnId: this.turnId, startedAt: this.startedAt, completedAt: this.completedAt,
            capacityRecovery: connected ? this.capacityRecovery : null,
            ...(connected && this.status === 'active' && this.compaction ? { compacting: true } : {}) };
    }
}
