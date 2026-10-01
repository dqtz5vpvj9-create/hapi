import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import type { Session } from '@/types/api'
import { useHappyRuntime } from './assistant-runtime'

function windowBlocks(start: number): VisibleChatBlock[] {
    return Array.from({ length: 40 }, (_, index) => ({
        kind: index % 2 === 0 ? 'user-text' : 'agent-text',
        id: `history-${start + index}`,
        localId: null,
        createdAt: start + index,
        text: `Historical report ${start + index}\n${'Readable report paragraph. '.repeat(100)}`,
    }))
}

describe('history reading window ownership', () => {
    it('releases exited history from the real runtime while preserving the composer across navigation', () => {
        const session = { id: 'window-ownership', active: true, thinking: false } as Session
        const onSendMessage = vi.fn()
        const onAbort = vi.fn(async () => {})
        const latest = windowBlocks(1000)
        const { result, rerender } = renderHook(({ blocks, version }) => useHappyRuntime({
            session, blocks, messagesVersion: version, historyVersion: version,
            isSending: false, onSendMessage, onAbort,
        }), { initialProps: { blocks: latest, version: 0 }, wrapper: StrictMode })

        act(() => result.current.thread.composer.setText('Keep this unsent draft while I read history'))
        for (const [version, start] of [900, 800, 700, 1000].entries()) {
            rerender({ blocks: windowBlocks(start), version: version + 1 })
            const visible = result.current.thread.getState().messages
            const retained = result.current.thread.export().messages
            expect(visible).toHaveLength(40)
            expect(retained.map(entry => entry.message.id).sort()).toEqual(visible.map(message => message.id).sort())
            expect(result.current.thread.composer.getState().text).toBe('Keep this unsent draft while I read history')
        }
        expect(onSendMessage).not.toHaveBeenCalled()
        expect(onAbort).not.toHaveBeenCalled()
    })

    it('keeps hydrated history complete during a live turn, then updates fresh output and clears a reset window', () => {
        const session = { id: 'window-live', active: true, thinking: false } as Session
        const blocks = windowBlocks(1000)
        const { result, rerender } = renderHook(({ blocks, isRunning }) => useHappyRuntime({
            session, blocks, messagesVersion: 1, historyVersion: 1,
            isSending: false, isRunning, onSendMessage: vi.fn(), onAbort: vi.fn(async () => {}),
        }), { initialProps: { blocks, isRunning: false }, wrapper: StrictMode })

        rerender({ blocks, isRunning: true })
        expect(result.current.thread.getState().messages.at(-1)?.status?.type).toBe('complete')
        const updated = windowBlocks(1000)
        const last = updated.at(-1)!
        if (last.kind !== 'agent-text') throw new Error('The fixture must end with an assistant report')
        last.text += '\nNew live output'
        rerender({ blocks: updated, isRunning: true })
        expect(result.current.thread.getState().messages.at(-1)?.status?.type).toBe('running')
        expect(result.current.thread.export().messages).toHaveLength(40)
        rerender({ blocks: [], isRunning: false })
        expect(result.current.thread.getState().messages).toHaveLength(0)
        expect(result.current.thread.export().messages).toHaveLength(0)
    })
})
