import { describe, expect, it, spyOn } from 'bun:test';
import type { CodexSessionLineage } from '@hapi/protocol/apiTypes';
import type { Session, Machine } from '@hapi/protocol/types';
import { CodexLineageBackfill } from './codexLineageBackfill';
const row = (id: string, machineId = 'm', namespace = 'n'): Session => ({ id, namespace,
    metadata: { flavor: 'codex', machineId, codexSessionId: id, path: '/project', host: 'test' } } as Session);
const machine = (id = 'm', namespace = 'n', active = true): Machine => ({ id, namespace, active } as Machine);
describe('existing Codex row lineage backfill', () => {
    it('refreshes newly spawned root descendants after twenty seconds and skips unchanged arrays between refreshes', async () => {
        const backfill = new CodexLineageBackfill(); const root = row('root'); let now = 100000, calls = 0, applied = 0;
        const clock = spyOn(Date, 'now').mockImplementation(() => now);
        let children = [{ threadId: 'child', parentThreadId: 'root', status: 'unknown' as const }];
        const lookup = async () => { calls++; return [{ id: 'root', codexSubagents: [...children] }]; };
        const apply = (session: Session, lineage: CodexSessionLineage) => { applied++; session.metadata = { ...session.metadata!, codexSubagents: lineage.codexSubagents }; return true; };
        try {
            await backfill.refresh('n', [root], [machine()], lookup, apply);
            await backfill.refresh('n', [root], [machine()], lookup, apply);
            expect(calls).toBe(1); expect(applied).toBe(1);
            children = [...children, { threadId: 'new-child', parentThreadId: 'root', status: 'unknown' }];
            now += 19999;
            await backfill.refresh('n', [root], [machine()], lookup, apply);
            expect(calls).toBe(1); expect(applied).toBe(1);
            now++;
            await backfill.refresh('n', [root], [machine()], lookup, apply);
            expect(calls).toBe(2); expect(applied).toBe(2);
            expect(root.metadata!.codexSubagents).toHaveLength(2);
        } finally { clock.mockRestore(); }
    });
    it('applies cached native lineage to a newly discovered duplicate HAPI row without querying the native index again', async () => {
        const backfill = new CodexLineageBackfill(); let calls = 0; const applied: string[] = [];
        const original = row('native-child'); original.id = 'hapi-original';
        const discovered = row('native-child'); discovered.id = 'hapi-discovered';
        const lookup = async (_machine: string, ids: string[]) => { calls++; expect(ids).toEqual(['native-child']); return [{ id: 'native-child', codexParentThreadId: 'native-parent' }]; };
        const apply = (session: Session, lineage: { codexParentThreadId?: string }) => { applied.push(session.id); session.metadata = { ...session.metadata!, codexParentThreadId: lineage.codexParentThreadId }; return true; };
        await backfill.refresh('n', [original], [machine()], lookup, apply);
        await backfill.refresh('n', [original, discovered], [machine()], lookup, apply);
        expect(applied).toEqual(['hapi-original', 'hapi-discovered']); expect(calls).toBe(1);
    });
    it('looks up only online same-namespace machine IDs, applies only requested results and caches resolved native IDs', async () => {
        const backfill = new CodexLineageBackfill(); const looked: unknown[] = [], applied: unknown[] = [];
        const sessions = [row('child'), row('other-machine', 'other'), row('other-namespace', 'm', 'other'), row('offline', 'off'), row('claude')];
        sessions[4].metadata!.flavor = 'claude';
        const lookup = async (id: string, ids: string[]) => { looked.push([id, ids]); return [
            { id: 'child', codexParentThreadId: 'parent' }, { id: 'unrequested', codexParentThreadId: 'private' }]; };
        const apply = (session: Session, lineage: { codexParentThreadId?: string }) => { applied.push(session.id); session.metadata = { ...session.metadata!, codexParentThreadId: lineage.codexParentThreadId }; return true; };
        await backfill.refresh('n', sessions, [machine(), machine('m', 'other'), machine('off', 'n', false)], lookup, apply);
        await backfill.refresh('n', sessions, [machine()], lookup, apply);
        expect(looked).toEqual([['m', ['child']]]); expect(applied).toEqual(['child']);
    });
    it('coalesces concurrent lists and retries a rejected metadata update rather than marking it complete', async () => {
        const backfill = new CodexLineageBackfill(); let release!: () => void, calls = 0, applied = 0;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const lookup = async () => { calls++; await gate; return [{ id: 'child', codexParentThreadId: 'parent' }]; };
        const apply = () => { applied++; return false; };
        const first = backfill.refresh('n', [row('child')], [machine()], lookup, apply);
        const second = backfill.refresh('n', [row('child')], [machine()], lookup, apply);
        release(); await Promise.all([first, second]); expect(calls).toBe(1); expect(applied).toBe(1);
        // Failed CAS is intentionally retryable after the same short backoff used for unavailable metadata.
        expect(await backfill.refresh('n', [row('child')], [machine()], lookup, apply)).toBeUndefined();
        expect(calls).toBe(1);
    });
    it('does not expose offline or unavailable machines and keeps ordinary forks as independent rows', async () => {
        const backfill = new CodexLineageBackfill(); let calls = 0, applied = 0;
        const lookup = async () => { calls++; return [{ id: 'fork' }]; };
        await backfill.refresh('n', [row('fork')], [machine()], lookup, () => { applied++; return true; });
        await backfill.refresh('n', [row('fork')], [machine()], lookup, () => true);
        expect(calls).toBe(1); expect(applied).toBe(0);
        await backfill.refresh('n', [row('missing')], [machine('m', 'n', false)], lookup, () => true);
        expect(calls).toBe(1);
    });
});
