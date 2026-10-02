import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SharedCodexQueue } from './queue';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
    const dir = await mkdtemp('/mnt/cache/data-cache/hapi-native-acceptance-'); directories.push(dir);
    const request = vi.fn(async (_method: string, _params?: unknown): Promise<any> => ({ data: [] }));
    const consumed = vi.fn(); const uncertain = vi.fn(); const snapshot = vi.fn();
    const queue = new SharedCodexQueue({ request }, 'thread', join(dir, 'ledger.json'), consumed, uncertain, undefined, undefined, snapshot);
    await queue.load(); return { queue, request, consumed, uncertain, snapshot, dir };
}
const item = (clientId: string, threadId = 'thread') => ({ threadId, turnId: 'turn',
    item: { type: 'userMessage', id: 'native-item', clientId, content: [{ type: 'text', text: 'same text' }] } });

describe('native acceptance and complete snapshots', () => {
    it('keeps an acknowledged dequeue confirming, settles exact identity, and never submits a duplicate', async () => {
        const f = await fixture();
        const handoff = vi.fn(async () => true), requeued = vi.fn(async () => true);
        const queue = new SharedCodexQueue({ request: f.request }, 'thread', join(f.dir, 'handoff.json'), f.consumed, f.uncertain, undefined, requeued, undefined, handoff);
        await queue.load();
        const input = [{ type: 'text', text: 'public handoff' }];
        f.request.mockResolvedValueOnce({ queuedSubmission: { id: 'native', clientUserMessageId: 'web', input } });
        await queue.enqueue('web', input); await queue.reconcile();
        expect(queue.state('web')).toBe('dispatching'); expect(handoff).toHaveBeenCalledWith(['web']);
        expect(f.uncertain).not.toHaveBeenCalled(); expect(f.consumed).not.toHaveBeenCalled();
        await queue.enqueue('web', input);
        expect(f.request.mock.calls.filter(([method]) => method === 'thread/queue/add')).toHaveLength(1);
        f.request.mockResolvedValueOnce({ data: [{ id: 'native', clientUserMessageId: 'web', input }] });
        await queue.reconcile(); expect(queue.state('web')).toBe('queued'); expect(requeued).toHaveBeenCalledWith(['web']);
        await queue.reconcile(); await queue.acceptedItem('item/started', item('web'));
        await queue.transportLost(); await queue.reconcile();
        expect(queue.state('web')).toBe('consumed'); expect(f.uncertain).not.toHaveBeenCalled();
    });
    it('accepts only matching root user identities, then replays proof on reconnect', async () => {
        const f = await fixture();
        await f.queue.acceptedItem('item/started', item('native-client'));
        expect(f.queue.state('native-client')).toBe('consumed');
        await f.queue.acceptedItem('item/completed', item('other-client', 'child'));
        await f.queue.acceptedItem('item/completed', { ...item('other-client'), item: { type: 'agentMessage', id: 'a', clientId: 'other-client' } });
        expect(f.queue.state('other-client')).toBeUndefined();
        const restarted = new SharedCodexQueue({ request: f.request }, 'thread', join(f.dir, 'ledger.json'), f.consumed, f.uncertain);
        await restarted.load(); f.consumed.mockClear(); restarted.replay();
        expect(f.consumed).toHaveBeenCalledWith(['native-client']);
    });

    it('retires a removed queue projection without claiming acceptance, including empty reconnect snapshot', async () => {
        const f = await fixture();
        const queued = { id: 'native-submission', clientUserMessageId: 'native-client', input: [{ type: 'text', text: 'same text' }] };
        f.request.mockResolvedValueOnce({ data: [queued] }); await f.queue.reconcile();
        expect(f.snapshot).toHaveBeenLastCalledWith([queued]);
        await f.queue.reconcile();
        expect(f.snapshot).toHaveBeenLastCalledWith([]);
        expect(f.queue.state('native-client')).toBe('dispatching');
        expect(f.consumed).not.toHaveBeenCalled();
        // A live dequeue is a handoff, not evidence of transport failure.
        expect(f.uncertain).not.toHaveBeenCalled();
        await f.queue.transportLost();
        expect(f.queue.state('native-client')).toBe('unknown');
        expect(f.uncertain).toHaveBeenCalledWith(['native-client']);
        const restarted = new SharedCodexQueue({ request: f.request }, 'thread', join(f.dir, 'ledger.json'), f.consumed, f.uncertain, undefined, undefined, f.snapshot);
        await restarted.load(); await restarted.reconcile();
        expect(f.snapshot).toHaveBeenLastCalledWith([]);
        expect(f.consumed).not.toHaveBeenCalled();
    });

    it('does not publish a partial snapshot or resurrect an accepted item from a stale in-flight list', async () => {
        const f = await fixture();
        f.request.mockResolvedValueOnce({ data: [], nextCursor: 'more' }).mockRejectedValueOnce(new Error('lost page'));
        await expect(f.queue.reconcile()).rejects.toThrow('lost page');
        expect(f.snapshot).not.toHaveBeenCalled();
        f.request.mockImplementationOnce(async () => {
            await f.queue.acceptedItem('item/started', item('accepted'));
            return { data: [{ id: 'n', clientUserMessageId: 'accepted', input: [] }] };
        });
        await f.queue.reconcile();
        expect(f.snapshot).toHaveBeenLastCalledWith([]);
        expect(f.queue.state('accepted')).toBe('consumed');
    });
});
