import { describe, expect, it, vi } from 'vitest';
import type { CodexAppServerClient } from '../codexAppServerClient';
import { listLoadedNativeThreads, requireLoadedNativeThread, readResumableNativeRoot } from './nativeDiscovery';

describe('native attachment ownership', () => {
    it('rejects a loaded root without a rollout before it can be published', async () => {
        const request = vi.fn().mockResolvedValueOnce({ thread: { id: 'empty', cwd: '/home/chris' } })
            .mockRejectedValueOnce(new Error('no rollout found for thread id empty'));
        await expect(readResumableNativeRoot({ request }, 'empty')).rejects.toThrow('no rollout found');
        expect(request).toHaveBeenLastCalledWith('thread/resume', { threadId: 'empty', excludeTurns: true });
    });

    it('does not resume a child and returns metadata for a resumable root', async () => {
        const request = vi.fn().mockResolvedValueOnce({ thread: { id: 'child', parentThreadId: 'parent' } });
        await expect(readResumableNativeRoot({ request }, 'child')).rejects.toThrow('root Codex thread');
        expect(request).toHaveBeenCalledTimes(1);
        const thread = { id: 'root', name: 'Existing task', cwd: '/home/chris' };
        request.mockResolvedValueOnce({ thread }).mockResolvedValueOnce({ thread });
        await expect(readResumableNativeRoot({ request }, 'root')).resolves.toEqual(thread);
    });

    it('checks every loaded page and never resumes an unloaded thread', async () => {
        const request = vi.fn(async (_method: string, params: unknown) => (params as {cursor?: string}).cursor
            ? { data: ['last'], nextCursor: null } : { data: ['first'], nextCursor: 'second' });
        const client = { request } as unknown as CodexAppServerClient;
        expect([...await listLoadedNativeThreads(client)]).toEqual(['first', 'last']);
        await expect(requireLoadedNativeThread(client, 'last')).resolves.toBeUndefined();
        await expect(requireLoadedNativeThread(client, 'missing')).rejects.toThrow('refusing');
        expect(request.mock.calls.every(([method]) => method === 'thread/loaded/list')).toBe(true);
    });
});
