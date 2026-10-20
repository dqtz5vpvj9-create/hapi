import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { MessageDependenciesResponse } from '@hapi/protocol/apiTypes'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import type { DecryptedMessage } from '@/types/api'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { I18nProvider } from '@/lib/i18n-context'
import { ToolCard } from './ToolCard'
import { NativeDependencyProvider } from './nativeDependencies'

vi.mock('@/lib/clipboard', () => ({ safeCopyToClipboard: vi.fn(async () => {}) }))

function commandBlock(overrides: Partial<ToolCallBlock['tool']> = {}): ToolCallBlock {
    return {
        kind: 'tool-call', id: 'command-1', localId: null, createdAt: 1000, children: [],
        tool: {
            id: 'command-1', name: 'CodexBash', state: 'completed',
            input: { command: 'run-tests --verbose', cwd: '/workspace/project' },
            result: 'FIRST_LINE\nSECOND_LINE\nTHIRD_LINE\nFINAL_LINE',
            createdAt: 1000, startedAt: 1000, completedAt: 2100,
            execStartedAt: null, execCompletedAt: null, description: null,
            ...overrides
        }
    }
}

function card(block: ToolCallBlock, api = {} as ApiClient) {
    return <ToolCard api={api} sessionId="command-session" metadata={null} terminalToolDisplayMode="detailed" disabled={false} onDone={() => {}} block={block} />
}

function ui(block: ToolCallBlock) {
    return <I18nProvider>{card(block)}</I18nProvider>
}

function nativeMessage(id: string, data: Record<string, unknown>, seq: number): DecryptedMessage {
    return { id, seq, localId: null, createdAt: 1000 + seq,
        content: { role: 'agent', content: { type: 'codex', data } } }
}

const seed = nativeMessage('native-command-seed', {
    type: 'tool-call', callId: 'command-1', name: 'CodexBash', input: { command: 'run-tests --verbose' }
}, 1)

function nativeBlock(): ToolCallBlock {
    const normalized = normalizeDecryptedMessage(seed)
    if (!normalized) throw new Error('Expected the native command seed')
    const block = reduceChatBlocks([normalized], null).blocks[0]
    if (block.kind !== 'tool-call') throw new Error('Expected a native command block')
    return block
}

function resultMessage(output: unknown) {
    return nativeMessage('native-command-result', { type: 'tool-call-result', callId: 'command-1', output }, 2)
}

function response(messages: DecryptedMessage[]): MessageDependenciesResponse {
    return { epoch: 1, reset: false, indexReady: true, indexScanned: true, seedMessageIds: [seed.id], messages,
        complete: true, issues: [], pendingMessageIds: [] }
}

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}

function client(handler: (...args: Parameters<ApiClient['getMessageDependencies']>) => Promise<MessageDependenciesResponse>): ApiClient {
    return { getAuthToken: () => 'command-auth', getMessageDependencies: vi.fn(handler) } as unknown as ApiClient
}

function nativeUi(block: ToolCallBlock, api: ApiClient) {
    return <I18nProvider><NativeDependencyProvider api={api} sessionId="command-session" epoch={1} enabled messages={[seed]}>
        {card(block, api)}
    </NativeDependencyProvider></I18nProvider>
}

beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
})

