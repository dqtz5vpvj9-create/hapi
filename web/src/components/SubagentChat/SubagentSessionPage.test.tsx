import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { Session, SessionMetadataSummary } from '@/types/api'
import { AppContextProvider } from '@/lib/app-context'
import { I18nProvider } from '@/lib/i18n-context'
import type { SubagentMessage } from '@hapi/protocol/apiTypes'
import { SubagentSessionPage } from './SubagentSessionPage'

const state = vi.hoisted(() => ({
    subagentId: 'session-ada',
    navigate: vi.fn(),
    session: null as unknown,
}))

vi.mock('@tanstack/react-router', async importOriginal => {
    const actual = await importOriginal<typeof import('@tanstack/react-router')>()
    return {
        ...actual,
        useParams: () => ({ sessionId: 'parent', subagentId: state.subagentId }),
        useNavigate: () => state.navigate,
    }
})

vi.mock('@/hooks/queries/useSession', () => ({
    useSession: () => ({ session: state.session, isLoading: false, error: null, notFound: false, refetch: vi.fn() }),
}))

const parentMetadata: SessionMetadataSummary = {
    path: '/project',
    host: 'machine',
    name: 'Main task',
    flavor: 'dsh',
    machineId: 'm',
    dshSubagents: [
        { sessionId: 'session-ada', name: 'Ada', mode: 'continuable', activity: 'running', teamStatus: 'running', provider: 'spawn', createdAt: 1, settledMs: 5000, openSince: Date.now() - 3000 },
        { sessionId: 'session-ops', label: 'ops one-shot', mode: 'one-shot', activity: 'inactive', createdAt: 2 },
        { sessionId: 'session-ext', label: 'external child', mode: 'external', activity: 'inactive', createdAt: 3 },
    ],
    codexSubagents: [{ threadId: 'thread-codex', parentThreadId: 'native-parent', nickname: 'Codex kid', status: 'unknown' }],
}

function message(overrides: Partial<SubagentMessage> & { id: string }): SubagentMessage {
    return {
        role: 'assistant',
        kind: 'message',
        text: '',
        createdAt: 0,
        ...overrides,
    } as SubagentMessage
}

const transcript: SubagentMessage[] = [
    message({ id: 'session-ada:1', role: 'user', text: 'Review the boundary change' }),
    message({ id: 'session-ada:2', role: 'assistant', text: 'Checked the boundary and the fallback path.' }),
    message({ id: 'session-ada:3', role: 'tool', kind: 'tool-call', callId: 'call-1', toolName: 'bash', input: { command: 'bun test' }, text: 'bash' }),
    message({ id: 'session-ada:4', role: 'tool', kind: 'tool-result', callId: 'call-1', text: 'all green', output: 'all green' }),
]

function makeApi(overrides: Partial<Record<keyof ApiClient, unknown>> = {}) {
    const api = {
        getAuthToken: () => 'auth',
        getDshSubagentMessages: vi.fn(async (parentSessionId: string, subagentId: string) => ({
            sessionId: subagentId,
            messages: transcript.map(row => ({ ...row, id: row.id.replace('session-ada', subagentId) })),
            before: null,
            hasMore: false,
            after: 4,
            epoch: 'epoch-1',
        })),
        getCodexSubagentMessages: vi.fn(async (_parentSessionId: string, threadId: string) => ({
            threadId,
            messages: [message({ id: `${threadId}:1`, role: 'assistant', text: 'Codex child transcript.' })],
            before: null,
            hasMore: false,
            after: 1,
            epoch: 'epoch-codex',
        })),
        promptDshSubagent: vi.fn(async () => ({ messageId: 'pending-1' })),
        interruptDshSubagent: vi.fn(async () => ({ accepted: true })),
        ...overrides,
    } as unknown as ApiClient
    return api
}

function renderPage(api: ApiClient) {
    return render(
        <AppContextProvider value={{ api, token: 'token', baseUrl: '' }}>
            <I18nProvider>
                <SubagentSessionPage />
            </I18nProvider>
        </AppContextProvider>,
    )
}

beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
        observe() {}
        unobserve() {}
        disconnect() {}
    })
    // jsdom has no smooth scrolling; the assistant-ui viewport calls scrollTo.
    Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo
    Element.prototype.scrollIntoView = vi.fn()
    state.subagentId = 'session-ada'
    state.navigate = vi.fn()
    state.session = { id: 'parent', metadata: parentMetadata } as unknown as Session
})

afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
})

