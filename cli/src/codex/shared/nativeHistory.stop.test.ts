import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { NativeCodexHistory } from './nativeHistory';
import { NativeStopFixture } from '@/test/nativeStopFixture';
import type { MessagesResponse, MessageContextResponse, MessageOutlineResponse, MessageDependenciesResponse } from '@hapi/protocol/apiTypes';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
    const home = await mkdtemp('/mnt/cache/data-cache/native-stop-test-');
    const source = new NativeStopFixture(home);
    cleanups.push(async () => { source.close(); await rm(home, { recursive: true, force: true }); });
    return { home, source, history: new NativeCodexHistory('thread', source, home) };
}
const stopped = (page: { messages: MessagesResponse['messages'] }) => page.messages.filter(message =>
    (message.content as any)?.content?.type === 'event' && (message.content as any).content.data?.message === 'Aborted by user');
const read = async (history: NativeCodexHistory, args = {}) => await history.read({ limit: 50, ...args }) as MessagesResponse;

describe('native sparse terminal-status history', () => {
    it('recovers persisted interrupted status, refreshes and reconnects without duplicate or successor mislabel', async () => {
        const { source, home, history } = await fixture();
        source.addTurn('stopped', 'interrupted', false, true);
        source.addTurn('next', 'completed');
        const initial = await read(history);
        expect(stopped(initial)).toHaveLength(1);
        const event = stopped(initial)[0];
        expect(event.id).toBe('native-turn-status:thread:stopped:turn_aborted');
        expect(event.createdAt).toBe(1700000001000);
        expect(event.invokedAt).toBe(1700000000000);
        expect(initial.messages.map(m => m.id)).toEqual([
            expect.stringContaining('stopped-question'), expect.stringContaining('stopped-answer'), event.id, expect.stringContaining('next-question')
        ]);
        history.invalidate(false);
        expect(stopped(await read(history)).map(m => [m.id, m.seq])).toEqual([[event.id, event.seq]]);
        expect(stopped(await read(new NativeCodexHistory('thread', source, home))).map(m => [m.id, m.seq])).toEqual([[event.id, event.seq]]);
        expect(source.calls.every(call => Number(call.params.limit) <= 32)).toBe(true);
        expect(initial.messages.some(m => JSON.stringify(m.content).includes('DO NOT READ'))).toBe(false);
    });

    it('uses persisted completion time for an itemless interrupted turn whose start time was not recorded', async () => {
        const { source, home, history } = await fixture();
        const turn = source.addTurn('no-start', 'interrupted', true);
        turn.startedAt = null; source.persist(turn);
        const page = await read(history);
        expect(stopped(page)).toHaveLength(1);
        expect(stopped(page)[0].createdAt).toBe(1700000001000);
        expect(stopped(page)[0].invokedAt).toBe(1700000001000);
        const context = await new NativeCodexHistory('thread', source, home).read({ operation: 'context', messageId: stopped(page)[0].id, radius: 1 }) as MessageContextResponse;
        expect(context.anchor.position).toEqual({ at: stopped(page)[0].invokedAt, seq: stopped(page)[0].seq });
    });

    it('reports retryable unavailability when notification/RPC wins the SQLite persistence race, then recovers', async () => {
        const { source, history } = await fixture();
        const turn = source.addTurn('stopped', 'inProgress');
        expect(stopped(await read(history))).toHaveLength(0);
        source.complete(turn, 'interrupted', false);
        history.terminal(turn); history.invalidate(false);
        await expect(read(history)).rejects.toMatchObject({ retryable: true });
        source.persist(turn);
        expect(stopped(await read(history))).toHaveLength(1);
        // Notification can also precede both RPC and SQLite. It must not accept
        // their mutually consistent but stale inProgress status as authoritative.
        const second = source.addTurn('second', 'inProgress', true);
        history.terminal({ id: second.id, status: 'interrupted' }); history.invalidate(false);
        await expect(read(history)).rejects.toMatchObject({ retryable: true });
        source.complete(second, 'interrupted');
        expect(stopped(await read(history))).toHaveLength(2);
    });

    it('paginates across hundreds of itemless turns without losing stops or scanning the full history in one read', async () => {
        const { source, history } = await fixture();
        source.addTurn('old-question', 'completed');
        for (let i = 0; i < 150; i++) source.addTurn(`gap-${i}`, i % 2 ? 'completed' : 'interrupted', true);
        source.addTurn('new-question', 'completed');
        let page = await read(history); const ids = new Set(page.messages.map(m => m.id)); const events = new Set(stopped(page).map(m => m.id));
        for (let i = 0; page.page.hasMore && i < 20; i++) {
            const count = source.calls.length;
            page = await read(history, { epoch: page.page.epoch, beforeAt: page.page.nextBeforeAt, beforeSeq: page.page.nextBeforeSeq });
            expect(source.calls.length - count).toBeLessThanOrEqual(4);
            for (const message of page.messages) { ids.add(message.id); if (stopped({ messages: [message] }).length) events.add(message.id); }
        }
        expect(page.page.hasMore).toBe(false);
        expect(events.size).toBe(75);
        expect([...ids].some(id => id.includes('old-question-question'))).toBe(true);
        expect([...ids].some(id => id.includes('new-question-question'))).toBe(true);
    });

    it('cold-restores a far itemless status with native identity, bounded neighbors and no fake item anchor', async () => {
        const { source, home } = await fixture();
        source.addTurn('ancient', 'interrupted', true);
        for (let i = 0; i < 1000; i++) source.addTurn(`later-${i}`, 'completed', i % 3 !== 0);
        const history = new NativeCodexHistory('thread', source, home);
        const context = await history.read({ operation: 'context', messageId: 'native-turn-status:thread:ancient:turn_aborted', radius: 10 }) as MessageContextResponse;
        expect(context.anchor.messageId).toBe('native-turn-status:thread:ancient:turn_aborted');
        expect(stopped(context)).toHaveLength(1);
        expect(context.page.hasMoreAfter).toBe(true);
        expect(source.calls.length).toBeLessThanOrEqual(6);
        expect(source.calls.filter(c => c.params.cursor && typeof c.params.cursor === 'object')
            .every(c => source.items.some(item => item.item.id === (c.params.cursor as any).itemId))).toBe(true);
        const latest = await read(history);
        const stable = context.anchor.position;
        history.invalidate();
        const again = await history.read({ operation: 'context', messageId: context.anchor.messageId, radius: 10, epoch: latest.page.epoch }) as MessageContextResponse;
        expect(again.anchor.position).toEqual(stable);
        expect(again.page.reset).toBe(true);
    });

    it('keeps item cold context and outline identities on the same native position scale', async () => {
        const { source, home } = await fixture();
        for (let i = 0; i < 80; i++) source.addTurn(`turn-${i}`, i === 0 ? 'interrupted' : 'completed');
        const history = new NativeCodexHistory('thread', source, home);
        const outline = await history.read({ operation: 'outline', limit: 10 }) as MessageOutlineResponse;
        expect(outline.entries).toHaveLength(10);
        expect(outline.entries.every(entry => !entry.messageId.startsWith('native-turn-status:'))).toBe(true);
        const entry = outline.entries[0];
        const context = await new NativeCodexHistory('thread', source, home).read({ operation: 'context', messageId: entry.messageId, radius: 2 }) as MessageContextResponse;
        expect(context.anchor.position).toEqual({ at: entry.at, seq: entry.seq });
        expect(context.messages.some(message => message.id === entry.messageId)).toBe(true);
    });

    it('handles an entirely itemless interrupted history and unavailable schema without body or full-history fallback', async () => {
        const { source, history } = await fixture();
        source.addTurn('only-stop', 'interrupted', true);
        const page = await read(history);
        expect(stopped(page)).toHaveLength(1);
        expect(page.page.hasMore).toBe(false);
        expect(source.calls.map(c => c.method)).toEqual(['thread/turns/list']);
        source.database.exec('DROP TABLE thread_turns'); history.invalidate();
        await expect(read(history)).rejects.toMatchObject({ retryable: true });
        expect(source.calls.every(c => c.method !== 'thread/read')).toBe(true);
    });

    it('keeps native tool dependency identities and positions coherent with the indexed timeline', async () => {
        const { source, history } = await fixture();
        source.addTurn('tool-turn', 'completed');
        const id = source.items[0].item.id;
        source.items[0].item = { id, type: 'commandExecution', command: 'echo fixture', cwd: source.home,
            status: 'completed', aggregatedOutput: 'FIXTURE TOOL RESULT', exitCode: 0, durationMs: 1 };
        source.database.query('UPDATE thread_items SET item_type=? WHERE thread_id=? AND item_id=?').run('commandExecution', 'thread', id);
        const page = await read(history);
        const result = page.messages.find(row => JSON.stringify(row.content).includes('tool-call-result'))!;
        expect(result).toBeDefined();
        const dependencies = await history.read({ operation: 'dependencies', seeds: result.id, epoch: page.page.epoch }) as MessageDependenciesResponse;
        expect(dependencies.complete).toBe(true);
        expect(dependencies.epoch).toBe(page.page.epoch);
        expect(dependencies.reset).toBe(false);
        expect(dependencies.messages.some(row => JSON.stringify(row.content).includes('CodexBash'))).toBe(true);
        for (const row of dependencies.messages) {
            const ordinary = page.messages.find(message => message.id === row.id)!;
            expect(ordinary).toBeDefined();
            expect({ at: row.invokedAt, seq: row.seq }).toEqual({ at: ordinary.invokedAt, seq: ordinary.seq });
        }
    });

    it('bounds whole-outline RPC rows/bytes and uses the real partial user-message index', async () => {
        const { source, history } = await fixture();
        source.database.exec('BEGIN');
        for (let i = 0; i < 1000; i++) source.addTurn(`sparse-${i}`, 'completed', i % 10 !== 0, i % 10 === 0);
        source.database.exec('COMMIT');
        const outline = await history.read({ operation: 'outline', limit: 40 }) as MessageOutlineResponse;
        expect(outline.entries).toHaveLength(31);
        const bodyCalls = source.calls.filter(call => call.method === 'thread/items/list');
        expect(bodyCalls).toHaveLength(31);
        expect(bodyCalls.every(call => call.params.limit === 1 && call.count === 1 && call.params.turnId)).toBe(true);
        expect(bodyCalls.reduce((sum, call) => sum + call.count, 0)).toBe(31);
        expect(bodyCalls.reduce((sum, call) => sum + call.bytes, 0)).toBeLessThan(25000);
        const plan = source.database.query(`EXPLAIN QUERY PLAN SELECT turn_id,item_id,rollout_ordinal,created_at_ms,started_at_ms,completed_at_ms
            FROM thread_items WHERE thread_id=? AND rollout_ordinal<=? AND item_type='userMessage'
            ORDER BY rollout_ordinal DESC LIMIT 32`).all('thread', Number.MAX_SAFE_INTEGER).map(row => row.detail);
        expect(plan.some(row => row.includes('idx_thread_items_user_messages'))).toBe(true);
        await writeFile('/mnt/cache/data-cache/hapi-pipeline/repair/native-stop-revalidation/outline-fixture-cost.json', JSON.stringify({
            scope: 'actual SQLite fixture + actual NativeIndexedHistory + strict issued-cursor RPC',
            turns: 1000, selectedUserEntries: outline.entries.length, totalNativeCalls: source.calls.length,
            bodyCalls: bodyCalls.length, rawBodyRows: bodyCalls.reduce((sum, call) => sum + call.count, 0),
            rawBodyResponseBytes: bodyCalls.reduce((sum, call) => sum + call.bytes, 0),
            allRawResponseBytes: source.calls.reduce((sum, call) => sum + call.bytes, 0), userOnlyQueryPlan: plan
        }, null, 2));
    });

    it('advances a forward frontier through invisible turns, keeps native invocation ordering and restores evicted status', async () => {
        const { source, history } = await fixture();
        source.database.exec('BEGIN');
        source.addTurn('first', 'interrupted', false, true);
        for (let i = 0; i < 600; i++) source.addTurn(`run-${i}`, i === 500 ? 'interrupted' : 'completed', i % 10 !== 0, i % 10 === 0);
        source.database.exec('COMMIT');
        const id = 'native-turn-status:thread:first:turn_aborted';
        const context = await history.read({ operation: 'context', messageId: id, radius: 1 }) as MessageContextResponse;
        let cursor = context.anchor.position; const ids = new Set<string>();
        for (let i = 0; i < 80; i++) {
            const page = await read(history, { epoch: context.page.epoch, afterAt: cursor.at, afterSeq: cursor.seq });
            expect(page.messages.every((message, index) => !index || (message.invokedAt! > page.messages[index - 1].invokedAt!
                || message.invokedAt === page.messages[index - 1].invokedAt && message.seq! > page.messages[index - 1].seq!))).toBe(true);
            for (const message of page.messages) { expect(ids.has(message.id)).toBe(false); ids.add(message.id); }
            if (!page.page.hasMore) break;
            expect(page.page.nextAfterSeq!).toBeGreaterThan(cursor.seq);
            cursor = { at: page.page.nextAfterAt!, seq: page.page.nextAfterSeq! };
        }
        expect(ids.has('native-turn-status:thread:run-500:turn_aborted')).toBe(true);
        expect([...ids].some(key => key.includes('run-590-question'))).toBe(true);
        const restored = await history.read({ operation: 'context', messageId: id, radius: 1 }) as MessageContextResponse;
        expect(restored.anchor.position).toEqual(context.anchor.position);
        expect(stopped(restored).map(message => message.id)).toEqual([id]);
    });

    it('does not advertise an unreturned status in snapshotHead when persistence changes during the body RPC', async () => {
        const { source, history } = await fixture();
        const turn = source.addTurn('racing', 'inProgress');
        const request = source.request.bind(source); let complete = true;
        source.request = async (method, params) => {
            if (method === 'thread/items/list' && complete) { complete = false; source.complete(turn, 'interrupted'); }
            return request(method, params);
        };
        const old = await read(history);
        expect(stopped(old)).toHaveLength(0);
        expect(old.page.snapshotHeadSeq).toBeLessThan(40000);
        const next = await read(history, { epoch: old.page.epoch, afterAt: old.page.snapshotHeadAt, afterSeq: old.page.snapshotHeadSeq });
        expect(stopped(next)).toHaveLength(1);
        expect(stopped(next)[0].seq).toBeGreaterThan(old.page.snapshotHeadSeq!);
    });

    it('makes inconsistent native timestamp ordering explicitly unavailable rather than mixing legacy ranks', async () => {
        const { source, history } = await fixture();
        source.addTurn('first', 'interrupted');
        const later = source.addTurn('later', 'completed');
        later.startedAt = 1699999990; later.completedAt = 1699999991; source.persist(later);
        await expect(read(history)).rejects.toMatchObject({ retryable: true });
        expect(source.calls.every(call => call.method !== 'thread/read')).toBe(true);
    });

    it('does not silently forget terminal notification expectations during a burst', async () => {
        const { source, history } = await fixture();
        for (let i = 0; i < 40; i++) {
            const turn = source.addTurn(`burst-${i}`, 'completed', true);
            history.terminal(turn);
        }
        history.invalidate(false);
        await expect(read(history)).rejects.toMatchObject({ retryable: true });
        expect((await read(history)).messages).toHaveLength(0);
    });

    it('resets the epoch when a rollback replaces an already projected interruption', async () => {
        const { source, history } = await fixture();
        const turn = source.addTurn('stop', 'interrupted');
        const original = await read(history);
        expect(stopped(original)).toHaveLength(1);
        source.complete(turn, 'completed'); history.invalidate(true);
        const next = await read(history, { epoch: original.page.epoch, afterAt: original.page.snapshotHeadAt, afterSeq: original.page.snapshotHeadSeq });
        expect(next.page.reset).toBe(true);
        expect(stopped(next)).toHaveLength(0);
        expect(next.messages.some(m => m.id.includes('stop-question'))).toBe(true);
    });
});
