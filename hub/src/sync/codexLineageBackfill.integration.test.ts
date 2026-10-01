import { describe, expect, it, spyOn } from 'bun:test';
import type { Machine, SyncEvent } from '@hapi/protocol/types';
import { Store } from '../store';
import { RpcRegistry } from '../socket/rpcRegistry';
import { RpcGateway } from './rpcGateway';
import { SyncEngine } from './syncEngine';

describe('Codex lineage metadata integration', () => {
    it('writes descendants onto ordinary root rows once and leaves metadata versions and activity times unchanged on no-op refreshes', async () => {
        const store = new Store(':memory:');
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never);
        const session = engine.getOrCreateSession('root', { path: '/project', host: 'test', machineId: 'm', flavor: 'codex', codexSessionId: 'native-root' }, null, 'n');
        const machines = spyOn(engine, 'getOnlineMachinesByNamespace').mockReturnValue([{ id: 'm', namespace: 'n', active: true } as Machine]);
        const rpc = spyOn(RpcGateway.prototype, 'codexSessionLineageForMachine').mockResolvedValue([{ id: 'native-root', codexSubagents: [{ threadId: 'child', parentThreadId: 'native-root', status: 'unknown' }] }]);
        try {
            await engine.refreshCodexSessionLineage('n');
            const first = engine.getSessionByNamespace(session.id, 'n')!;
            expect(first.metadata?.codexSubagents).toHaveLength(1);
            expect(first.metadataVersion).toBe(session.metadataVersion + 1); expect(first.updatedAt).toBe(session.updatedAt);
            await engine.refreshCodexSessionLineage('n');
            const second = engine.getSessionByNamespace(session.id, 'n')!;
            expect(second.metadataVersion).toBe(first.metadataVersion); expect(second.updatedAt).toBe(first.updatedAt);
            expect(rpc).toHaveBeenCalledTimes(1);
        } finally { machines.mockRestore(); rpc.mockRestore(); engine.stop(); store.close(); }
    });
    it('preserves concurrent metadata and activity time and broadcasts the new version through standard SSE', async () => {
        const store = new Store(':memory:');
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never);
        const session = engine.getOrCreateSession('child', { path: '/project', host: 'test', machineId: 'm', flavor: 'codex', codexSessionId: 'native-child' }, null, 'n');
        const other = engine.getOrCreateSession('other', { path: '/project', host: 'test', machineId: 'other', flavor: 'codex', codexSessionId: 'native-other' }, null, 'n');
        const events: SyncEvent[] = []; const stop = engine.subscribe(event => events.push(event));
        const machines = spyOn(engine, 'getOnlineMachinesByNamespace').mockReturnValue([{ id: 'm', namespace: 'n', active: true } as Machine]);
        const rpc = spyOn(RpcGateway.prototype, 'codexSessionLineageForMachine').mockImplementation(async (machineId, ids) => {
            expect(machineId).toBe('m'); expect(ids).toEqual(['native-child']);
            const current = engine.getSessionByNamespace(session.id, 'n')!;
            const concurrent = store.sessions.updateSessionMetadata(session.id, { ...current.metadata!, name: 'Concurrent title' }, current.metadataVersion, 'n', { touchUpdatedAt: false });
            expect(concurrent.result).toBe('success'); engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id, namespace: 'n' });
            return [{ id: 'native-child', cwd: '/project', codexParentThreadId: 'native-parent', codexAgentNickname: 'Ada' }, { id: 'native-other', codexParentThreadId: 'malicious' }];
        });
        try {
            await engine.refreshCodexSessionLineage('n');
            const current = engine.getSessionByNamespace(session.id, 'n')!;
            expect(current.metadata?.name).toBe('Concurrent title');
            expect(current.metadata?.codexParentThreadId).toBe('native-parent');
            expect(current.updatedAt).toBe(session.updatedAt); expect(current.metadataVersion).toBe(session.metadataVersion + 2);
            expect(engine.getSessionByNamespace(other.id, 'n')!.metadata?.codexParentThreadId).toBeUndefined();
            expect(events.some(event => event.type === 'session-updated' && event.sessionId === session.id
                && 'data' in event && event.data && 'metadataVersion' in event.data && event.data.metadataVersion === current.metadataVersion)).toBe(true);
            expect(rpc).toHaveBeenCalledTimes(1);
        } finally { machines.mockRestore(); rpc.mockRestore(); stop(); engine.stop(); store.close(); }
    });
    it('does not overwrite metadata when the store rejects the expected version', async () => {
        const store = new Store(':memory:');
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never);
        const session = engine.getOrCreateSession('child', { path: '/project', host: 'test', machineId: 'm', flavor: 'codex', codexSessionId: 'native-child', name: 'Preserve' }, null, 'n');
        const machines = spyOn(engine, 'getOnlineMachinesByNamespace').mockReturnValue([{ id: 'm', namespace: 'n', active: true } as Machine]);
        const rpc = spyOn(RpcGateway.prototype, 'codexSessionLineageForMachine').mockResolvedValue([{ id: 'native-child', codexParentThreadId: 'native-parent' }]);
        const update = spyOn(store.sessions, 'updateSessionMetadata').mockImplementation(() => ({ result: 'version-mismatch', version: session.metadataVersion, value: JSON.stringify(session.metadata) }));
        try {
            await engine.refreshCodexSessionLineage('n');
            expect(engine.getSessionByNamespace(session.id, 'n')!.metadata?.name).toBe('Preserve');
            expect(engine.getSessionByNamespace(session.id, 'n')!.metadata?.codexParentThreadId).toBeUndefined();
            expect(update.mock.calls[0][2]).toBe(session.metadataVersion);
            expect(update.mock.calls[0][3]).toBe('n');
        } finally { update.mockRestore(); machines.mockRestore(); rpc.mockRestore(); engine.stop(); store.close(); }
    });
});
