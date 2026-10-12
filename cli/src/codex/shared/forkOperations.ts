import type { ForkOperationRpcRequest, ForkOperationRpcResponse } from '@hapi/protocol/forkOperations';
import { ForkJournal, type ForkJournalEntry, type ForkPlan, type ForkOperationOrigin } from './forkJournal';

export type ForkLifecycle = {
    preflight(): Promise<ForkPlan>;
    prepare(plan: ForkPlan, childSessionId: string): Promise<void>;
    send(plan: ForkPlan, hooks: {
        beforeSend(identity: { requestId: number; transportGeneration: number }): Promise<void>;
        onLateResult(result: unknown): Promise<void>;
        onLateError(error: Error): Promise<void>;
    }): Promise<unknown>;
    nativeId(result: unknown): string | undefined;
    bind(entry: ForkJournalEntry, result?: unknown): Promise<void>;
};

/** Creation and binding have separate durable barriers. Native error != non-creation. */
export class SharedForkOperations {
    private readonly binding = new Map<string, Promise<void>>();
    constructor(private readonly journal: ForkJournal) {}
    private async response(request: ForkOperationRpcRequest, source: string): Promise<ForkOperationRpcResponse> {
        const entry = await this.journal.read(request, source);
        if (!entry) throw new Error('Fork operation is not recorded by this source runtime; it cannot be recreated');
        return { operation: entry.operation, ...(entry.operation.status === 'created' && entry.operation.binding === 'ready' ? { sessionId: entry.operation.childSessionId } : {}) };
    }
    private async bind(request: ForkOperationRpcRequest, source: string, lifecycle: ForkLifecycle, result?: unknown): Promise<void> {
        const running = this.binding.get(request.operationId); if (running) return running;
        const work = (async () => {
            const entry = await this.journal.read(request, source);
            if (entry?.operation.status !== 'created' || entry.operation.binding === 'ready') return;
            try { await lifecycle.bind(entry, result); await this.journal.bound(request, source); }
            catch (error) { await this.journal.bound(request, source, error); }
        })();
        this.binding.set(request.operationId, work);
        try { await work; } finally { this.binding.delete(request.operationId); }
    }
    async handle(request: ForkOperationRpcRequest, source: string, lifecycle: ForkLifecycle, origin: ForkOperationOrigin = 'hub'): Promise<ForkOperationRpcResponse> {
        if (request.action === 'close-unadmitted') {
            await this.journal.closeUnadmitted(request, source, origin);
            return this.response(request, source);
        }
        if (request.action !== 'start') {
            const entry = await this.journal.read(request, source);
            if (!entry) throw new Error('Fork operation is not recorded by this source runtime; it cannot be recreated');
            if (request.action === 'reconcile' && entry.operation.status === 'created' && entry.operation.binding !== 'ready') await this.bind(request, source, lifecycle);
            return this.response(request, source);
        }
        const admission = await this.journal.admit(request, source, origin);
        if (!admission.admitted) return this.response(request, source);
        const accept = async (result: unknown) => {
            const nativeId = lifecycle.nativeId(result);
            if (!nativeId) { await this.journal.unknown(request, source, 'Native fork reply did not contain a child identity'); return; }
            await this.journal.created(request, source, nativeId);
            await this.bind(request, source, lifecycle, result);
        };
        try {
            const plan = await lifecycle.preflight();
            await lifecycle.prepare(plan, request.childSessionId);
            const result = await lifecycle.send(plan, {
                beforeSend: identity => this.journal.dispatch(request, source, { ...identity, plan }),
                onLateResult: accept,
                onLateError: error => this.journal.unknown(request, source, error),
            });
            await accept(result);
        } catch (error) {
            const current = await this.journal.read(request, source);
            if (current?.dispatch || current?.operation.status === 'created') await this.journal.unknown(request, source, error);
            else await this.journal.reject(request, source, 'fork_preflight_rejected', error instanceof Error ? error.message : String(error));
        }
        return this.response(request, source);
    }
}
