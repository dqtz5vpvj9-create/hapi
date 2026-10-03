import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { SharedCodexProjection, inputText } from './projection';
import { codexPlanProposalId } from './plan';

describe('shared history projection', () => {
    it.each([undefined, 'root'])('retains a failed empty turn across reconnect as an error (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
        const turn = { id: 'failed-turn', status: 'failed', items: [], error: { message: 'Bad Request' } };
        await projection.notification('turn/completed', { threadId: 'thread', turn });
        const failure = send.mock.calls.find(([body]) => (parentThreadId ? body.message : body)?.type === 'error');
        expect(failure).toBeDefined();
        expect(parentThreadId ? failure![0].message : failure![0]).toMatchObject({ type: 'error', message: 'Codex error: Bad Request' });
        projection.reset();
        send.mockClear();
        await projection.history({ turns: [turn] });
        expect(send.mock.calls).toContainEqual(failure);
        const count = send.mock.calls.length;
        await projection.history({ turns: [turn] });
        expect(send).toHaveBeenCalledTimes(count);
    });
    it.each([undefined, 'root'])('persists proposals without approval and replays the same IDs (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
        const item = { id: 'plan', type: 'plan', text: '# Final plan' };
        const params = { threadId: 'thread', turnId: 'turn', item };
        await projection.notification('item/completed', { ...params, item: { id: 'before', type: 'agentMessage', text: 'Preface' } });
        await projection.notification('item/started', params);
        await projection.notification('item/plan/delta', { ...params, itemId: 'plan', delta: '# Provisional' });
        await projection.notification('item/completed', params);
        await projection.notification('item/completed', params);
        await projection.notification('item/completed', { ...params, item: { id: 'after', type: 'agentMessage', text: 'Postscript' } });
        expect(send).toHaveBeenCalledTimes(4);
        const bodies = send.mock.calls.map(([body]) => parentThreadId ? body.message : body);
        const callId = codexPlanProposalId('thread', 'turn', 'plan');
        expect(bodies).toEqual([
            expect.objectContaining({ type: 'message', message: 'Preface' }),
            expect.objectContaining({ type: 'tool-call', name: 'ExitPlanMode', callId, input: { plan: '# Final plan' } }),
            expect.objectContaining({ type: 'tool-call-result', callId, output: null }),
            expect.objectContaining({ type: 'message', message: 'Postscript' })
        ]);
        const original = send.mock.calls.slice(1, 3);
        projection.reset(); send.mockClear();
        await projection.history({ turns: [{ id: 'turn', status: 'completed', items: [item] }] });
        expect(send.mock.calls).toEqual(original);
    });

    it('waits for final proposal content after an active snapshot', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'plan', type: 'plan', text: 'partial' }] }] });
        expect(send).not.toHaveBeenCalled();
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'plan', type: 'plan', text: 'final' } });
        expect(send.mock.calls[0][0]).toMatchObject({ input: { plan: 'final' } });
        expect(send.mock.calls[1][0]).toMatchObject({ output: null });
    });

    it.each([undefined, 'root'])('emits canonical error flags for tools (parent: %s)', async parentThreadId => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, parentThreadId);
        for (const failed of [true, false]) {
            for (const type of ['mcpToolCall', 'collabAgentToolCall']) {
                const item = { id: `${type}-${failed}`, type, server: 'test', tool: 'spawnAgent',
                    status: failed ? 'failed' : 'completed', error: failed ? { message: 'failed' } : null,
                    result: { Ok: 'done' } };
                await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item });
                const body = send.mock.lastCall?.[0];
                const result = parentThreadId ? body.message : body;
                expect(result).toMatchObject({ type: 'tool-call-result', is_error: failed });
                expect(result).not.toHaveProperty('isError');
            }
        }
    });
    it('keeps each turn model through settings changes, reconnect replay and rerouting', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'old' } }, 'model-a');
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'new' } }, 'model-b');
        projection.reset();
        // A replayed start must not rewrite the executing model either.
        await projection.notification('turn/started', { threadId: 'thread', turn: { id: 'old' } }, 'model-b');
        const usage = async (turnId: string) => projection.notification('thread/tokenUsage/updated', {
            threadId: 'thread', turnId, tokenUsage: { last: { inputTokens: 12, outputTokens: 3 } }
        }, 'model-b');
        await usage('old');
        await projection.notification('model/rerouted', { threadId: 'thread', turnId: 'new', fromModel: 'model-b', toModel: 'model-c', reason: 'test' });
        await usage('new');
        const events = send.mock.calls.map(([body]) => body).filter(body => body.type === 'token_count');
        expect(events.map(body => body.model)).toEqual(['model-a', 'model-c']);
    });
    it('projects native image-only inputs and history tools as resource references', async () => {
        const user = vi.fn(); const send = vi.fn();
        const session = { getMetadata: () => ({}), updateMetadata: vi.fn(), sendUserMessage: user, sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {}, undefined, true);
        await projection.history({ turns: [{ id: 'turn', status: 'completed', items: [
            { id: 'user', type: 'userMessage', content: [{ type: 'image', url: 'data:image/png;base64,aGVsbG8=' }] },
            { id: 'image', type: 'imageGeneration', status: 'completed', savedPath: '/outside/chart.png' }
        ] }] });
        expect(user.mock.calls[0][0]).toBe('');
        expect(user.mock.calls[0][3][0]).toMatchObject({ type: 'artifact', artifact: { fileName: 'image-1' } });
        expect(send.mock.calls.find(([body]) => body.type === 'tool-call-result')?.[0]).toMatchObject({ output: { content: [{ type: 'artifact' }] } });
        expect(JSON.stringify(user.mock.calls)).not.toContain('aGVsbG8=');
    });

    it('keeps image-only native inputs visible without embedding data URLs', () => {
        expect(inputText([{ type: 'image', url: 'data:image/png;base64,large' }])).toBe('[Image]');
        expect(inputText([{ type: 'localImage', path: '/tmp/image.png' }])).toBe('[Image: /tmp/image.png]');
    });
    it('replays after hub reconnect using the same durable local id', async () => {
        const send = vi.fn(); const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        const snapshot = { turns: [{ id: 'turn', status: 'completed', items: [{ id: 'item', type: 'agentMessage', text: 'complete' }] }] };
        await projection.history(snapshot); projection.reset(); await projection.history(snapshot);
        expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
    });
    it('does not settle an active snapshot under the final message id', async () => {
        const send = vi.fn();
        const session = { getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'item', type: 'agentMessage', text: 'partial' }] }] });
        expect(send).not.toHaveBeenCalled();
        await projection.notification('item/completed', { threadId: 'thread', turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: 'complete' } });
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'message', message: 'complete' }), expect.any(String));
    });
    it('routes descendant answers into a scoped agent trace, not a root message', async () => {
        const send = vi.fn(); const user = vi.fn(); const committed = vi.fn(async () => {});
        const session = { getMetadata: () => ({}), sendAgentMessage: send, sendUserMessage: user } as unknown as ApiSessionClient;
        const projection = new SharedCodexProjection(session, 'child', committed, 'root');
        await projection.notification('item/completed', { threadId: 'child', turnId: 'turn', item: { id: 'item', type: 'agentMessage', text: 'child answer' } });
        expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent-run-trace', agentId: 'child', message: expect.objectContaining({ message: 'child answer' }) }), expect.any(String));
        await projection.notification('item/completed', { threadId: 'child', turnId: 'turn', item: { id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'child prompt' }], clientId: 'cid' } });
        expect(user).not.toHaveBeenCalled(); expect(committed).not.toHaveBeenCalled();
    });
});

