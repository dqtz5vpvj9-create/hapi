import { describe, expect, it } from 'vitest'
import type { SubagentMessage } from '@hapi/protocol/apiTypes'
import { projectSubagentBlocks } from './blocks'

const row = (overrides: Partial<SubagentMessage> & { id: string }): SubagentMessage => ({
    role: 'assistant', text: '', createdAt: 1, ...overrides,
})

const call = (id: string, callId: string, toolName = 'exec_command'): SubagentMessage => row({
    id, role: 'tool', kind: 'tool-call', callId, toolName,
    input: { cmd: 'bun test' }, text: toolName, createdAt: 1000,
})
const result = (id: string, callId: string, output: unknown = { stdout: 'ok' }, isError = false): SubagentMessage => row({
    id, role: 'tool', kind: 'tool-result', callId, output, text: typeof output === 'string' ? output : 'result', isError, createdAt: 2200,
})

describe('projectSubagentBlocks', () => {
    it('maps user text, assistant text and reasoning onto the root chat block vocabulary', () => {
        const blocks = projectSubagentBlocks([
            row({ id: 'child:1', role: 'user', kind: 'message', text: 'Please investigate', createdAt: 5 }),
            row({ id: 'child:2', role: 'assistant', kind: 'message', text: 'Looking into it', createdAt: 6 }),
            row({ id: 'child:3', role: 'assistant', kind: 'reasoning', text: 'thinking harder', createdAt: 7 }),
        ])
        expect(blocks).toMatchObject([
            { kind: 'user-text', id: 'child:1', localId: null, text: 'Please investigate', createdAt: 5, invokedAt: 5 },
            { kind: 'agent-text', id: 'child:2', localId: null, text: 'Looking into it', createdAt: 6 },
            { kind: 'agent-reasoning', id: 'child:3', localId: null, text: 'thinking harder', createdAt: 7 },
        ])
    })

    it('pairs tool calls with results by callId across page order and keeps source timing', () => {
        const blocks = projectSubagentBlocks([
            result('child:30', 'call-a'),
            call('child:10', 'call-a'),
            call('child:20', 'call-b'),
        ])
        expect(blocks).toHaveLength(2)
        expect(blocks[0]).toMatchObject({
            kind: 'tool-call', id: 'child:10',
            tool: {
                id: 'call-a', name: 'CodexBash', input: { cmd: 'bun test' }, result: { stdout: 'ok' },
                state: 'completed', createdAt: 1000, completedAt: 2200, execStartedAt: 1000, execCompletedAt: 2200,
            },
        })
        expect(blocks[1]).toMatchObject({ kind: 'tool-call', id: 'child:20', tool: { state: 'pending' } })
        expect((blocks[1] as { tool: { result?: unknown } }).tool.result).toBeUndefined()
    })

    it('marks failed results as errors, including command envelopes without an explicit flag', () => {
        const explicit = projectSubagentBlocks([call('child:10', 'a'), result('child:11', 'a', 'boom', true)])
        expect(explicit[0]).toMatchObject({ kind: 'tool-call', tool: { state: 'error', result: 'boom' } })
        const envelope = projectSubagentBlocks([
            call('child:10', 'a'),
            result('child:11', 'a', 'Exit code: 1\nOutput:\nfailed assertion'),
        ])
        expect(envelope[0]).toMatchObject({ kind: 'tool-call', tool: { state: 'error' } })
    })

    it('keeps orphan results as tool blocks instead of dropping output', () => {
        const blocks = projectSubagentBlocks([
            result('child:10', 'missing-call'),
            row({ id: 'child:20', role: 'tool', kind: 'tool-result', text: 'no call id', createdAt: 20 }),
        ])
        expect(blocks).toHaveLength(2)
        expect(blocks[0]).toMatchObject({
            kind: 'tool-call', id: 'child:10',
            tool: { id: 'missing-call', name: 'Tool', state: 'completed', result: { stdout: 'ok' } },
        })
        expect(blocks[1]).toMatchObject({ kind: 'tool-call', id: 'child:20', tool: { state: 'completed', result: 'no call id' } })
    })

    it('emits one block per native call id and never duplicates paired results', () => {
        const blocks = projectSubagentBlocks([
            call('child:10', 'a'),
            call('child:11', 'a'),
            result('child:12', 'a'),
            result('child:13', 'a'),
        ])
        expect(blocks).toHaveLength(1)
        expect(blocks[0]).toMatchObject({ kind: 'tool-call', id: 'child:10', tool: { state: 'completed' } })
    })

    it('degrades missing or unknown fields without inventing identity', () => {
        const blocks = projectSubagentBlocks([
            row({ id: 'child:1', role: 'assistant', kind: 'message', text: 'legacy text' }),
            row({ id: 'child:2', role: 'assistant', text: '' }),
            row({ id: 'child:3', role: 'tool', kind: 'tool-call', callId: 'call-c', input: 'raw input', text: 'raw input' }),
            row({ id: 'child:4', role: 'tool', kind: 'unknown-kind' as SubagentMessage['kind'], text: 'unknown record' }),
        ])
        expect(blocks).toMatchObject([
            { kind: 'agent-text', id: 'child:1', text: 'legacy text' },
            {
                kind: 'tool-call', id: 'child:3',
                tool: { id: 'call-c', name: 'Tool', state: 'pending', input: 'raw input', createdAt: 1 },
            },
            { kind: 'agent-text', id: 'child:4', text: 'unknown record' },
        ])
    })

    it('produces deterministic ids for the same transcript', () => {
        const messages = [row({ id: 'child:1', role: 'user', text: 'q' }), call('child:2', 'a'), result('child:3', 'a'), row({ id: 'child:4', role: 'assistant', kind: 'reasoning', text: 'r' })]
        const first = projectSubagentBlocks(messages)
        const second = projectSubagentBlocks(messages)
        expect(first.map(block => [block.kind, block.id])).toEqual(second.map(block => [block.kind, block.id]))
    })
})
