import { describe, expect, it, vi } from 'vitest';
import type { CodexAppServerClient } from '../codexAppServerClient';
import { listLoadedNativeThreads, requireLoadedNativeThread } from './nativeDiscovery';

describe('native attachment ownership', () => {
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
