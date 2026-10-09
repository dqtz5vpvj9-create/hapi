import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { NativeStopFixture } from '@/test/nativeStopFixture';
import { NativeCodexHistory } from './nativeHistory';
import type { MessageDependenciesResponse, MessagesResponse } from '@hapi/protocol/apiTypes';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
    const home = await mkdtemp(join(tmpdir(), 'native-nested-test-'));
    const sources = new Map(['root', 'child', 'grandchild', 'unrelated'].map(id => [id, new NativeStopFixture(home, id)]));
    cleanups.push(async () => { for (const source of sources.values()) source.close(); await rm(home, { recursive: true, force: true }); });
    const add = (thread: string, id: string, item: Record<string, unknown>) => {
        const source = sources.get(thread)!;
        const turn = source.addTurn(`turn-${id}`, 'completed', true);
        source.addItem(turn, id, turn.ordinal + 1, { ...item, id });
    };
    const spawn = (target: string) => ({ type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: [target],
        agentsStates: { [target]: { status: 'completed', message: target } } });
    add('root', 'spawn', spawn('child')); add('child', 'nested-spawn', spawn('grandchild'));
    const command = { type: 'commandExecution', command: 'echo public-fixture', status: 'completed', aggregatedOutput: 'PUBLIC GRANDCHILD', exitCode: 0 };
    add('grandchild', 'tool', command); add('unrelated', 'tool', command);
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = { request: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push({ method, params });
        const source = sources.get(String(params.threadId));
        if (!source) throw new Error('Unknown fixture thread');
        return source.request(method, params);
    } };
    return { home, sources, calls, add, command, history: new NativeCodexHistory('root', client, home), client };
}
const dependencies = async (history: NativeCodexHistory, seeds: string) =>
    await history.read({ operation: 'dependencies', seeds, epoch: 0 }) as MessageDependenciesResponse;
const nestedSeed = (result: MessageDependenciesResponse) => result.messages.find(m => m.id.startsWith('native:child:')
    && JSON.stringify(m.content).includes('agent-run-update'))!.id;

