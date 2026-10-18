import { describe, expect, it } from 'vitest'
import { ResponsesReplay } from './responsesReplay'

const request = (prompt: string, outputs: unknown[] = []) => ({ model: 'mock-model', stream: true, tools: [{ type: 'function', name: 'exec_command' }], input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }, ...outputs] })
const title = () => ({ ...request('Generate a concise, single-line task title for this test.'), tools: [], text: { format: { type: 'json_schema', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } } } })

describe('finite Responses replay at the model boundary', () => {
    it('consumes the authored user/tool sequence and emits deterministic protocol events', () => {
        const steps = [
            { id: 'question', prompt: 'CHOOSE', reply: 'question' as const },
            { id: 'answer', prompt: 'CHOOSE', toolResult: { from: 'question', check: (output: string) => JSON.parse(output).choice === 'Web' } },
        ]
        const first = new ResponsesReplay(steps), second = new ResponsesReplay(steps)
        expect(first.respond(request('CHOOSE'))).toBe(second.respond(request('CHOOSE')))
        const answer = request('CHOOSE', [{ type: 'function_call_output', call_id: 'call_question', output: '{"choice":"Web"}' }])
        expect(first.respond(answer)).toBe(second.respond(answer))
        expect(() => first.assertConsumed()).not.toThrow()
        expect(first.receipt()).toEqual({ consumed: 2, expected: 2, auxiliaryTitles: 0, failures: [] })
    })
    it('rejects missing and extra calls even if a caller catches the immediate error', () => {
        const replay = new ResponsesReplay([{ id: 'once', prompt: 'ONCE' }])
        expect(() => replay.assertConsumed()).toThrow('Unused steps: ["once"]')
        replay.respond(request('ONCE'))
        expect(() => replay.respond(request('ONCE'))).toThrow('Unexpected extra model request')
        expect(() => replay.assertConsumed()).toThrow('Unexpected extra model request')
    })
    it('fails out-of-order user input without consuming a later matching response', () => {
        const replay = new ResponsesReplay([{ id: 'first', prompt: 'FIRST' }, { id: 'second', prompt: 'SECOND' }])
        expect(() => replay.respond(request('SECOND'))).toThrow('Replay first: unexpected user prompt')
        expect(replay.receipt().consumed).toBe(0)
        replay.respond(request('FIRST')); replay.respond(request('SECOND'))
        expect(() => replay.assertConsumed()).toThrow('unexpected user prompt')
    })
    it('rejects a result from another call and a result with the wrong answer', () => {
        for (const [callId, output] of [['call_elsewhere', 'Web'], ['call_question', 'Terminal']]) {
            const replay = new ResponsesReplay([{ id: 'answer', prompt: 'CHOOSE', toolResult: { from: 'question', check: output => output === 'Web' } }])
            expect(() => replay.respond(request('CHOOSE', [{ type: 'function_call_output', call_id: callId, output }]))).toThrow('incorrect tool result')
        }
    })
    it('accounts for bounded structured titles without masking missing agent work', () => {
        const replay = new ResponsesReplay([{ id: 'main', prompt: 'MAIN' }], 'mock-model', 1)
        expect(replay.respond(title())).toContain('Verify shared clients')
        expect(() => replay.assertConsumed()).toThrow('Unused steps: ["main"]')
        replay.respond(request('MAIN'))
        expect(() => replay.assertConsumed()).not.toThrow()
        expect(() => replay.respond(title())).toThrow('title response budget exceeded')
        const forged = new ResponsesReplay([{ id: 'main', prompt: 'MAIN' }])
        expect(() => forged.respond(request('Generate a concise, single-line task title for this test.'))).toThrow('unexpected user prompt')
    })
})
