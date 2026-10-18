import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { SharedCodexProjection } from './projection';

const item = { id: 'patch', type: 'fileChange', status: 'completed', changes: [
    { path: '/src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -40 +42 @@\n-old\n+new\n' },
    { path: '/docs/a.ts', kind: { type: 'add' }, diff: 'docs\n' }
] };

describe('shared file-change delivery', () => {
    it.each([undefined, 'root'])('retains final changes and deduplicates completion/reconnect for %s', async parent => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parent);
        const params = { threadId: 'thread', turnId: 'turn', item };
        await projection.notification('item/completed', params);
        await projection.notification('item/completed', params);
        const unwrap = (body: Record<string, unknown>): any => parent ? body.message : body;
        const bodies = send.mock.calls.map(([body]) => unwrap(body));
        expect(bodies).toHaveLength(2);
        expect(bodies[0]).toMatchObject({ type: 'tool-call', name: 'CodexPatch', callId: 'patch' });
        expect(bodies[1]).toMatchObject({ type: 'tool-call-result', callId: 'patch', is_error: false,
            output: { success: true, changes: Object.fromEntries(item.changes.map(change => [change.path, change])) } });
        const original = bodies.map(body => body.id);
        projection.reset(); send.mockClear();
        await projection.history({ turns: [{ id: 'turn', status: 'completed', items: [item] }] });
        const replay = send.mock.calls.map(([body]) => unwrap(body)).filter(body => body?.type?.startsWith('tool-call'));
        expect(replay.map(body => body.id)).toEqual(original);
        expect(replay[1].output.changes).toEqual(bodies[1].output.changes);
    });

    it('keeps failed patch status even when failure output is empty', async () => {
        const send = vi.fn();
        const projection = new SharedCodexProjection({ getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient, 'thread', async () => {});
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item: { ...item, status: 'failed' } });
        expect(send.mock.lastCall?.[0]).toMatchObject({ type: 'tool-call-result', is_error: true, output: { success: false } });
    });
});
