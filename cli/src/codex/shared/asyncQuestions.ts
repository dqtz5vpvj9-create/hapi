import type { ApiSessionClient } from '@/api/apiSession';
import { record, string } from './gateway';

type Answer = string[] | { answers: string[] };
type Question = { id: string; question: string; options: Array<{ label: string }> };

/** Async questions are transcript items; replies travel as native user messages. */
export class SharedCodexAsyncQuestions {
    private readonly pending = new Map<string, { questions: Question[]; submitting: boolean }>();
    private readonly answered = new Set<string>();
    private turnId?: string;
    constructor(private readonly session: ApiSessionClient, private readonly threadId: string,
        private readonly submit: (id: string, text: string, turnId: string) => Promise<void>) {}

    setTurn(turnId: string | undefined): void {
        if (this.turnId === turnId) return;
        this.turnId = turnId;
        for (const id of this.pending.keys()) this.complete(id, 'canceled');
    }

    observe(item: Record<string, unknown>, turnId: string | undefined): void {
        if (!turnId || turnId !== this.turnId) return;
        if (item.type === 'userMessage') {
            for (const part of Array.isArray(item.content) ? item.content : []) {
                const text = string(record(part).text);
                const match = text?.match(/<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>/);
                if (!match) continue;
                let replies: unknown;
                try { replies = JSON.parse(match[1]); } catch { continue; }
                if (!Array.isArray(replies)) continue;
                for (const reply of replies) {
                    const id = string(record(reply).questionItemId);
                    if (id) this.answered.add(id);
                }
            }
            for (const [id, request] of this.pending) {
                if (request.questions.every(question => this.answered.has(question.id))) this.complete(id);
            }
            return;
        }
        const callId = string(item.id);
        if (item.type !== 'agentMessage' || !callId || !Array.isArray(item.questions)) return;
        const questions = item.questions.flatMap((raw, index): Question[] => {
            const question = record(raw); const title = string(question.title);
            const id = JSON.stringify(['request_user_input_async', callId, index]);
            if (!title || this.answered.has(id)) return [];
            return [{ id, question: title, options: (Array.isArray(question.options) ? question.options : [])
                .filter((option): option is string => typeof option === 'string').map(label => ({ label })) }];
        });
        const id = `codex:${this.threadId}:async-question:${callId}`;
        if (!questions.length || this.pending.has(id)) return;
        this.pending.set(id, { questions, submitting: false });
        const input = { questions, canSkip: true };
        this.session.sendAgentMessage({ type: 'tool-call', name: 'request_user_input', callId: id, input, id }, id);
        this.session.updateAgentState(state => ({ ...state, requests: { ...state.requests,
            [id]: { tool: 'request_user_input', toolCallId: id, arguments: input, createdAt: Date.now() } } }));
    }

    async reply(reply: { id: string; approved: boolean; answers?: Record<string, Answer> }): Promise<boolean> {
        const request = this.pending.get(reply.id);
        const turnId = this.turnId;
        if (!request || !turnId) return false;
        if (request.submitting) throw new Error('Request already submitted');
        if (!reply.approved) {
            for (const question of request.questions) this.answered.add(question.id);
            this.complete(reply.id, 'canceled'); return true;
        }
        const replies = request.questions.map(question => {
            const value = reply.answers?.[question.id];
            if (!value) throw new Error(`Missing answer: ${question.id}`);
            const answers = Array.isArray(value) ? value : value.answers;
            return { answer: answers.filter(answer => answer !== 'None of the above').map(answer => answer.replace(/^user_note: /, '')).join('\n'), question: question.question, questionItemId: question.id };
        });
        request.submitting = true;
        try {
            await this.submit(reply.id, `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`, turnId);
        } catch (error) { request.submitting = false; throw error; }
        return true;
    }

    private complete(id: string, status: 'resolved' | 'canceled' = 'resolved'): void {
        this.pending.delete(id);
        this.session.updateAgentState(state => {
            const requests = { ...state.requests }; const prior = requests[id]; delete requests[id];
            return { ...state, requests, completedRequests: { ...state.completedRequests,
                ...(prior ? { [id]: { ...prior, status, completedAt: Date.now() } } : {}) } };
        });
        const resultId = `${id}:${status}`;
        this.session.sendAgentMessage({ type: 'tool-call-result', callId: id, output: { status }, is_error: false, id: resultId }, resultId);
    }
}
