import { describe, expect, it } from 'vitest'
import { normalizeDecryptedMessage } from './normalize'
import { reduceChatBlocks } from './reducer'
import { buildVisibleChatBlocks } from './toolGroups'
import type { ChatBlock, NormalizedMessage } from './types'

function normalize(data: Record<string, unknown>, index: number, scope: 'root' | 'child'): NormalizedMessage {
    const message = normalizeDecryptedMessage({
        id: `command-result-fixture-${index}`,
        seq: index,
        localId: null,
        createdAt: 1_700_000_000_000 + index,
        content: {
            role: 'agent',
            content: {
                type: 'codex',
                data: scope === 'root' ? data : {
                    type: 'agent-run-trace',
                    agentId: 'child-thread',
                    cardId: 'child-card',
                    message: data
                }
            }
        }
    })
    if (!message) throw new Error('Expected a normalized command message')
    return message
}

function commandBlocks(messages: NormalizedMessage[], scope: 'root' | 'child'): ChatBlock[] {
    const { blocks } = reduceChatBlocks(messages, null)
    if (scope === 'root') return blocks
    expect(blocks).toHaveLength(1)
    const parent = blocks[0]
    if (parent.kind !== 'tool-call') throw new Error('Expected the child agent card')
    return parent.children
}

const results: {
    label: string
    output: unknown
    isError?: boolean
    expectedError: boolean
    toolName?: string
}[] = [
    { label: 'nonzero exit code', output: { type: 'exec_command_end', exit_code: 1, stdout: 'FAILED_OUTPUT' }, isError: false, expectedError: true },
    { label: 'negative exit code', output: { type: 'exec_command_end', exit_code: -9 }, expectedError: true },
    { label: 'failed native status', output: { type: 'exec_command_end', status: 'failed' }, expectedError: true },
    { label: 'declined native command', output: { type: 'exec_command_end', status: 'declined' }, expectedError: true },
    { label: 'explicit error with a zero exit code', output: { type: 'exec_command_end', exit_code: 0 }, isError: true, expectedError: true },
    { label: 'successful command', output: { type: 'exec_command_end', exit_code: 0, status: 'completed' }, expectedError: false },
    { label: 'malformed exit code', output: { type: 'exec_command_end', exit_code: '1' }, expectedError: false },
    { label: 'unrelated result fields', output: { exit_code: 1, status: 'failed' }, toolName: 'mcp__tests__report', expectedError: false },
    { label: 'unrelated structured result', output: { type: 'test_report', exit_code: 1, status: 'failed' }, toolName: 'mcp__tests__report', expectedError: false }
]

describe.each(['root', 'child'] as const)('%s Codex command result state', scope => {
    it.each(results)('preserves $label through normalization, reduction and grouping', ({ output, isError, expectedError, toolName }) => {
        const messages = [
            { type: 'tool-call', name: toolName ?? 'CodexBash', callId: 'command-1', input: { command: 'run-tests' } },
            { type: 'tool-call-result', callId: 'command-1', output, is_error: isError },
            { type: 'tool-call', name: 'CodexBash', callId: 'command-2', input: { command: 'pwd' } },
            { type: 'tool-call-result', callId: 'command-2', output: { type: 'exec_command_end', exit_code: 0, stdout: '/workspace' } }
        ].map((data, index) => normalize(data, index, scope))

        if (scope === 'root') {
            expect(messages[1]).toMatchObject({
                role: 'agent',
                content: [{ type: 'tool-result', content: output, is_error: expectedError }]
            })
        }
        const blocks = commandBlocks(messages, scope)
        expect(blocks).toHaveLength(2)
        expect(blocks[0]).toMatchObject({
            kind: 'tool-call',
            tool: { state: expectedError ? 'error' : 'completed', result: output }
        })
        expect(blocks[1]).toMatchObject({ kind: 'tool-call', tool: { state: 'completed' } })

        const visible = buildVisibleChatBlocks(blocks, { hasMoreMessages: false })
        expect(visible).toHaveLength(1)
        expect(visible[0]).toMatchObject({
            kind: 'tool-group',
            summary: { totalTools: 2, errorCount: expectedError ? 1 : 0, runningCount: 0, pendingCount: 0 }
        })
    })

    it('retains failure when the result arrives before its command invocation', () => {
        const messages = [
            { type: 'tool-call-result', callId: 'command-1', output: { type: 'exec_command_end', exit_code: 1 } },
            { type: 'tool-call', name: 'CodexBash', callId: 'command-1', input: { command: 'run-tests' } }
        ].map((data, index) => normalize(data, index, scope))

        expect(commandBlocks(messages, scope)).toEqual([
            expect.objectContaining({
                kind: 'tool-call',
                tool: expect.objectContaining({ name: 'CodexBash', state: 'error', result: { type: 'exec_command_end', exit_code: 1 } })
            })
        ])
    })
})