describe('indexed nested dependency user flow', () => {
    it('expands a parent then its nested child using the authorized seed thread and stable native positions', async () => {
        const { history, calls } = await fixture();
        const page = await history.read({ limit: 50 }) as MessagesResponse;
        const parent = await dependencies(history, page.messages.find(m => JSON.stringify(m.content).includes('agent-run-update'))!.id);
        expect(parent.complete).toBe(true);
        expect(JSON.stringify(parent.messages)).toContain('PUBLIC GRANDCHILD');
        const count = calls.length;
        const nested = await dependencies(history, nestedSeed(parent));
        expect(nested.complete).toBe(true);
        const grandchild = nested.messages.filter(m => m.id.startsWith('native:grandchild:'));
        expect(grandchild.length).toBeGreaterThan(0);
        expect(grandchild.map(m => [m.id, m.seq, m.invokedAt])).toEqual(parent.messages.filter(m => m.id.startsWith('native:grandchild:')).map(m => [m.id, m.seq, m.invokedAt]));
        expect(calls.length - count).toBeLessThanOrEqual(1);
    });

    it('restores an evicted nested seed with its actual parent and never promotes a descendant to root', async () => {
        const { history, add, command, calls } = await fixture();
        for (let i = 0; i < 300; i++) add('grandchild', `pressure-${i}`, command);
        const page = await history.read({ limit: 50 }) as MessagesResponse;
        const parent = await dependencies(history, page.messages.find(m => JSON.stringify(m.content).includes('agent-run-update'))!.id);
        const seed = nestedSeed(parent);
        for (let i = 0; i < 7; i++) await dependencies(history, seed);
        const beforeRestore = calls.length;
        history.invalidate(false);
        const nested = await dependencies(history, seed);
        expect(nested.messages.some(m => m.id.startsWith('native:grandchild:'))).toBe(true);
        expect(calls.slice(beforeRestore).some(call => call.params.threadId === 'child')).toBe(true);
        const traceSeed = parent.messages.find(m => m.id.startsWith('native:child:') && JSON.stringify(m.content).includes('agent-run-trace'))!.id;
        const restored = await dependencies(history, traceSeed);
        const childCall = restored.messages.find(m => m.id.startsWith('native:child:') && JSON.stringify(m.content).includes('agent-run-trace'))!;
        expect((childCall.content as any).content.data.scope.parentThreadId).toBe('root');
        for (const message of nested.messages.filter(m => m.id.startsWith('native:grandchild:')))
            expect((message.content as any).content.data.scope.parentThreadId).toBe('child');
    });

    it('rejects unproven descendant IDs even with valid metadata, and cold-rebuilds authorization through parent expansion', async () => {
        const { home, client, calls, history } = await fixture();
        const page = await history.read({ limit: 50 }) as MessagesResponse;
        const parent = await dependencies(history, page.messages.find(m => JSON.stringify(m.content).includes('agent-run-update'))!.id);
        const seed = nestedSeed(parent);
        const cold = new NativeCodexHistory('root', client, home);
        await expect(dependencies(cold, seed)).rejects.toThrow('Native message not found');
        const count = calls.length;
        await expect(dependencies(history, seed.replace('native:child:', 'native:unrelated:'))).rejects.toThrow('Native message not found');
        await expect(dependencies(history, seed + '-forged')).rejects.toThrow('Native message not found');
        expect(calls.slice(count).some(c => c.params.threadId === 'unrelated')).toBe(false);
        const rebuilt = await dependencies(cold, page.messages.find(m => JSON.stringify(m.content).includes('agent-run-update'))!.id);
        expect((await dependencies(cold, nestedSeed(rebuilt))).complete).toBe(true);
        expect(calls.every(c => c.method === 'thread/items/list' || c.method === 'thread/turns/list')).toBe(true);
        expect(calls.every(c => Number(c.params.limit) <= 32)).toBe(true);
    });

    it('retains retryable metadata failure for a proven descendant whose native index is unavailable', async () => {
        const { history, sources } = await fixture();
        const page = await history.read({ limit: 50 }) as MessagesResponse;
        const parent = await dependencies(history, page.messages.find(m => JSON.stringify(m.content).includes('agent-run-update'))!.id);
        const seed = nestedSeed(parent);
        sources.get('child')!.database.query('DELETE FROM thread_items WHERE thread_id=?').run('child');
        await expect(dependencies(history, seed)).rejects.toMatchObject({ retryable: true });
        // Bodies already being cached must not bypass native metadata validation.
        expect(JSON.stringify(parent.messages)).toContain('PUBLIC GRANDCHILD');
    });
});


