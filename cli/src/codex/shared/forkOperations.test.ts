import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForkOperationRpcRequest } from '@hapi/protocol/forkOperations';
import { ForkJournal } from './forkJournal';
import { SharedForkOperations, type ForkLifecycle } from './forkOperations';

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function setup() {
    const home = await mkdtemp(join(tmpdir(), 'hapi-fork-operation-')); homes.push(home);
    const journal = await ForkJournal.open(home, { namespace: 'team', hub: 'hub', authHash: 'auth', owner: 'runtime' });
    const request: ForkOperationRpcRequest = { action: 'start', operationId: randomUUID(), sourceSessionId: 'parent', childSessionId: randomUUID(), sourceRevision: 1, sourceNativeThreadId: 'source', sourceMachineId: 'machine', fingerprint: 'head' };
    const lifecycle: ForkLifecycle = {
        preflight: vi.fn(async () => ({ params: { threadId: 'source' }, settings: { collaborationMode: 'plan' } })),
        prepare: vi.fn(async () => {}),
        send: vi.fn(async (_plan, hooks) => { await hooks.beforeSend({ requestId: 9, transportGeneration: 2 }); return { thread: { id: 'exact-child' } }; }),
        nativeId: value => (value as { thread: { id: string } }).thread.id,
        bind: vi.fn(async entry => { expect((await journal.read(request, 'source'))?.operation).toMatchObject({ status: 'created', nativeThreadId: 'exact-child' }); expect(entry.dispatch?.plan.settings).toEqual({ collaborationMode: 'plan' }); }),
    };
    return { home, journal, request, lifecycle, service: new SharedForkOperations(journal) };
}

