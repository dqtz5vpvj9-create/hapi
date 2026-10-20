import { describe, expect, it, vi } from 'vitest'
import { act, render, renderHook, screen } from '@testing-library/react'
import { AssistantRuntimeProvider, ThreadPrimitive, getExternalStoreMessages } from '@assistant-ui/react'
import { projectSubagentBlocks } from './blocks'
import { useSubagentRuntime } from './useSubagentRuntime'
import type { SubagentRuntimeOptions } from './useSubagentRuntime'
import type { SubagentMessage } from './types'

const row = (overrides: Partial<SubagentMessage> & { id: string }): SubagentMessage => ({
    role: 'assistant', text: '', createdAt: 1, ...overrides,
})

function transcript(): SubagentMessage[] {
    return [
        row({ id: 'child:1', role: 'user', kind: 'message', text: 'Question', createdAt: 5 }),
        row({ id: 'child:2', role: 'assistant', kind: 'reasoning', text: 'Thinking', createdAt: 6 }),
        row({ id: 'child:3', role: 'assistant', kind: 'message', text: 'Answer', createdAt: 7 }),
        row({
            id: 'child:4', role: 'tool', kind: 'tool-call', callId: 'call-a', toolName: 'exec_command',
            input: { cmd: 'bun test' }, text: 'exec_command', createdAt: 8,
        }),
        row({ id: 'child:5', role: 'tool', kind: 'tool-result', callId: 'call-a', output: { stdout: 'ok' }, text: 'ok', createdAt: 9 }),
    ]
}

describe('useSubagentRuntime', () => {
    it('maps projected blocks onto thread messages and stays read-only without onSend', () => {
        const blocks = projectSubagentBlocks(transcript())
        const { result } = renderHook(() => useSubagentRuntime({ blocks }))
        const state = result.current.thread.getState()
        expect(state.messages.map(message => message.id)).toEqual([
            'user-text:child:1',
            'agent-reasoning:child:2',
            'agent-text:child:3',
            'tool-call:child:4',
        ])
        expect(state.messages.map(message => message.role)).toEqual(['user', 'assistant', 'assistant', 'assistant'])
        expect(state.messages[0].content).toMatchObject([{ type: 'text', text: 'Question' }])
        expect(state.messages[1].content).toMatchObject([{ type: 'reasoning', text: 'Thinking' }])
        expect(state.messages[2].content).toMatchObject([{ type: 'text', text: 'Answer' }])
        expect(state.messages[3].content).toMatchObject([
            { type: 'tool-call', toolName: 'CodexBash', result: { stdout: 'ok' }, isError: false, artifact: blocks[3] },
        ])
        expect(getExternalStoreMessages(state.messages[3])).toEqual([blocks[3]])
        expect(state.isDisabled).toBe(true)
        expect(state.isRunning).toBe(false)
        expect(state.messages.at(-1)?.status).toEqual({ type: 'complete', reason: 'unknown' })
    })

    it('renders the same thread surface when running and marks the live tail', () => {
        const blocks = projectSubagentBlocks([row({ id: 'child:1', role: 'assistant', kind: 'message', text: 'Working', createdAt: 5 })])
        const { result } = renderHook(() => useSubagentRuntime({ blocks, running: true }))
        const state = result.current.thread.getState()
        expect(state.isRunning).toBe(true)
        expect(state.messages.at(-1)?.status).toEqual({ type: 'running' })
        expect(state.isDisabled).toBe(true)
    })

    it('enables input and forwards text from onNew when onSend is provided', async () => {
        const onSend = vi.fn(async () => {})
        const blocks = projectSubagentBlocks([row({ id: 'child:1', role: 'user', text: 'Question', createdAt: 5 })])
        const { result } = renderHook(() => useSubagentRuntime({ blocks, onSend }))
        expect(result.current.thread.getState().isDisabled).toBe(false)
        act(() => result.current.thread.composer.setText('Follow up'))
        await act(async () => result.current.thread.composer.send())
        expect(onSend).toHaveBeenCalledExactlyOnceWith('Follow up')
        act(() => result.current.thread.composer.setText('   '))
        await act(async () => result.current.thread.composer.send())
        expect(onSend).toHaveBeenCalledTimes(1)
    })

    it('disables input while the child is running even with onSend', () => {
        const blocks = projectSubagentBlocks([row({ id: 'child:1', role: 'assistant', text: 'Working', createdAt: 5 })])
        const { result } = renderHook(() => useSubagentRuntime({ blocks, running: true, onSend: () => {} }))
        expect(result.current.thread.getState().isDisabled).toBe(true)
    })

    it('mounts the assistant-ui thread primitives over the projected transcript', () => {
        // jsdom has no layout engine; assistant-ui Viewport observes its size.
        vi.stubGlobal('ResizeObserver', class {
            observe() {}
            unobserve() {}
            disconnect() {}
        })
        const blocks = projectSubagentBlocks(transcript())
        function Harness(props: SubagentRuntimeOptions) {
            const runtime = useSubagentRuntime(props)
            return (
                <AssistantRuntimeProvider runtime={runtime}>
                    <ThreadPrimitive.Root>
                        <ThreadPrimitive.Viewport>
                            <ThreadPrimitive.Messages>
                                {({ message }) => (
                                    <div data-testid={`row-${message.id}`} data-role={message.role} />
                                )}
                            </ThreadPrimitive.Messages>
                        </ThreadPrimitive.Viewport>
                    </ThreadPrimitive.Root>
                </AssistantRuntimeProvider>
            )
        }
        render(<Harness blocks={blocks} />)
        expect(screen.getByTestId('row-user-text:child:1')).toHaveAttribute('data-role', 'user')
        expect(screen.getByTestId('row-agent-reasoning:child:2')).toHaveAttribute('data-role', 'assistant')
        expect(screen.getByTestId('row-agent-text:child:3')).toHaveAttribute('data-role', 'assistant')
        expect(screen.getByTestId('row-tool-call:child:4')).toHaveAttribute('data-role', 'assistant')
    })
})
