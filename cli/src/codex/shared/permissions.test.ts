import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import type { CodexAppServerClient } from '../codexAppServerClient';
import { SharedCodexPermissions } from './permissions';

function fixture() {
    let state: AgentState = {};
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const send = vi.fn();
    const session = { getMetadata: () => ({ codexSessionId: 'thread' }), sendAgentMessage: send,
        updateAgentState: (fn: (state: AgentState) => AgentState) => { state = fn(state); },
        rpcHandlerManager: { registerHandler: (key: string, fn: (raw: unknown) => Promise<unknown>) => handlers.set(key, fn) } } as unknown as ApiSessionClient;
    const respond = vi.fn();
    let yolo = false;
    const permissions = new SharedCodexPermissions(session, { respond } as unknown as CodexAppServerClient, 'generation', threadId => threadId === 'thread' && yolo);
    const request = { id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'call',
        questions: [{ id: 'choice', header: 'Choose', question: 'Which?', options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }] }] } };
    return { permissions, request, respond, handlers, send, state: () => state, setYolo: (value: boolean) => { yolo = value; permissions.settingsChanged('thread'); } };
}
describe('shared request arbitration', () => {
    const approval = (id: number, threadId = 'thread') => ({ id, method: 'item/commandExecution/requestApproval',
        params: { threadId, turnId: 'turn', itemId: `command-${id}`, command: 'printf probe' } });
    it('submits existing and later root tool approvals after confirmed YOLO, keeping native arbitration authoritative', async () => {
        const f = fixture();
        f.permissions.receive(approval(2));
        const id = Object.keys(f.state().requests!)[0]!;
        f.setYolo(true);
        f.setYolo(true);
        await vi.waitFor(() => expect(f.respond).toHaveBeenCalledExactlyOnceWith(2, { decision: 'accept' }));
        expect(f.state().requests?.[id]).toBeDefined();
        expect(f.state().completedRequests).toBeUndefined();
        await expect(f.handlers.get('permission')!({ id, approved: false })).rejects.toThrow('submitted');
        f.permissions.resolved('thread', 2);
        expect(f.state().completedRequests?.[id]?.status).toBe('resolved');
        f.permissions.receive(approval(3));
        await vi.waitFor(() => expect(f.respond).toHaveBeenLastCalledWith(3, { decision: 'accept' }));
        expect(Object.keys(f.state().requests!)).toHaveLength(0);
        f.setYolo(false);
        f.permissions.receive(approval(4));
        await Promise.resolve();
        expect(Object.keys(f.state().requests!)).toHaveLength(1);
        expect(f.respond).toHaveBeenCalledTimes(2);
    });
    it('leaves child approvals and root questions pending, including MCP forms', async () => {
        const f = fixture();
        f.permissions.receive(approval(2, 'child'));
        f.permissions.receive(f.request);
        f.permissions.receive({ id: 3, method: 'mcpServer/elicitation/request', params: {
            threadId: 'thread', turnId: 'turn', serverName: 'external', mode: 'form', message: 'Choose a value',
            requestedSchema: { type: 'object', properties: { choice: { type: 'string', enum: ['A', 'B'] } }, required: ['choice'] }
        } });
        f.setYolo(true);
        f.permissions.receive(approval(4, 'child'));
        await Promise.resolve();
        expect(f.respond).not.toHaveBeenCalled();
        expect(Object.keys(f.state().requests!)).toHaveLength(4);
    });
    it('never overwrites a submitted user decision or resurrects a natively resolved request on mode change', async () => {
        const f = fixture();
        f.permissions.receive(approval(2));
        const id = Object.keys(f.state().requests!)[0]!;
        await f.handlers.get('permission')!({ id, approved: false, decision: 'denied' });
        f.setYolo(true);
        await vi.waitFor(() => expect(f.respond).toHaveBeenCalledExactlyOnceWith(2, { decision: 'decline' }));
        f.permissions.resolved('thread', 2);
        f.permissions.receive(approval(3));
        f.permissions.resolved('thread', 3);
        await Promise.resolve(); await Promise.resolve();
        expect(f.respond).toHaveBeenCalledTimes(1);
    });
    it.each([{ notes: [] }, { notes: ['user_note: custom answer'] }])('preserves isOther and canonical other answers (%j) without claiming a winner', async ({ notes }) => {
        const f = fixture();
        const request = { ...f.request, params: { ...f.request.params, isBlocking: true,
            questions: f.request.params.questions.map(question => ({ ...question, isOther: true })) } };
        f.permissions.receive(request);
        const [id, pending] = Object.entries(f.state().requests ?? {})[0]!;
        expect(pending.arguments).toEqual(request.params);
        const answers = { choice: { answers: ['None of the above', ...notes] } };
        await f.handlers.get('permission')!({ id, approved: true, answers });
        await vi.waitFor(() => expect(f.respond).toHaveBeenCalledWith(1, { answers }));
        expect(f.state().completedRequests).toBeUndefined();
        f.permissions.resolved('thread', request.id);
        expect(f.state().completedRequests?.[id]).toMatchObject({ status: 'resolved' });
        expect(f.state().completedRequests?.[id]).not.toHaveProperty('answers');
    });

    it('withdrawal on disconnect is canceled, not a claim that a native answer won', () => {
        const f = fixture(); f.permissions.receive(f.request); f.permissions.close();
        expect(Object.values(f.state().completedRequests ?? {})[0]?.status).toBe('canceled');
        expect(f.respond).not.toHaveBeenCalled();
        expect(f.send).toHaveBeenLastCalledWith(expect.objectContaining({
            type: 'tool-call-result', callId: 'call', output: { status: 'canceled' }, is_error: false
        }), 'codex:thread:question:call:canceled');
    });
    it('native resolution in the same tick cannot resurrect a prompt or submit a late answer', async () => {
        const f = fixture(); f.permissions.receive(f.request); f.permissions.resolved('thread', 1);
        await Promise.resolve(); await Promise.resolve();
        expect(Object.keys(f.state().requests ?? {})).toHaveLength(0);
        expect(Object.values(f.state().completedRequests ?? {})[0]?.status).toBe('resolved');
        expect(f.respond).not.toHaveBeenCalled();
        f.permissions.receive(f.request); expect(Object.keys(f.state().requests ?? {})).toHaveLength(0);
        expect(f.send.mock.calls).toEqual([
            [{ type: 'tool-call', name: 'request_user_input', callId: 'call', input: f.request.params,
                id: 'codex:thread:question:call:start' }, 'codex:thread:question:call:start'],
            [{ type: 'tool-call-result', callId: 'call', output: { status: 'resolved' }, is_error: false,
                id: 'codex:thread:question:call:resolved' }, 'codex:thread:question:call:resolved']
        ]);
    });
    it('validates all answers before submitting; sending is not proof of winning', async () => {
        const f = fixture(); f.permissions.receive(f.request);
        const id = Object.keys(f.state().requests ?? {})[0]; const reply = f.handlers.get('permission')!;
        await expect(reply({ id, approved: true, answers: {} })).rejects.toThrow('Missing answer');
        await reply({ id, approved: true, answers: { choice: ['B'] } });
        await vi.waitFor(() => expect(f.respond).toHaveBeenCalledWith(1, { answers: { choice: { answers: ['B'] } } }));
        expect(f.state().completedRequests).toBeUndefined();
        expect(f.send).toHaveBeenCalledTimes(1); // Submission alone is not a result.
        f.permissions.resolved('thread', 1);
        expect(Object.values(f.state().completedRequests ?? {})[0]).toMatchObject({ status: 'resolved' });
        expect(Object.values(f.state().completedRequests ?? {})[0]).not.toHaveProperty('answers');
    });
    it('keeps child questions in their agent trace and replay IDs stable across reconnects', () => {
        const f = fixture();
        const request = { ...f.request, params: { ...f.request.params, threadId: 'child' } };
        f.permissions.receive(request); f.permissions.resolved('child', request.id);
        expect(f.send.mock.calls[0][0]).toMatchObject({ type: 'agent-run-trace', agentId: 'child',
            message: { type: 'tool-call', name: 'request_user_input', callId: 'call' },
            scope: { role: 'child', parentThreadId: 'thread' } });
        const again = fixture(); again.permissions.receive(request); again.permissions.resolved('child', request.id);
        expect(again.send.mock.calls).toEqual(f.send.mock.calls);
    });
    it('ignores unsupported requests, including requests for an unknown MCP elicitation form', async () => {
        const f = fixture();
        f.permissions.receive({ id: 2, method: 'future/request', params: { threadId: 'thread' } });
        await Promise.resolve(); expect(f.respond).not.toHaveBeenCalled();
    });
});