describe('command summary and inline details', () => {
    it('retains argument boundaries, empty arguments and extra fields in the full inspector', async () => {
        const input = {
            command: ['/bin/bash', '-lc', 'printf "%s" "$VALUE"\nprintf "done"', '', 'a b'],
            cwd: '/workspace/a folder',
            timeout_ms: 5000,
        }
        render(ui(commandBlock({ input })))
        fireEvent.click(screen.getByRole('button', { name: /^Ran / }))
        fireEvent.click(screen.getByRole('button', { name: 'Open full details' }))
        const original = within(screen.getByRole('dialog')).getByRole('region', { name: 'Original input' })
        expect(original).toHaveTextContent('/workspace/a folder')
        expect(original).toHaveTextContent('timeout_ms')
        const codeBlock = original.closest('[data-hapi-code-block]') as HTMLElement
        fireEvent.click(within(codeBlock).getByTitle('Copy'))
        await waitFor(() => expect(safeCopyToClipboard).toHaveBeenCalled())
        expect(JSON.parse(vi.mocked(safeCopyToClipboard).mock.calls[0][0])).toEqual(input)
    })

    it('previews the head and latest line and expands the complete command/output without opening a modal', () => {
        render(ui(commandBlock()))
        const preview = screen.getByRole('region', { name: 'Output preview' })
        expect(preview.textContent).toBe('FIRST_LINE\n…\nFINAL_LINE')
        expect(screen.queryByText('THIRD_LINE')).not.toBeInTheDocument()
        const toggle = screen.getByRole('button', { name: 'Show details +2 lines' })
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        fireEvent.click(toggle)

        const details = screen.getByRole('region', { name: 'Command details' })
        expect(details).toHaveTextContent('run-tests --verbose')
        expect(details).toHaveTextContent('/workspace/project')
        expect(details).toHaveTextContent('THIRD_LINE')
        expect(details).toHaveTextContent('FINAL_LINE')
        expect(screen.getByRole('button', { name: /^Ran run-tests/ })).toHaveAttribute('aria-controls', details.id)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
        expect(screen.queryByRole('region', { name: 'Command details' })).not.toBeInTheDocument()
        expect(screen.getByRole('region', { name: 'Output preview' }).textContent).toBe('FIRST_LINE\n…\nFINAL_LINE')
    })

    it('shows failed exit status, prioritizes stderr in the preview and retains every diagnostic in details', () => {
        render(ui(commandBlock({ result: {
            type: 'exec_command_end', exit_code: 1,
            stdout: 'NORMAL_OUTPUT', stderr: 'STDERR_DIAGNOSTIC', error: 'ADDITIONAL_EXECUTION_DIAGNOSTIC'
        } })))
        expect(screen.getByRole('button', { name: /^Failed \(exit 1\)/ })).toBeVisible()
        expect(screen.getByLabelText('error')).toBeInTheDocument()
        expect(screen.queryByLabelText('completed')).not.toBeInTheDocument()
        expect(screen.getByRole('region', { name: 'Output preview' }).textContent).toMatch(/^STDERR_DIAGNOSTIC/)
        fireEvent.click(screen.getByRole('button', { name: /^Failed \(exit 1\)/ }))
        const details = screen.getByRole('region', { name: 'Command details' })
        for (const text of ['NORMAL_OUTPUT', 'STDERR_DIAGNOSTIC', 'ADDITIONAL_EXECUTION_DIAGNOSTIC']) expect(details).toHaveTextContent(text)
    })

    it('keeps copy and wrap usable without toggling disclosure and renders terminal output as text', async () => {
        const raw = '\u001b[31mRED_OUTPUT\u001b[0m\n<img src=x onerror="throw 1">\nFINAL_LINE\n'
        const view = render(ui(commandBlock({ result: raw })))
        fireEvent.click(screen.getByRole('button', { name: /^Ran run-tests/ }))
        const details = screen.getByRole('region', { name: 'Command details' })
        const output = within(details).getByText('Output').closest('[data-hapi-code-block]') as HTMLElement
        expect(output).toHaveTextContent('RED_OUTPUT')
        expect(output.textContent).not.toContain('\u001b')
        expect(output).toHaveTextContent('<img src=x onerror="throw 1">')
        expect(output.querySelector('img')).toBeNull()
        for (const button of details.querySelectorAll('button')) {
            expect(button.parentElement?.closest('button, [role="button"]')).toBeNull()
        }

        fireEvent.click(within(output).getByTitle('Copy'))
        await waitFor(() => expect(safeCopyToClipboard).toHaveBeenCalledWith(raw))
        fireEvent.click(within(output).getByRole('button', { pressed: false }))
        expect(within(output).getByRole('button', { pressed: true })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: /^Ran run-tests/ })).toHaveAttribute('aria-expanded', 'true')
        expect(view.container.querySelector('[data-hapi-command-details]')).toBe(details)
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('updates running output and final failure without closing the expanded card', () => {
        const initial = commandBlock({ state: 'running', result: undefined, completedAt: null })
        const view = render(ui(initial))
        expect(screen.getByText('Waiting for output…')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /^Running run-tests/ }))
        view.rerender(ui({ ...initial, tool: { ...initial.tool, result: { stdout: 'PARTIAL_OUTPUT' } } }))
        expect(screen.getByRole('region', { name: 'Command details' })).toHaveTextContent('PARTIAL_OUTPUT')
        view.rerender(ui({ ...initial, tool: { ...initial.tool, state: 'error', completedAt: 3000,
            result: { type: 'exec_command_end', stdout: 'FINAL_FAILURE', exit_code: 1 } } }))
        expect(screen.getByRole('region', { name: 'Command details' })).toHaveTextContent('FINAL_FAILURE')
        expect(screen.getByRole('region', { name: 'Command details' })).not.toHaveTextContent('PARTIAL_OUTPUT')
        expect(screen.getByRole('button', { name: /^Failed \(exit 1\)/ })).toHaveAttribute('aria-expanded', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
        expect(screen.getByRole('region', { name: 'Output preview' })).toHaveTextContent('FINAL_FAILURE')
    })

    it.each([
        { result: undefined, label: 'Output not available' },
        { result: '', label: '(no output)' },
        { result: { type: 'exec_command_end', exit_code: 0 }, label: '(no output)' }
    ])('distinguishes $label from an unfetched result', ({ result, label }) => {
        render(ui(commandBlock({ result })))
        expect(screen.getByText(label)).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /^Ran run-tests/ }))
        expect(within(screen.getByRole('region', { name: 'Command details' })).getByText(label)).toBeInTheDocument()
    })

    it('renders mixed text and artifacts once and keeps artifacts outside command share exclusions', () => {
        render(ui(commandBlock({ result: { content: [
            { type: 'text', text: 'REPORT_READY' },
            { type: 'artifact', artifact: { id: 'command-report', fileName: 'report.txt', mimeType: 'text/plain' } }
        ] } })))
        const header = screen.getByRole('button', { name: /^Ran run-tests/ })
        expect(header.closest('[data-hapi-share-exclude="true"]')).not.toBeNull()
        expect(screen.getByRole('region', { name: 'Output preview' }).closest('[data-hapi-share-exclude="true"]')).not.toBeNull()
        fireEvent.click(header)
        const details = screen.getByRole('region', { name: 'Command details' })
        expect(within(details).getAllByText('REPORT_READY')).toHaveLength(1)
        const artifact = within(details).getByText('report.txt')
        expect(artifact.closest('[data-hapi-share-exclude="true"]')).toBeNull()
        for (const label of ['Command', 'Output']) {
            expect(within(details).getByRole('region', { name: label }).closest('[data-hapi-share-exclude="true"]')).not.toBeNull()
        }
    })

    it('identifies artifact-only output without claiming the command result is unavailable or empty', () => {
        render(ui(commandBlock({ result: { content: [
            { type: 'artifact', artifact: { id: 'command-report', fileName: 'report.txt', mimeType: 'text/plain' } }
        ] } })))
        expect(screen.getByText('1 resources')).toBeInTheDocument()
        expect(screen.queryByText('Output not available')).not.toBeInTheDocument()
        expect(screen.queryByText('(no output)')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /^Ran run-tests/ }))
        const details = screen.getByRole('region', { name: 'Command details' })
        expect(within(details).getByText('report.txt')).toBeInTheDocument()
        expect(details).not.toHaveTextContent('Output not available')
        expect(details).not.toHaveTextContent('(no output)')
    })

    it('keeps only the live DSH command open and folds completed commands', async () => {
        const completed = commandBlock()
        const provider = (block: ToolCallBlock) => <I18nProvider><HappyChatProvider value={{
            api: {} as ApiClient, sessionId: 'command-session', metadata: { flavor: 'dsh' } as never,
            terminalToolDisplayMode: 'detailed', showSessionSummaryInChat: false,
            disabled: false, onRefresh: () => {}, hasMoreMessages: false, isSyncingTail: false,
            isLoadingMoreMessages: false, loadOlderMessagesPreservingScroll: async () => 'terminal-stop'
        }}>{card(block)}</HappyChatProvider></I18nProvider>
        const view = render(provider(completed))
        expect(screen.queryByRole('region', { name: 'Output preview' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Show details +2 lines' })).toBeInTheDocument()
        const running = commandBlock({ state: 'running', result: undefined, completedAt: null })
        view.rerender(provider(running))
        await waitFor(() => expect(screen.getByRole('region', { name: 'Command details' })).toBeInTheDocument())
        view.rerender(provider(completed))
        await waitFor(() => expect(screen.queryByRole('region', { name: 'Command details' })).not.toBeInTheDocument())
    })

    it('preserves disclosure when a native virtual row unmounts and returns', () => {
        const disclosureState = new Map<string, boolean>()
        const block = commandBlock()
        function tree(children: ReactNode) {
            return <I18nProvider><HappyChatProvider value={{
                api: {} as ApiClient, sessionId: 'command-session', metadata: null,
                terminalToolDisplayMode: 'detailed', showSessionSummaryInChat: false, disclosureState,
                disabled: false, onRefresh: () => {}, hasMoreMessages: false, isSyncingTail: false,
                isLoadingMoreMessages: false, loadOlderMessagesPreservingScroll: async () => 'terminal-stop'
            }}>{children}</HappyChatProvider></I18nProvider>
        }
        const view = render(tree(card(block)))
        fireEvent.click(screen.getByRole('button', { name: /^Ran run-tests/ }))
        expect(disclosureState.get(block.id)).toBe(true)
        view.rerender(tree(null))
        view.rerender(tree(card(block)))
        expect(screen.getByRole('region', { name: 'Command details' })).toHaveTextContent('FINAL_LINE')
        expect(screen.getByRole('button', { name: /^Ran run-tests/ })).toHaveAttribute('aria-expanded', 'true')
    })
})

describe('command native dependency ownership', () => {
    it('loads on expansion and keeps one request alive when the full detail modal closes', async () => {
        const pending = deferred<MessageDependenciesResponse>()
        const api = client(() => pending.promise)
        const block = nativeBlock()
        render(nativeUi(block, api))
        expect(api.getMessageDependencies).not.toHaveBeenCalled()
        expect(screen.queryByText('(no output)')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /^Running run-tests/ }))
        await waitFor(() => expect(api.getMessageDependencies).toHaveBeenCalledTimes(1))
        const signal = vi.mocked(api.getMessageDependencies).mock.calls[0][3]!
        expect(signal.aborted).toBe(false)
        fireEvent.click(screen.getByRole('button', { name: 'Open full details' }))
        expect(screen.getByRole('dialog')).toHaveTextContent('Loading tool and child history')
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
        expect(signal.aborted).toBe(false)
        expect(api.getMessageDependencies).toHaveBeenCalledTimes(1)

        await act(async () => pending.resolve(response([resultMessage({ type: 'exec_command_end', stdout: 'HYDRATED_FIRST\nHYDRATED_SECOND\nHYDRATED_LAST', exit_code: 0 })])))
        expect(screen.getByRole('region', { name: 'Command details' })).toHaveTextContent('HYDRATED_LAST')
        expect(api.getMessageDependencies).toHaveBeenCalledWith('command-session', [seed.id], 1, signal)
        fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
        expect(screen.getByRole('region', { name: 'Output preview' }).textContent).toBe('HYDRATED_FIRST\n…\nHYDRATED_LAST')
        fireEvent.click(screen.getByRole('button', { name: /^Ran run-tests/ }))
        expect(screen.getByRole('region', { name: 'Command details' })).toHaveTextContent('HYDRATED_LAST')
        expect(api.getMessageDependencies).toHaveBeenCalledTimes(1)
    })

    it('uses a new live result instead of an older hydrated result on both surfaces', async () => {
        const api = client(async () => response([resultMessage({ type: 'exec_command_end', stdout: 'CACHED_OUTPUT', exit_code: 0 })]))
        const initial = nativeBlock()
        const view = render(nativeUi(initial, api))
        fireEvent.click(screen.getByRole('button', { name: /^Running run-tests/ }))
        await waitFor(() => expect(screen.getByRole('region', { name: 'Command details' })).toHaveTextContent('CACHED_OUTPUT'))
        const live = { ...initial, tool: { ...initial.tool, state: 'error' as const,
            result: { type: 'exec_command_end', stdout: 'LIVE_FAILURE', exit_code: 1 }, completedAt: 3000 } }
        view.rerender(nativeUi(live, api))
        expect(screen.getByRole('region', { name: 'Command details' })).toHaveTextContent('LIVE_FAILURE')
        expect(screen.getByRole('region', { name: 'Command details' })).not.toHaveTextContent('CACHED_OUTPUT')
        expect(screen.getByRole('button', { name: /^Failed \(exit 1\)/ })).toHaveAttribute('aria-expanded', 'true')
        fireEvent.click(screen.getByRole('button', { name: 'Open full details' }))
        expect(screen.getByRole('dialog')).toHaveTextContent('LIVE_FAILURE')
        expect(screen.getByRole('dialog')).not.toHaveTextContent('CACHED_OUTPUT')
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
        expect(screen.getByRole('region', { name: 'Command details' })).toHaveTextContent('LIVE_FAILURE')
        expect(api.getMessageDependencies).toHaveBeenCalledTimes(1)
    })

    it('discards an in-flight dependency response when live output arrives', async () => {
        const pending = deferred<MessageDependenciesResponse>()
        const api = client(() => pending.promise)
        const initial = nativeBlock()
        const view = render(nativeUi(initial, api))
        fireEvent.click(screen.getByRole('button', { name: /^Running run-tests/ }))
        await waitFor(() => expect(api.getMessageDependencies).toHaveBeenCalledTimes(1))
        const signal = vi.mocked(api.getMessageDependencies).mock.calls[0][3]!
        const live = { ...initial, tool: { ...initial.tool, state: 'completed' as const,
            result: { type: 'exec_command_end', stdout: 'LIVE_OUTPUT', exit_code: 0 }, completedAt: 3000 } }
        view.rerender(nativeUi(live, api))
        expect(signal.aborted).toBe(true)
        await act(async () => pending.resolve(response([resultMessage({ type: 'exec_command_end', stdout: 'STALE_OUTPUT', exit_code: 1 })])))
        expect(screen.getByRole('region', { name: 'Command details' })).toHaveTextContent('LIVE_OUTPUT')
        expect(screen.getByRole('region', { name: 'Command details' })).not.toHaveTextContent('STALE_OUTPUT')
        expect(screen.getByRole('button', { name: /^Ran run-tests/ })).toHaveAttribute('aria-expanded', 'true')
    })
})
