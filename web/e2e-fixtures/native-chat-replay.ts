import type { DecryptedMessage } from '../src/types/api'
import type { NativeExecution } from '@hapi/protocol/nativeExecution'

export type NativeReplayStatus = 'inProgress' | 'completed' | 'interrupted' | 'failed' | 'unknown' | 'no-answer'
export type NativeReplay = { apply: (status: NativeReplayStatus, text?: string) => void }
declare global { interface Window { __nativeReplay: NativeReplay } }

/** A source-fact replay. No native process, model request, or second database. */
export const nativeReplayQuestion = { questions: [{ id: 'review', header: 'Review', question: 'Which change should be applied?', options: [
    { label: 'Proceed', description: 'Apply the reviewed change.' }, { label: 'Hold', description: 'Keep the current version.' },
] }] }

export function nativeReplayRows(start: number, state: NativeReplayStatus, text?: string, question = false): DecryptedMessage[] {
    const status = state === 'unknown' || state === 'no-answer' ? 'completed' : state
    const scope = { threadId: 'fixture-native-thread', turnId: 'fixture-native-turn' }
    const turn = { status, started: true, ended: status !== 'inProgress' }
    const rows = Array.from({ length: 20 }, (_, offset) => {
        const seq = start + offset
        return { id: `m-${seq}`, seq, localId: null, createdAt: 1_700_000_000_000 + seq,
            invokedAt: 1_700_000_000_000 + start,
            content: { role: 'agent', content: { type: 'output', data: { isMeta: true } } },
        } as DecryptedMessage
    })
    const agent = (offset: number, itemId: string, body: object, phase?: NativeExecution['phase']) => {
        rows[offset].content = { role: 'agent', meta: { nativeExecution: { ...scope, turn, itemId, phase } },
            content: { type: 'codex', data: { id: `codex:${scope.threadId}:${scope.turnId}:${itemId}:${offset}`, ...body } } }
    }
    rows[0].content = { role: 'user', content: { type: 'text', text: 'Review the native chat upgrade.' },
        meta: { nativeExecution: { ...scope, turn, itemId: 'request' } } }
    agent(1, 'commentary', { type: 'message', message: 'Checking the affected files.' }, state === 'unknown' ? undefined : 'commentary')
    agent(2, 'tool-a', { type: 'tool-call', name: question ? 'request_user_input' : 'CodexBash', callId: 'native-tool-a', input: question ? nativeReplayQuestion : { command: 'git status --short' } })
    if (!question) agent(3, 'tool-a', { type: 'tool-call-result', callId: 'native-tool-a', output: { stdout: 'working tree inspected' } })
    agent(4, 'reasoning', { type: 'reasoning', message: 'Check native identity before settling the answer.' })
    agent(5, 'tool-b', { type: 'tool-call', name: 'CodexBash', callId: 'native-tool-b', input: { command: 'bun typecheck' } })
    agent(6, 'tool-b', { type: 'tool-call-result', callId: 'native-tool-b', output: { stdout: 'types checked' } })
    if (state !== 'no-answer' && state !== 'interrupted' && state !== 'failed') agent(7, 'answer', {
        type: 'message', streamSnapshot: true,
        message: text ?? (state === 'inProgress' ? 'The review is underway.' : 'The native chat upgrade is ready for verification.'),
    }, state === 'unknown' ? undefined : 'final_answer')
    if (state === 'failed') agent(8, 'failure', { type: 'error', message: 'Codex error: replayed upstream rejection' })
    if (state === 'interrupted') rows[8].content = { role: 'agent', meta: { nativeExecution: { ...scope, turn } },
        content: { type: 'event', id: 'native-stop', data: { type: 'message', message: 'Aborted by user' } } }
    agent(19, 'lifecycle', { type: 'native-turn' })
    return rows
}