async function flushAsync() {
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

describe('SubagentSessionPage', () => {
    it('renders the shared assistant-ui thread with header badges, transcript and back navigation', async () => {
        const api = makeApi()
        renderPage(api)

        await screen.findByText('Review the boundary change')
        await screen.findByText('Checked the boundary and the fallback path.', { exact: false })
        expect(screen.getByText('Main task')).toBeTruthy()
        expect(screen.getByText('Ada')).toBeTruthy()
        expect(screen.getByText('DSH')).toBeTruthy()
        expect(screen.getByText('Continuable')).toBeTruthy()
        expect(screen.getByText('Running')).toBeTruthy()
        expect(document.querySelector('[data-subagent-duration]')?.textContent).toContain('Duration')
        expect(document.querySelector('[data-subagent-conversation]')?.getAttribute('data-subagent-flavor')).toBe('dsh')
        // Shared tool card surface, not a bespoke transcript renderer.
        await waitFor(() => expect(document.querySelector('[data-hapi-tool-state="completed"]')).toBeTruthy())

        fireEvent.click(screen.getByRole('button', { name: 'Back to session' }))
        expect(state.navigate).toHaveBeenCalledWith(expect.objectContaining({
            to: '/sessions/$sessionId',
            params: { sessionId: 'parent' },
        }))
        expect(api.getDshSubagentMessages).toHaveBeenCalledWith('parent', 'session-ada', expect.anything())
    })

    it('renders the composer only for a continuable DSH child and forwards queue/steer delivery', async () => {
        const api = makeApi()
        renderPage(api)

        const textarea = await screen.findByPlaceholderText('Message this subagent…')
        fireEvent.change(textarea, { target: { value: 'Take a look at the diff' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        await waitFor(() => expect(api.promptDshSubagent).toHaveBeenCalledWith('parent', 'session-ada', expect.objectContaining({
            text: 'Take a look at the diff',
            delivery: 'queue',
            requestId: expect.any(String),
        })))
        expect((textarea as HTMLTextAreaElement).value).toBe('')

        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'steer' } })
        fireEvent.change(textarea, { target: { value: 'Interrupt and do this instead' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send' }))
        await waitFor(() => expect(api.promptDshSubagent).toHaveBeenLastCalledWith('parent', 'session-ada', expect.objectContaining({
            text: 'Interrupt and do this instead',
            delivery: 'steer',
        })))
    })

    it('shows Stop while the child runs and interrupts it', async () => {
        const api = makeApi()
        renderPage(api)
        await screen.findByText('Review the boundary change')
        fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
        await waitFor(() => expect(api.interruptDshSubagent).toHaveBeenCalledWith('parent', 'session-ada'))
    })

    it('shows a read-only notice instead of the composer for one-shot children', async () => {
        state.subagentId = 'session-ops'
        const api = makeApi()
        renderPage(api)
        await screen.findByText('Review the boundary change')
        expect(screen.queryByPlaceholderText('Message this subagent…')).toBeNull()
        expect(screen.getByText('This subagent accepts no further input; the transcript is read-only.')).toBeTruthy()
    })

    it('shows the external notice without reading a transcript', async () => {
        state.subagentId = 'session-ext'
        const api = makeApi()
        renderPage(api)
        expect(await screen.findByText('External subagents keep no local transcript in DSH, so only the catalog entry is available.')).toBeTruthy()
        expect(screen.queryByPlaceholderText('Message this subagent…')).toBeNull()
        expect(api.getDshSubagentMessages).not.toHaveBeenCalled()
    })

    it('opens a Codex native child through the same view in read-only mode', async () => {
        state.subagentId = 'thread-codex'
        const api = makeApi()
        renderPage(api)
        expect(await screen.findByText('Codex child transcript.')).toBeTruthy()
        expect(api.getCodexSubagentMessages).toHaveBeenCalledWith('parent', 'thread-codex', expect.anything())
        expect(api.getDshSubagentMessages).not.toHaveBeenCalled()
        expect(screen.getByText('Codex')).toBeTruthy()
        expect(screen.getByText('Native Codex subagent history is read-only. Continue the conversation from its parent session.')).toBeTruthy()
        expect(screen.queryByPlaceholderText('Message this subagent…')).toBeNull()
    })

    it('renders a returnable error state when the child is no longer listed', async () => {
        state.subagentId = 'session-missing'
        const api = makeApi()
        renderPage(api)
        expect(await screen.findByText('Subagent not found')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: 'Back to session' }))
        expect(state.navigate).toHaveBeenCalledWith(expect.objectContaining({
            to: '/sessions/$sessionId',
            params: { sessionId: 'parent' },
        }))
        expect(api.getDshSubagentMessages).not.toHaveBeenCalled()
    })

    it('polls the transcript every two seconds only while visible', async () => {
        vi.useFakeTimers()
        let visibility: DocumentVisibilityState = 'visible'
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
        const api = makeApi()
        renderPage(api)
        const request = api.getDshSubagentMessages as unknown as ReturnType<typeof vi.fn>
        await flushAsync()
        await flushAsync()
        expect(request).toHaveBeenCalledTimes(1)

        await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
        expect(request).toHaveBeenCalledTimes(2)

        visibility = 'hidden'
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'))
            await vi.advanceTimersByTimeAsync(8000)
        })
        expect(request).toHaveBeenCalledTimes(2)

        visibility = 'visible'
        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'))
            await vi.advanceTimersByTimeAsync(0)
        })
        expect(request).toHaveBeenCalledTimes(3)
    })
})
