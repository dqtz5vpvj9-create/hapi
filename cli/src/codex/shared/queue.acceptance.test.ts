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
        expect(f.queue.state('native-client')).toBe('unknown');
        expect(f.consumed).not.toHaveBeenCalled();
        // No item identity proof means a HAPI-origin dispatch remains unknown.
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
