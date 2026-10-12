import type { HTMLAttributes } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '@/api/client'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { createForkNavigator } from '@/lib/fork-navigation'
import { I18nProvider } from '@/lib/i18n-context'
import { HappyUserMessage } from './UserMessage'

const nativeBoundary = { threadId: 'root-thread', turnId: 'first-turn', itemId: 'first-input' }
const auiState = {
    message: {
        id: 'user-text:first-input', role: 'user', createdAt: new Date(100),
        content: [{ type: 'text', text: 'First question' }],
        metadata: { custom: {} as Partial<HappyChatMessageMetadata> },
    },
    thread: { isRunning: false, messages: [] },
}

vi.mock('@assistant-ui/react', () => ({
    useAuiState: (selector: (state: typeof auiState) => unknown) => selector(auiState),
    MessagePrimitive: { Root: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div> },
}))

vi.mock('@/components/LazyRainbowText', () => ({
    LazyRainbowText: ({ text }: { text: string }) => <span>{text}</span>,
}))

const fetchMock = vi.fn()
const navigate = vi.fn(async () => {})

function renderUser(options: {
    custom?: Partial<HappyChatMessageMetadata>
    latest?: boolean
    metadata?: HappyChatContextValue['metadata']
    disabled?: boolean
} = {}) {
    auiState.message.metadata.custom = {
        kind: 'user', status: 'sent', localId: null,
        nativeNode: { kind: 'user-text', execution: nativeBoundary },
        ...options.custom,
    }
    const api = new ApiClient('test-token')
    const context: HappyChatContextValue = {
        api, sessionId: 'root-session', disabled: options.disabled ?? false,
        metadata: options.metadata === undefined ? {
            path: '/workspace', host: 'machine', flavor: 'codex', codexSessionId: 'root-thread',
            capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } },
        } : options.metadata,
        terminalToolDisplayMode: 'compact', showSessionSummaryInChat: false,
        onRefresh: () => {}, hasMoreMessages: false, isSyncingTail: false, isLoadingMoreMessages: false,
        loadOlderMessagesPreservingScroll: async () => 'terminal-stop',
        isLatestCompletedBoundary: () => options.latest === true,
        onForkConversation: createForkNavigator(boundary => api.forkConversation('root-session', boundary), navigate),
        onRewindConversation: async localId => { await api.rewindConversation('root-session', localId) },
    }
    return render(<I18nProvider><HappyChatProvider value={context}><HappyUserMessage /></HappyChatProvider></I18nProvider>)
}

async function confirmFork() {
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Fork' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
}

describe('user message history actions', () => {
    beforeEach(() => {
        localStorage.clear()
        fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ sessionId: 'child-session' }), { status: 200 }))
        navigate.mockClear()
        vi.stubGlobal('fetch', fetchMock)
        auiState.thread.isRunning = false
    })
    afterEach(() => vi.unstubAllGlobals())

    it('forks the first native input without a localId or managed history point after confirmation', async () => {
        renderUser()
        expect(screen.queryByRole('button', { name: 'Rewind' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Fork' }))
        expect(fetchMock).not.toHaveBeenCalled()
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
        expect(fetchMock).not.toHaveBeenCalled()
        await confirmFork()
        expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/root-session/fork')
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ nativeBoundary })
        await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith('child-session'))
    })

    it('preserves current fork as an empty request', async () => {
        renderUser({ latest: true })
        await confirmFork()
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({})
    })

    it('preserves current fork for a latest steered input without selecting a historical boundary', async () => {
        renderUser({ custom: { steered: true }, latest: true })
        await confirmFork()
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({})
    })

    it('preserves managed historical fork and rewind affordances', async () => {
        renderUser({
            custom: { nativeNode: undefined, localId: 'managed-local' },
            metadata: {
                path: '/workspace', host: 'machine',
                capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } },
                conversationHistoryPoints: { 'managed-local': true },
            },
        })
        expect(screen.getByRole('button', { name: 'Rewind' })).toBeTruthy()
        await confirmFork()
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ messageLocalId: 'managed-local' })
    })

    it('preserves managed current fork without a historical point', async () => {
        renderUser({ custom: { nativeNode: undefined }, latest: true })
        await confirmFork()
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({})
    })

    it.each([
        { status: 'queued' }, { status: 'sending' }, { status: 'failed' }, { steered: true },
        { nativeNode: { kind: 'user-text' } },
        { nativeNode: { kind: 'user-text', execution: { ...nativeBoundary, threadId: 'child-thread' } } },
        { nativeNode: { kind: 'user-text', execution: { ...nativeBoundary, turnId: '' } } },
        { nativeNode: { kind: 'user-text', execution: { ...nativeBoundary, itemId: undefined } } },
        { nativeNode: { kind: 'agent-text', execution: nativeBoundary } },
    ] satisfies Partial<HappyChatMessageMetadata>[])('hides historical native fork for ineligible input %j', custom => {
        renderUser({ custom, latest: false })
        expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('requires root identity and advertised capability', () => {
        renderUser({ metadata: { path: '/workspace', host: 'machine', capabilities: { conversationHistory: { forkAtMessage: true } } } })
        expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull()
    })

    it('keeps server rejection visible without navigating to a child', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Only the first user input in a native turn can be forked.' }), { status: 409 }))
        renderUser()
        await confirmFork()
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Only the first user input'))
        expect(navigate).not.toHaveBeenCalled()
    })
})
