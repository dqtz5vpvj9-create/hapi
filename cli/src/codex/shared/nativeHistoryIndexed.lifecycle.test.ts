import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NativeStopFixture } from '@/test/nativeStopFixture';
import { NativeIndexedHistory } from './nativeHistoryIndexed';
import { NativeHistoryMetadata, openNativeMetadata, NativeMetadataUnavailable } from './nativeHistoryMetadata';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
    const home = mkdtempSync('/mnt/cache/data-cache/indexed-lifecycle-'); dirs.push(home);
    const f = new NativeStopFixture(home, '11111111-1111-1111-1111-111111111111');
    const request = async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === 'thread/read') return { thread: { id: f.threadId } } as T;
        return await f.request(method, params as Record<string, unknown>) as T;
    };
    return { f, home, request };
}
describe('indexed native lifecycle metadata', () => {
    it('pages valid late updates from older turns using rollout order without rejecting their original times', async () => {
        const { f, home, request } = fixture();
        try {
            const older = f.addTurn('older', 'completed', false, true);
            const newer = f.addTurn('newer', 'completed', false, true);
            f.addItem(older, 'late-older', 10, { id: 'late-older', type: 'agentMessage', text: 'late old turn update' });
            const reader = new NativeIndexedHistory(f.threadId, { request }, home);
            const result = await reader.read({ limit: 20 }) as any;
            expect(result.messages.at(-1).content.content.data.message).toBe('late old turn update');
            expect(result.messages.at(-1).createdAt).toBe(older.startedAt! * 1000 + 1500);
            expect(result.messages.at(-1).invokedAt).toBe(newer.startedAt! * 1000);
            expect(result.messages.every((m: any, i: number) => !i || m.invokedAt >= result.messages[i - 1].invokedAt)).toBe(true);
            const before = await reader.read({ beforeSeq: result.messages.at(-1).seq, beforeAt: result.messages.at(-1).invokedAt, epoch: result.page.epoch, limit: 20 }) as any;
            expect(before.messages.map((m: any) => m.id)).not.toContain(result.messages.at(-1).id);
        } finally { f.close(); }
    });
    it('reads metadata across replaced execution identities while keeping the public RPC identity', async () => {
        const { f, home } = fixture();
        try {
            f.addTurn('first', 'completed', false, true);
            f.addTurn('replacement', 'interrupted', false, true);
            const execution = '22222222-2222-2222-2222-222222222222';
            f.database.query('UPDATE thread_turns SET thread_id=? WHERE turn_id=?').run(execution, 'replacement');
            f.database.query('UPDATE thread_items SET thread_id=? WHERE turn_id=?').run(execution, 'replacement');
            const directory = join(home, 'sessions', '2026', '10', '01'); mkdirSync(directory, { recursive: true });
            const path = join(directory, `rollout-2026-10-01T00-00-00-${f.threadId}_${execution}.jsonl`);
            writeFileSync(path, JSON.stringify({ type: 'session_meta', ordinal: 100000, payload: { id: f.threadId } }) + '\n'); // Replacement boundary metadata; no transcript bodies.
            const calls: string[] = [];
            const request = async <T>(method: string, params?: unknown): Promise<T> => {
                calls.push(method);
                if (method === 'thread/read') return { thread: { id: f.threadId, path } } as T;
                return await f.request(method, params as Record<string, unknown>) as T;
            };
            const result = await new NativeIndexedHistory(f.threadId, { request }, home).read({ limit: 20 }) as any;
            expect(result.messages.filter((m: any) => m.content.role === 'user')).toHaveLength(2);
            expect(result.messages.some((m: any) => m.id === `native-turn-status:${f.threadId}:replacement:turn_aborted`)).toBe(true);
            expect(calls.filter(method => method === 'thread/read')).toHaveLength(0);
            expect(f.calls.every(call => call.params.threadId === f.threadId && Number(call.params.limit) <= 32)).toBe(true);
        } finally { f.close(); }
    });
    it('selects the newest duplicate projection across multiple replacements and pages colliding local ordinals consistently', async () => {
        const { f, home } = fixture();
        try {
            f.addTurn('first', 'completed', false, true);
            f.addTurn('second', 'completed', false, true);
            f.addTurn('third', 'completed', false, true);
            const second = '22222222-2222-2222-2222-222222222222';
            const third = '33333333-3333-3333-3333-333333333333';
            for (const [id, turn, ordinal] of [[second, 'second', 5], [third, 'third', 9]] as const) {
                f.database.query('INSERT INTO thread_turns SELECT ?,turn_id,1,status,started_at,completed_at,4 FROM thread_turns WHERE thread_id=? AND turn_id=?').run(id, f.threadId, turn);
                f.database.query('INSERT INTO thread_items SELECT ?,turn_id,item_id,rollout_ordinal-?,created_at_ms,started_at_ms,completed_at_ms,item_type,item_json FROM thread_items WHERE thread_id=? AND turn_id=?').run(id, ordinal - 1, f.threadId, turn);
            }
            // An old retained duplicate is stale; official history reports the current status.
            f.database.query("UPDATE thread_turns SET status='interrupted' WHERE thread_id=? AND turn_id='second'").run(f.threadId);
            const directory = join(home, 'sessions', '2026', '10', '01'); mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, `rollout-2026-10-01T01-00-00-${f.threadId}_${second}.jsonl`), JSON.stringify({ type: 'session_meta', ordinal: 100000, payload: { id: f.threadId } }) + '\n');
            writeFileSync(join(directory, `rollout-2026-10-01T02-00-00-${f.threadId}_${third}.jsonl`), JSON.stringify({ type: 'session_meta', ordinal: 200000, payload: { id: f.threadId } }) + '\n');
            const db = openNativeMetadata(home);
            try {
                const index = new NativeHistoryMetadata(db, f.threadId, [f.threadId, second, third]);
                expect(index.turn('second').status).toBe('completed');
                const items = index.items(Number.MAX_SAFE_INTEGER, 'desc', 32);
                expect(new Set(items.map(item => item.item_id)).size).toBe(6);
                expect(new Set(items.map(item => item.rollout_ordinal)).size).toBe(6);
                const answer = index.item('second', 'second-answer');
                expect(index.predecessor(answer)?.item_id).toBe('second-question');
            } finally { db.close(); }
            const request = async <T>(method: string, params?: unknown): Promise<T> => await f.request(method, params as Record<string, unknown>) as T;
            const reader = new NativeIndexedHistory(f.threadId, { request }, home);
            const page = await reader.read({ limit: 2 }) as any;
            const older = await reader.read({ limit: 2, beforeSeq: page.page.nextBeforeSeq, beforeAt: page.page.nextBeforeAt, epoch: page.page.epoch }) as any;
            expect(older.messages.every((m: any) => m.seq < page.page.nextBeforeSeq)).toBe(true);
            expect(page.messages.some((m: any) => m.id.includes('third'))).toBe(true);
            const forward = await reader.read({ limit: 20, afterSeq: older.page.nextAfterSeq, afterAt: older.page.nextAfterAt, epoch: page.page.epoch }) as any;
            expect(forward.messages.some((m: any) => m.id === page.messages.at(-1).id)).toBe(true);
            expect(forward.messages.every((m: any) => m.seq > older.page.nextAfterSeq)).toBe(true);
            const reconnect = await new NativeIndexedHistory(f.threadId, { request }, home).read({ limit: 2 }) as any;
            expect(reconnect.messages.map((m: any) => [m.id,m.seq,m.invokedAt])).toEqual(page.messages.map((m: any) => [m.id,m.seq,m.invokedAt]));
            // Growth in an older retained execution changes generation spans.
            // Stale cursor requests must reset before filtering with old seqs.
            f.database.query("UPDATE thread_turns SET rollout_end_ordinal=1000 WHERE thread_id=? AND turn_id='third'").run(f.threadId);
            const shifted = await reader.read({ limit: 2, beforeSeq: page.page.nextBeforeSeq, beforeAt: page.page.nextBeforeAt, epoch: page.page.epoch }) as any;
            expect(shifted.page.reset).toBe(true);
            expect(shifted.page.epoch).not.toBe(page.page.epoch);
            expect(shifted.messages.map((m: any) => m.id)).toEqual(page.messages.map((m: any) => m.id));
            const shiftedAfter = await reader.read({ limit: 2, afterSeq: page.page.nextAfterSeq, afterAt: page.page.nextAfterAt, epoch: page.page.epoch }) as any;
            expect(shiftedAfter.page.reset).toBe(true);
            expect(shiftedAfter.messages.map((m: any) => m.id)).toEqual(page.messages.map((m: any) => m.id));
            const restored = await reader.read({ operation: 'context', messageId: page.messages.at(-1).id, radius: 2, epoch: page.page.epoch }) as any;
            expect(restored.anchor.messageId).toBe(page.messages.at(-1).id);
            expect(restored.page.reset).toBe(true);

        } finally { f.close(); }
    });
    it('excludes abandoned branches across replacements without shadowing retained users, including cold outline and context', async () => {
        const { f, home, request } = fixture();
        try {
            f.addTurn('retained', 'completed', false, true);
            f.addTurn('abandoned', 'completed', false, true);
            f.addTurn('canonical', 'completed', false, true);
            const middle = '22222222-2222-2222-2222-222222222222';
            const current = '33333333-3333-3333-3333-333333333333';
            f.database.query('UPDATE thread_turns SET thread_id=? WHERE turn_id=?').run(current, 'canonical');
            f.database.query('UPDATE thread_items SET thread_id=? WHERE turn_id=?').run(current, 'canonical');
            // A discarded middle-execution duplicate must not shadow the retained original.
            f.database.query('INSERT INTO thread_turns SELECT ?,turn_id,20,status,started_at,completed_at,23 FROM thread_turns WHERE thread_id=? AND turn_id=?').run(middle, f.threadId, 'retained');
            f.database.query('INSERT INTO thread_items SELECT ?,turn_id,item_id,rollout_ordinal+19,created_at_ms,started_at_ms,completed_at_ms,item_type,item_json FROM thread_items WHERE thread_id=? AND turn_id=?').run(middle, f.threadId, 'retained');
            f.turns.splice(f.turns.findIndex(turn => turn.id === 'abandoned'), 1);
            for (let i = f.items.length - 1; i >= 0; i--) if (f.items[i].turnId === 'abandoned') f.items.splice(i, 1);
            const directory = join(home, 'sessions', '2026', '10', '01'); mkdirSync(directory, { recursive: true });
            for (const [time, execution, ordinal] of [['01', middle, 5], ['02', current, 10]] as const) {
                writeFileSync(join(directory, `rollout-2026-10-01T${time}-00-00-${f.threadId}_${execution}.jsonl`), JSON.stringify({ type: 'session_meta', ordinal, payload: { id: f.threadId } }) + '\n');
            }
            const reader = new NativeIndexedHistory(f.threadId, { request }, home);
            const outline = await reader.read({ operation: 'outline', limit: 10 }) as any;
            expect(outline.entries).toHaveLength(2);
            expect(outline.entries.map((entry: any) => entry.label)).toEqual(['QUESTION retained', 'QUESTION canonical']);
            const full = await reader.read({ limit: 20 }) as any;
            expect(full.messages).toHaveLength(4);
            expect(full.messages.some((message: any) => message.id.includes('abandoned'))).toBe(false);
            const cold = await new NativeIndexedHistory(f.threadId, { request }, home).read({ operation: 'outline', limit: 10 }) as any;
            expect(cold.entries.map((entry: any) => entry.messageId)).toEqual(outline.entries.map((entry: any) => entry.messageId));
            const context = await reader.read({ operation: 'context', messageId: outline.entries[0].messageId, radius: 3 }) as any;
            expect(context.messages.map((message: any) => message.id)).toEqual(full.messages.map((message: any) => message.id));
            const latest = await reader.read({ limit: 2 }) as any;
            const previous = await reader.read({ limit: 2, beforeAt: latest.page.nextBeforeAt, beforeSeq: latest.page.nextBeforeSeq, epoch: latest.page.epoch }) as any;
            expect([...previous.messages, ...latest.messages].map((message: any) => message.id)).toEqual(full.messages.map((message: any) => message.id));
            expect(f.calls.every(call => call.params.turnId !== 'abandoned')).toBe(true);
        } finally { f.close(); }
    });
    it('reads copied legacy fork history without requiring a sparse parent cutoff or adding the later parent branch', async () => {
        const { f, home, request } = fixture();
        try {
            f.addTurn('inherited', 'completed', false, true);
            f.addTurn('parent-after-fork', 'completed', false, true);
            f.addTurn('child', 'completed', false, true);
            const parent = '22222222-2222-2222-2222-222222222222';
            f.database.query('INSERT INTO thread_turns SELECT ?,turn_id,rollout_ordinal,status,started_at,completed_at,rollout_end_ordinal FROM thread_turns WHERE thread_id=?').run(parent, f.threadId);
            f.database.query('INSERT INTO thread_items SELECT ?,turn_id,item_id,rollout_ordinal,created_at_ms,started_at_ms,completed_at_ms,item_type,item_json FROM thread_items WHERE thread_id=?').run(parent, f.threadId);
            f.database.query("DELETE FROM thread_turns WHERE thread_id=? AND turn_id='parent-after-fork'").run(f.threadId);
            f.database.query("DELETE FROM thread_items WHERE thread_id=? AND turn_id='parent-after-fork'").run(f.threadId);
            f.turns.splice(f.turns.findIndex(turn => turn.id === 'parent-after-fork'), 1);
            for (let index = f.items.length - 1; index >= 0; index--) {
                if (f.items[index].turnId === 'parent-after-fork') f.items.splice(index, 1);
            }
            const directory = join(home, 'sessions', '2026', '10', '01'); mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, `rollout-2026-10-01T01-00-00-${f.threadId}.jsonl`), JSON.stringify({
                type: 'session_meta', ordinal: 0, payload: { id: f.threadId, forked_from_id: parent }
            }) + '\n');
            const reader = new NativeIndexedHistory(f.threadId, { request }, home);
            const page = await reader.read({ limit: 20 }) as any;
            expect(page.messages.filter((message: any) => message.content.role === 'user').map((message: any) => message.content.content.text))
                .toEqual(['QUESTION inherited', 'QUESTION child']);
            expect(page.messages).toHaveLength(4);
            const outline = await reader.read({ operation: 'outline', limit: 10 }) as any;
            expect(outline.entries.map((entry: any) => entry.label)).toEqual(['QUESTION inherited', 'QUESTION child']);
            const latest = await reader.read({ limit: 2 }) as any;
            const earlier = await reader.read({ limit: 2, beforeAt: latest.page.nextBeforeAt, beforeSeq: latest.page.nextBeforeSeq, epoch: latest.page.epoch }) as any;
            expect([...earlier.messages, ...latest.messages].map((message: any) => message.id)).toEqual(page.messages.map((message: any) => message.id));
            expect(f.calls.every(call => call.params.threadId === f.threadId && Number(call.params.limit) <= 32)).toBe(true);
        } finally { f.close(); }
    });
    it('retains canonical inherited fork items and excludes the parent branch after the exclusive fork boundary', async () => {
        const { f, home, request } = fixture();
        try {
            f.addTurn('inherited', 'completed', false, true);
            f.addTurn('parent-after-fork', 'completed', false, true);
            f.addTurn('child', 'completed', false, true);
            const parent = '22222222-2222-2222-2222-222222222222';
            const parentReplacement = '33333333-3333-3333-3333-333333333333';
            f.database.query("UPDATE thread_turns SET thread_id=? WHERE turn_id!='child'").run(parent);
            f.database.query("UPDATE thread_items SET thread_id=? WHERE turn_id!='child'").run(parent);
            f.database.query('INSERT INTO thread_turns SELECT ?,turn_id,20,status,started_at,completed_at,23 FROM thread_turns WHERE thread_id=? AND turn_id=?').run(parentReplacement, parent, 'inherited');
            f.database.query('INSERT INTO thread_items SELECT ?,turn_id,item_id,rollout_ordinal+19,created_at_ms,started_at_ms,completed_at_ms,item_type,item_json FROM thread_items WHERE thread_id=? AND turn_id=?').run(parentReplacement, parent, 'inherited');
            f.turns.splice(f.turns.findIndex(turn => turn.id === 'parent-after-fork'), 1);
            for (let i = f.items.length - 1; i >= 0; i--) if (f.items[i].turnId === 'parent-after-fork') f.items.splice(i, 1);
            const directory = join(home, 'sessions', '2026', '10', '01'); mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, `rollout-2026-10-01T00-00-00-${parent}.jsonl`), JSON.stringify({ type: 'session_meta', ordinal: 0, payload: { id: parent } }) + '\n');
            writeFileSync(join(directory, `rollout-2026-10-01T01-00-00-${f.threadId}.jsonl`), JSON.stringify({ type: 'session_meta', ordinal: 5, payload: { id: f.threadId, forked_from_id: parent, forked_from_ordinal_exclusive: 5 } }) + '\n');
            writeFileSync(join(directory, `rollout-2026-10-01T02-00-00-${parent}_${parentReplacement}.jsonl`), JSON.stringify({ type: 'session_meta', ordinal: 6, payload: { id: parent } }) + '\n');
            const reader = new NativeIndexedHistory(f.threadId, { request }, home);
            const outline = await reader.read({ operation: 'outline', limit: 10 }) as any;
            expect(outline.entries.map((entry: any) => entry.label)).toEqual(['QUESTION inherited', 'QUESTION child']);
            const full = await reader.read({ limit: 20 }) as any;
            expect(full.messages).toHaveLength(4);
            const context = await reader.read({ operation: 'context', messageId: outline.entries[0].messageId, radius: 3 }) as any;
            expect(context.messages.map((message: any) => message.id)).toEqual(full.messages.map((message: any) => message.id));
            const cold = await new NativeIndexedHistory(f.threadId, { request }, home).read({ limit: 20 }) as any;
            expect(cold.messages.map((message: any) => [message.id, message.seq, message.invokedAt])).toEqual(full.messages.map((message: any) => [message.id, message.seq, message.invokedAt]));
        } finally { f.close(); }
    });
    it('still rejects a genuinely unsynchronized terminal notification', async () => {
        const { f, home, request } = fixture();
        try {
            const turn = f.addTurn('active', 'inProgress', false, true);
            const reader = new NativeIndexedHistory(f.threadId, { request }, home);
            f.complete(turn, 'interrupted', false);
            reader.terminal(turn);
            await expect(reader.read({ limit: 20 })).rejects.toBeInstanceOf(NativeMetadataUnavailable);
            f.persist(turn);
            const result = await reader.read({ limit: 20 }) as any;
            expect(result.messages.some((m: any) => m.id.includes('turn_aborted'))).toBe(true);
        } finally { f.close(); }
    });
});
