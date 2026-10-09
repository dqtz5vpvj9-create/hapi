import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { NativeStopFixture } from '@/test/nativeStopFixture';
import { NativeIndexedHistory } from './nativeHistoryIndexed';
import { NativeMetadataUnavailable } from './nativeHistoryMetadata';

const fixtures: Array<{ home: string; f: NativeStopFixture }> = [];
afterEach(() => {
    for (const { home, f } of fixtures.splice(0)) {
        f.close();
        rmSync(home, { recursive: true, force: true });
    }
});
function fixture(onRead?: (method: string) => void) {
    const home = mkdtempSync(join(tmpdir(), 'indexed-concurrent-'));
    const f = new NativeStopFixture(home, '11111111-1111-1111-1111-111111111111');
    fixtures.push({ home, f });
    const client = { request: async <T>(method: string, params?: unknown): Promise<T> => {
        const result = await f.request(method, params as Record<string, unknown>);
        onRead?.(method);
        return result as T;
    } };
    return { f, home, client, reader: new NativeIndexedHistory(f.threadId, client, home) };
}

describe('native history read consistency', () => {
    it('reads stale open turns normalized by Codex without inventing a durable interruption', async () => {
        const { f, home, client, reader } = fixture();
        const turn = f.addTurn('stale', 'inProgress', false, true);
        // The native read API does this for unloaded/idle threads. The rollout
        // and its sparse index still have no end event or completion timestamp.
        turn.status = 'interrupted';
        const page = await reader.read({ limit: 20 }) as any;
        expect(page.messages).toHaveLength(2);
        expect(page.messages.map((m: any) => m.content.meta.nativeExecution.turn)).toEqual([
            { status: 'interrupted', started: true, ended: false },
            { status: 'interrupted', started: true, ended: false },
        ]);
        const again = await reader.read({ limit: 20 }) as any;
        expect(again.messages).toEqual(page.messages);
        const cold = await new NativeIndexedHistory(f.threadId, client, home).read({ limit: 20 }) as any;
        expect(cold.messages).toEqual(page.messages);
        const context = await reader.read({ operation: 'context', messageId: page.messages[0].id, radius: 2 }) as any;
        expect(context.messages).toEqual(page.messages);
        expect(f.database.query('SELECT status,completed_at,rollout_end_ordinal FROM thread_turns').get()).toEqual({
            status: 'inProgress', completed_at: null, rollout_end_ordinal: null,
        });
        turn.status = 'inProgress';
        reader.invalidate(false);
        const active = await reader.read({ limit: 20 }) as any;
        expect(active.messages.every((m: any) => m.content.meta.nativeExecution.turn.status === 'inProgress')).toBe(true);
    });

    it.each(['thread/turns/list', 'thread/items/list'])('keeps a coherent snapshot when an append arrives during %s', async method => {
        let appended = false;
        const { f, reader } = fixture(readMethod => {
            if (readMethod === method && !appended) {
                appended = true;
                f.addTurn('new', 'inProgress', false, true);
                reader.invalidate(false);
            }
        });
        f.addTurn('old', 'completed', false, true);
        const first = await reader.read({ limit: 20 }) as any;
        expect(first.messages).toHaveLength(2);
        expect(first.messages.every((m: any) => m.content.meta.nativeExecution.turnId === 'old')).toBe(true);
        const next = await reader.read({ limit: 20 }) as any;
        expect(next.messages).toHaveLength(4);
        expect(next.messages.slice(0, 2)).toEqual(first.messages);
        expect(next.page.epoch).toBe(first.page.epoch);
        expect(f.calls.filter(call => call.method === 'thread/turns/list')).toHaveLength(2);
    });

    it('rejects a snapshot revoked by rollback during an item read', async () => {
        let reset = false;
        const { f, reader } = fixture(method => {
            if (method === 'thread/items/list' && !reset) {
                reset = true;
                reader.invalidate(true);
            }
        });
        f.addTurn('original', 'completed', false, true);
        await expect(reader.read({ limit: 20 })).rejects.toBeInstanceOf(NativeMetadataUnavailable);
        const next = await reader.read({ limit: 20 }) as any;
        expect(next.messages).toHaveLength(2);
    });
});
