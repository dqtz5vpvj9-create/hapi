import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import { SharedCodexAsyncQuestions } from './asyncQuestions';
import { SharedCodexPermissions } from './permissions';
import type { CodexAppServerClient } from '../codexAppServerClient';

function fixture() {
    let state: AgentState = {};
    const send = vi.fn(); const submit = vi.fn(async (_id: string, _text: string) => {});
    const handlers = new Map<string, (raw: unknown) => Promise<unknown>>();
    const nativeRequest = vi.fn();
    const session = { sendAgentMessage: send, updateAgentState: (fn: (state: AgentState) => AgentState) => { state = fn(state); },
        rpcHandlerManager: { registerHandler: (key: string, fn: (raw: unknown) => Promise<unknown>) => handlers.set(key, fn) }
    } as unknown as ApiSessionClient;
    const questions = new SharedCodexAsyncQuestions(session, 'thread', submit);
    new SharedCodexPermissions(session, { request: nativeRequest } as unknown as CodexAppServerClient, 'generation',
        () => false, reply => questions.reply(reply));
    questions.setTurn('turn');
    const item = { type: 'agentMessage', id: 'call', questions: [{ title: 'Which?', options: ['A', 'B'] }] };
    return { questions, item, submit, send, handlers, nativeRequest, state: () => state };
}
describe('native async questions', () => {
    it('restores native questions, submits the native reply envelope, and waits for transcript acceptance', async () => {
        const f = fixture(); f.questions.observe(f.item, 'turn'); f.questions.observe(f.item, 'turn');
        const [id, request] = Object.entries(f.state().requests!)[0]!;
        const questionId = JSON.stringify(['request_user_input_async', 'call', 0]);
        expect(request.arguments).toEqual({ canSkip: true, questions: [{ id: questionId, question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] });
        expect(f.send).toHaveBeenCalledTimes(1);
        await expect(f.questions.reply({ id, approved: true, answers: {} })).rejects.toThrow('Missing answer');
        await f.questions.reply({ id, approved: true, answers: { [questionId]: { answers: ['B'] } } });
        const text = f.submit.mock.calls[0]![1];
        expect(text).toBe(`<send_user_message_question_reply>\n${JSON.stringify([{ answer: 'B', question: 'Which?', questionItemId: questionId }])}\n</send_user_message_question_reply>`);
        expect(f.state().requests?.[id]).toBeDefined();
        f.questions.observe({ type: 'userMessage', content: [{ type: 'text', text }] }, 'turn');
        expect(f.state().requests?.[id]).toBeUndefined();
        expect(f.state().completedRequests?.[id]?.status).toBe('resolved');
        f.questions.observe(f.item, 'turn'); expect(Object.keys(f.state().requests!)).toHaveLength(0);
    });
    it('expires questions when their turn ends and ignores old-turn replay', () => {
        const f = fixture();
        f.questions.observe(f.item, 'old-turn');
        expect(Object.keys(f.state().requests ?? {})).toHaveLength(0);
        f.questions.observe(f.item, 'turn');
        f.questions.setTurn(undefined);
        expect(Object.keys(f.state().requests ?? {})).toHaveLength(0);
        f.questions.setTurn('next-turn');
        f.questions.observe(f.item, 'turn');
        expect(Object.keys(f.state().requests ?? {})).toHaveLength(0);
    });
    it('supports free text and skips without interrupting the running turn', async () => {
        const f = fixture(); f.questions.observe({ ...f.item, questions: [{ title: 'Link?', options: null }] }, 'turn');
        const id = Object.keys(f.state().requests!)[0]!;
        await f.handlers.get('permission')!({ id, approved: false });
        expect(f.nativeRequest).not.toHaveBeenCalled();
        expect(f.submit).not.toHaveBeenCalled(); expect(f.state().completedRequests?.[id]?.status).toBe('canceled');
        f.questions.observe(f.item, 'turn');
        expect(Object.keys(f.state().requests!)).toHaveLength(0);
        // A subsequent question in the same running turn remains answerable.
        f.questions.observe({ ...f.item, id: 'next-call' }, 'turn');
        const nextId = Object.keys(f.state().requests!)[0]!;
        await f.questions.reply({ id: nextId, approved: true, answers: {
            [JSON.stringify(['request_user_input_async', 'next-call', 0])]: ['A']
        } });
        expect(f.submit).toHaveBeenCalledTimes(1);
    });
});