describe('dependencies-first shared native coordinate epoch', () => {
    it.each(['ancestor', 'replacement', 'descendant'] as const)('resets %s changes before returning dependency coordinates and keeps page/context coherent', async mode => {
        const home = await mkdtemp(join(tmpdir(), 'native-deps-first-'));
        const root = '11111111-1111-1111-1111-111111111111';
        const parent = '22222222-2222-2222-2222-222222222222';
        const child = '33333333-3333-3333-3333-333333333333';
        const sources = new Map([root, parent, child].map(id => [id, new NativeStopFixture(home, id)]));
        cleanups.push(async () => { for (const source of sources.values()) source.close(); await rm(home, { recursive: true, force: true }); });
        const p = sources.get(parent)!; p.addTurn('parent-discarded', 'completed', false, true);
        const r = sources.get(root)!;
        if (mode === 'replacement') r.addTurn('predecessor', 'completed', false, true);
        const turn = r.addTurn('spawn-turn', 'completed', true);
        r.addItem(turn, 'spawn', turn.ordinal + 1, { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed',
            receiverThreadIds: [child], agentsStates: { [child]: { status: 'completed', message: 'public child' } } });
        sources.get(child)!.addTurn('child-public', 'completed', false, true);
        const directory = `${home}/sessions/2026/10/01`; await mkdir(directory, { recursive: true });
        const header = async (name: string, id: string, ordinal: number, fork = false) => await writeFile(`${directory}/${name}.jsonl`,
            JSON.stringify({ type: 'session_meta', ordinal, payload: { id, ...(fork ? { forked_from_id: parent, forked_from_ordinal_exclusive: 1 } : {}) } }) + '\n');
        await header(`rollout-2026-10-01T00-00-00-${root}`, root, 0, mode === 'ancestor');
        if (mode === 'descendant') await header(`rollout-2026-10-01T00-00-00-${child}`, child, 0, true);
        if (mode === 'replacement') {
            p.database.query('DELETE FROM thread_items WHERE thread_id=?').run(parent);
            p.database.query('DELETE FROM thread_turns WHERE thread_id=?').run(parent);
            r.database.query('UPDATE thread_turns SET thread_id=? WHERE turn_id=?').run(parent, turn.id);
            r.database.query('UPDATE thread_items SET thread_id=? WHERE turn_id=?').run(parent, turn.id);
            await header(`rollout-2026-10-01T00-00-01-${root}_${parent}`, root, 1000);
        }
        const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
        const client = { request: async (method: string, params: Record<string, unknown> = {}) => {
            calls.push({ method, params });
            const source = sources.get(String(params.threadId));
            if (!source) throw new Error('Unapproved fixture thread');
            return source.request(method, params);
        } };
        const history = new NativeCodexHistory(root, client, home);
        const page = await history.read({ limit: 50 }) as MessagesResponse;
        const seed = page.messages.find(message => JSON.stringify(message.content).includes('agent-run-update'))!;
        const readDependencies = async (epoch: number) => await history.read({ operation: 'dependencies', seeds: seed.id, epoch }) as MessageDependenciesResponse;
        const initial = await readDependencies(page.page.epoch);
        expect(initial.epoch).toBe(page.page.epoch); expect(initial.reset).toBe(false);
        if (mode === 'replacement') r.database.query("UPDATE thread_turns SET rollout_end_ordinal=1000 WHERE thread_id=? AND turn_id='predecessor'").run(root);
        else p.database.query('UPDATE thread_turns SET rollout_end_ordinal=1000 WHERE thread_id=?').run(parent);
        // The first post-change operation is dependency expansion, with cached authorized bodies.
        const changed = await readDependencies(initial.epoch);
        expect(changed.reset).toBe(true); expect(changed.epoch).not.toBe(initial.epoch);
        const original = new Map(initial.messages.map(message => [message.id, message]));
        expect(changed.messages.map(message => message.id)).toEqual(initial.messages.map(message => message.id));
        const moved = changed.messages.filter(message => message.seq !== original.get(message.id)!.seq);
        expect(moved.length).toBeGreaterThan(0);
        expect(moved.every(message => message.id.startsWith(`native:${mode === 'descendant' ? child : root}:`))).toBe(true);
        const repeated = await readDependencies(changed.epoch);
        expect(repeated.reset).toBe(false); expect(repeated.epoch).toBe(changed.epoch);
        expect(repeated.messages.map(message => [message.id, message.seq])).toEqual(changed.messages.map(message => [message.id, message.seq]));
        // Dependency replies omit the requested seed, but include other root
        // messages from the same real native item that main history can restore.
        const changedSeed = changed.messages.find(message => page.messages.some(row => row.id === message.id))!;
        expect(changedSeed).toBeDefined();
        const restored = await history.read({ operation: 'context', messageId: changedSeed.id, radius: 5, epoch: initial.epoch }) as any;
        expect(restored.page.reset).toBe(true); expect(restored.page.epoch).toBe(changed.epoch);
        expect(restored.anchor).toEqual({ messageId: changedSeed.id, position: { seq: changedSeed.seq, at: changedSeed.invokedAt } });
        const stalePage = await history.read({ limit: 50, beforeSeq: seed.seq, beforeAt: seed.invokedAt, epoch: initial.epoch }) as MessagesResponse;
        expect(stalePage.page.reset).toBe(true); expect(stalePage.page.epoch).toBe(changed.epoch);
        expect(stalePage.messages.find(message => message.id === changedSeed.id)?.seq).toBe(changedSeed.seq);
        const current = await history.read({ limit: 50, afterSeq: changedSeed.seq, afterAt: changedSeed.invokedAt, epoch: changed.epoch }) as MessagesResponse;
        expect(current.page.reset).toBe(false); expect(current.page.epoch).toBe(changed.epoch);
        expect((await readDependencies(changed.epoch)).epoch).toBe(changed.epoch);
        expect(calls.every(call => ['thread/items/list', 'thread/turns/list'].includes(call.method) && Number(call.params.limit) <= 32)).toBe(true);
    });
});
