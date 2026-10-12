import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { getExternalStoreMessages } from '@assistant-ui/react'
import type { NativeExecution } from '@hapi/protocol/nativeExecution'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import type { Session } from '@/types/api'
import type { ComposerSendIntent } from './messageDelivery'
import { useHappyRuntime } from './assistant-runtime'

const session = { id: 'native-preparation', active: true, thinking: false } as Session
const execution: NativeExecution = { threadId: 'thread', turnId: 'turn', itemId: 'answer', phase: 'final_answer' }
function blocks(): VisibleChatBlock[] {
    return [
        { kind: 'user-text', id: 'user', localId: 'local-user', text: 'Question', createdAt: 100, invokedAt: 90, steered: true,
            meta: { nativeExecution: { threadId: 'thread', turnId: 'turn', itemId: 'input' } } },
        { kind: 'agent-text', id: 'commentary', localId: null, text: 'Working', createdAt: 200,
            meta: { nativeExecution: { ...execution, itemId: 'commentary', phase: 'commentary' } } },
        { kind: 'agent-text', id: 'answer', localId: null, text: 'Answer', createdAt: 300,
            meta: { nativeExecution: execution } },
    ]
}

describe('native runtime preparation', () => {
    it('does not map legacy IDs or iterate joined metadata over native source blocks', () => {
        const source = blocks()
        const map = vi.fn(source.map.bind(source))
        const iterate = vi.fn(source[Symbol.iterator].bind(source))
        const observed = new Proxy(source, {
            get(target, key, receiver) {
                if (key === 'map') return map
                if (key === Symbol.iterator) return iterate
                return Reflect.get(target, key, receiver)
            },
        })
        const onSendMessage = vi.fn(), onAbort = vi.fn(async () => {})
        const { result, rerender } = renderHook(({ nativeNodes }) => useHappyRuntime({
            session, blocks: observed, nativePresentationBlocks: source, nativeNodes,
            messagesVersion: 1, historyVersion: 1, isSending: false, onSendMessage, onAbort,
        }), { initialProps: { nativeNodes: true } })
        const native = result.current.thread.getState().messages
        expect(native.map(message => message.id)).toEqual(['user-text:user', 'agent-text:commentary', 'agent-text:answer'])
        expect(native.map(message => message.createdAt.getTime())).toEqual([90, 200, 300])
        expect(native.map(message => message.content)).toMatchObject([
            [{ type: 'text', text: 'Question' }], [{ type: 'text', text: 'Working' }], [{ type: 'text', text: 'Answer' }],
        ])
        expect(native[0].metadata.custom).toMatchObject({ localId: 'local-user', steered: true,
            nativeNode: { kind: 'user-text', execution: { threadId: 'thread', turnId: 'turn', itemId: 'input' } } })
        expect(native[2].metadata.custom).toMatchObject({ nativeNode: { execution, kind: 'agent-text' } })
        expect(native[2].status).toEqual({ type: 'complete', reason: 'unknown' })
        expect(getExternalStoreMessages(native[2])).toEqual([source[2]])
        expect(map).not.toHaveBeenCalled()
        expect(iterate).not.toHaveBeenCalled()

        // Live mode switches still compute joined legacy IDs and timestamps.
        rerender({ nativeNodes: false })
        expect(map).toHaveBeenCalled()
        expect(iterate).toHaveBeenCalled()
        expect(result.current.thread.getState().messages.map(message => message.id))
            .toEqual(['user-text:user', 'agent-text:commentary'])
        expect(result.current.thread.getState().messages.at(-1)?.createdAt.getTime()).toBe(300)
        map.mockClear(); iterate.mockClear()
        rerender({ nativeNodes: true })
        expect(map).not.toHaveBeenCalled()
        expect(iterate).not.toHaveBeenCalled()
        expect(result.current.thread.getState().messages).toEqual(native)
    })

    it('retains message identities, native running status, repository and composer callbacks across a prepend', async () => {
        const source = blocks()
        const turnStates = new Map<string, NativeExecution['turn']>([['thread:turn', { status: 'inProgress', started: true, ended: false }]])
        const onSendMessage = vi.fn(), onAbort = vi.fn(async () => {})
        const pendingSendIntentRef = { current: 'queue' as ComposerSendIntent }
        const { result, rerender } = renderHook(({ source, version, turnStates }) => useHappyRuntime({
            session, blocks: source, nativeNodes: true, nativePresentationBlocks: source, nativeTurnStates: turnStates,
            messagesVersion: version, historyVersion: version, isSending: false, onSendMessage, onAbort,
            pendingSendIntentRef,
        }), { initialProps: { source, version: 1, turnStates } })
        const runtime = result.current, before = runtime.thread.getState().messages
        expect(before[1].status).toEqual({ type: 'complete', reason: 'unknown' })
        expect(before[2].status).toEqual({ type: 'running' })
        act(() => runtime.thread.composer.setText('Keep this draft'))
        const older: VisibleChatBlock = { kind: 'user-text', id: 'older', localId: null, text: 'Older', createdAt: 10 }
        rerender({ source: [older, ...source], version: 2, turnStates })
        expect(result.current).toBe(runtime)
        const after = runtime.thread.getState().messages
        expect(after.slice(1)).toEqual(before)
        after.slice(1).forEach((message, index) => expect(message).toBe(before[index]))
        expect(runtime.thread.export().messages.map(entry => entry.message.id).sort()).toEqual(after.map(message => message.id).sort())
        expect(runtime.thread.composer.getState().text).toBe('Keep this draft')
        await act(async () => runtime.thread.composer.send())
        expect(onSendMessage).toHaveBeenCalledExactlyOnceWith('Keep this draft', undefined, null, 'queue')
        expect(pendingSendIntentRef.current).toBe('default')
        act(() => runtime.thread.composer.setText('Next ordinary send'))
        await act(async () => runtime.thread.composer.send())
        expect(onSendMessage).toHaveBeenLastCalledWith('Next ordinary send', undefined, null, 'default')
        await act(async () => runtime.thread.cancelRun())
        expect(onAbort).toHaveBeenCalledOnce()
        const completed = new Map<string, NativeExecution['turn']>([['thread:turn', { status: 'completed', started: true, ended: true }]])
        rerender({ source, version: 3, turnStates: completed })
        expect(runtime.thread.getState().messages.at(-1)?.status).toEqual({ type: 'complete', reason: 'unknown' })
        expect(runtime.thread.export().messages).toHaveLength(3)
    })
})