describe('native assistant text streaming', () => {
    it.each([undefined, 'parent'])('streams before completion and settles the same identity (parent: %s)', async parent => {
        const send = vi.fn();
        const projection = new SharedCodexProjection({ getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient, 'thread', async () => {}, parent);
        const scope = { threadId: 'thread', turnId: 'turn', itemId: 'item' };
        await projection.notification('item/agentMessage/delta', { ...scope, delta: 'hello' });
        expect(send).toHaveBeenCalledTimes(1);
        const body = (n: number) => parent ? send.mock.calls[n][0].message : send.mock.calls[n][0];
        expect(body(0)).toMatchObject({ type: 'message', message: 'hello', streamSnapshot: true });
        await projection.notification('item/agentMessage/delta', { ...scope, delta: ' hello' });
        await projection.notification('item/completed', { ...scope, item: { id: 'item', type: 'agentMessage', text: 'hello hello!' } });
        expect(body(send.mock.calls.length - 1)).toMatchObject({ id: body(0).id, message: 'hello hello!' });
        const count = send.mock.calls.length;
        await projection.notification('item/agentMessage/delta', { ...scope, delta: 'late' });
        expect(send).toHaveBeenCalledTimes(count);
    });
    it('seeds a resumed partial item and preserves identical consecutive deltas', async () => {
        const send = vi.fn();
        const projection = new SharedCodexProjection({ getMetadata: () => ({}), sendAgentMessage: send } as unknown as ApiSessionClient, 'thread', async () => {});
        await projection.history({ turns: [{ id: 'turn', status: 'inProgress', items: [{ id: 'item', type: 'agentMessage', text: 'prefix ' }] }] });
        vi.spyOn(Date, 'now').mockReturnValue(1000);
        try {
            await projection.notification('item/agentMessage/delta', { turnId: 'turn', itemId: 'item', delta: 'ha' });
            vi.mocked(Date.now).mockReturnValue(1200);
            await projection.notification('item/agentMessage/delta', { turnId: 'turn', itemId: 'item', delta: 'ha' });
            expect(send.mock.lastCall?.[0].message).toBe('prefix haha');
        } finally { vi.restoreAllMocks(); }
    });
});