describe('fork creation/binding causal barriers', () => {
    it('keeps missing read/reconcile read-only and explicitly closes B before any delayed start', async () => {
        const { journal, home, request, service, lifecycle } = await setup();
        const op = { ...request, sourceStoreId: home };
        for (const action of ['read', 'reconcile'] as const) {
            await expect(service.handle({ ...op, action }, 'source', lifecycle)).rejects.toThrow('not recorded');
            expect(await journal.read(op, 'source')).toBeUndefined();
        }
        const closed = await service.handle({ ...op, action: 'close-unadmitted' }, 'source', lifecycle);
        expect(closed.operation).toMatchObject({ status: 'rejected', code: 'fork_closed_unadmitted', rejectionProof: 'not_dispatched' });
        expect(await service.handle(op, 'source', lifecycle)).toEqual(closed);
        for (const callback of [lifecycle.preflight, lifecycle.prepare, lifecycle.send, lifecycle.bind]) expect(callback).not.toHaveBeenCalled();
    });
    it('returns an admitted B during paused preparation without closing or dispatching it from the close action', async () => {
        const { home, request, service, lifecycle } = await setup(); const op = { ...request, sourceStoreId: home };
        let prepared!: () => void; const entered = new Promise<void>(resolve => prepared = resolve);
        let release!: () => void; const resume = new Promise<void>(resolve => release = resolve);
        lifecycle.prepare = vi.fn(async () => { prepared(); await resume; }); lifecycle.bind = vi.fn(async () => {});
        const start = service.handle(op, 'source', lifecycle); await entered;
        expect((await service.handle({ ...op, action: 'close-unadmitted' }, 'source', lifecycle)).operation.status).toBe('running');
        expect(lifecycle.send).not.toHaveBeenCalled(); release();
        expect((await start).operation).toMatchObject({ status: 'created', binding: 'ready' });
        expect(lifecycle.send).toHaveBeenCalledTimes(1);
    });
    it('persists exact native identity before binding and dispatches once for repeated starts', async () => {
        const { service, request, lifecycle } = await setup();
        const result = await service.handle(request, 'source', lifecycle);
        expect(result).toMatchObject({ sessionId: request.childSessionId, operation: { status: 'created', binding: 'ready' } });
        await service.handle(request, 'source', lifecycle);
        expect(lifecycle.send).toHaveBeenCalledTimes(1); expect(lifecycle.prepare).toHaveBeenCalledWith(expect.anything(), request.childSessionId);
    });
    it('native error after creating remains unknown and fences a new operation', async () => {
        const { service, request, lifecycle } = await setup(); let serverChildren = 0;
        lifecycle.send = vi.fn(async (_plan, hooks) => { await hooks.beforeSend({ requestId: 9, transportGeneration: 2 }); serverChildren++; throw new Error('inherit goal failed after child creation'); });
        expect((await service.handle(request, 'source', lifecycle)).operation.status).toBe('indeterminate');
        await service.handle(request, 'source', lifecycle);
        const next = await service.handle({ ...request, operationId: randomUUID(), childSessionId: randomUUID() }, 'source', lifecycle);
        expect(next.operation).toMatchObject({ status: 'rejected', code: 'fork_source_unresolved' });
        expect(serverChildren).toBe(1); expect(lifecycle.bind).not.toHaveBeenCalled();
    });
    it.each(['root subscribe failed', 'flush false', 'settings failed'])('retains known child after %s and reconciliation binds only that child', async failure => {
        const { service, request, lifecycle } = await setup();
        lifecycle.bind = vi.fn().mockRejectedValueOnce(new Error(failure)).mockResolvedValueOnce(undefined);
        expect((await service.handle(request, 'source', lifecycle)).operation).toMatchObject({ status: 'created', binding: 'blocked', nativeThreadId: 'exact-child' });
        expect((await service.handle({ ...request, action: 'read' }, 'source', lifecycle)).operation).toMatchObject({ binding: 'blocked' });
        expect(lifecycle.bind).toHaveBeenCalledTimes(1);
        expect((await service.handle({ ...request, action: 'reconcile' }, 'source', lifecycle)).operation).toMatchObject({ status: 'created', binding: 'ready' });
        expect(lifecycle.send).toHaveBeenCalledTimes(1); expect(lifecycle.prepare).toHaveBeenCalledTimes(1);
    });
    it('late exact response upgrades unknown to created and binds without resending', async () => {
        const { service, request, lifecycle } = await setup(); let late: ((result: unknown) => Promise<void>) | undefined;
        lifecycle.send = vi.fn(async (_plan, hooks) => { await hooks.beforeSend({ requestId: 9, transportGeneration: 2 }); late = hooks.onLateResult; throw new Error('timed out'); });
        expect((await service.handle(request, 'source', lifecycle)).operation.status).toBe('indeterminate');
        await late!({ thread: { id: 'exact-child' } });
        expect((await service.handle({ ...request, action: 'read' }, 'source', lifecycle)).operation).toMatchObject({ status: 'created', binding: 'ready' });
        expect(lifecycle.send).toHaveBeenCalledTimes(1);
    });
    it('preflight rejection proves no write and permits a deliberate new operation', async () => {
        const { service, request, lifecycle } = await setup();
        lifecycle.preflight = vi.fn().mockRejectedValueOnce(new Error('unsafe sandbox inheritance')).mockResolvedValueOnce({ params: {}, settings: {} });
        expect((await service.handle(request, 'source', lifecycle)).operation).toMatchObject({ status: 'rejected', rejectionProof: 'not_dispatched' });
        expect(lifecycle.send).not.toHaveBeenCalled();
        lifecycle.bind = vi.fn(async () => {});
        expect((await service.handle({ ...request, operationId: randomUUID() }, 'source', lifecycle)).operation.status).toBe('created');
    });
    it('restart exact-child recovery never reruns preflight, preparation, or native fork', async () => {
        const { journal, home, service, request, lifecycle } = await setup();
        lifecycle.bind = vi.fn().mockRejectedValueOnce(new Error('process stopped')).mockResolvedValue(undefined);
        await service.handle(request, 'source', lifecycle);
        const fresh = new SharedForkOperations(await ForkJournal.open(home, { namespace: 'team', hub: 'hub', authHash: 'auth', owner: 'restarted' }));
        expect((await fresh.handle({ ...request, action: 'reconcile' }, 'source', lifecycle)).operation).toMatchObject({ status: 'created', binding: 'ready' });
        expect(lifecycle.send).toHaveBeenCalledTimes(1); expect(lifecycle.preflight).toHaveBeenCalledTimes(1);
        expect((await journal.read(request, 'source'))?.operation.childSessionId).toBe(request.childSessionId);
    });
});
