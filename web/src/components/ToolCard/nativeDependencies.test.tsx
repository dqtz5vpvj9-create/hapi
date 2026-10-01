import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { MessageDependenciesResponse } from '@hapi/protocol/apiTypes'
import type { DecryptedMessage } from '@/types/api'
import type { ToolCallBlock } from '@/chat/types'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { ToolCard } from './ToolCard'
import { NativeDependencyProvider } from './nativeDependencies'
import { I18nProvider } from '@/lib/i18n-context'
import { installTraceGeometry } from './trace.testGeometry'
let restoreTraceGeometry: () => void
beforeEach(() => { restoreTraceGeometry = installTraceGeometry() })
afterEach(() => restoreTraceGeometry())

function raw(body: Record<string, unknown>, at = 1): DecryptedMessage {
    const id = String(body.id ?? `${body.type}-${body.agentId}`)
    return { id: `native:thread-a:turn:${id}:projection`, localId: id, seq: at, createdAt: at, scheduledAt: null,
        content: { role: 'agent', content: { type: 'codex', data: body } } }
}
function agent(id: string, parent = 'thread-a') {
    return raw({ type: 'agent-run-update', id: `start-${id}`, agentId: id, cardId: `codex-agent:${id}`, status: 'completed',
        input: { prompt: `Read report ${id}` }, scope: { role: 'child', threadId: id, parentThreadId: parent } })
}
function trace(agentId: string, index: number, parent = 'thread-a') {
    return raw({ type: 'agent-run-trace', id: `trace-${agentId}-${index}`, agentId, cardId: `codex-agent:${agentId}`,
        message: { type: 'message', id: `${agentId}-${index}`, message: `REPORT_${agentId}_${index}\nLong report body ${index}` },
        scope: { role: 'child', threadId: agentId, parentThreadId: parent } }, index + 10)
}
function blockFor(message: DecryptedMessage): ToolCallBlock {
    return reduceChatBlocks([normalizeDecryptedMessage(message)!], null).blocks[0] as ToolCallBlock
}
function response(messages: DecryptedMessage[], complete = true, epoch = 1): MessageDependenciesResponse {
    return { epoch, reset: false, indexReady: true, indexScanned: true, seedMessageIds: [], messages, complete, issues: [], pendingMessageIds: [] }
}
function client(handler: (...args: Parameters<ApiClient['getMessageDependencies']>) => Promise<MessageDependenciesResponse>) {
    return { getAuthToken: () => 'fixture-auth', getMessageDependencies: vi.fn(handler) } as unknown as ApiClient
}
function tree(api: ApiClient, roots: DecryptedMessage[], sessionId = 'session-a', epoch = 1) {
    return <I18nProvider><NativeDependencyProvider api={api} sessionId={sessionId} epoch={epoch} enabled messages={roots}>
        {roots.map(root => <ToolCard key={root.id} api={api} sessionId={sessionId} metadata={null} terminalToolDisplayMode="detailed" disabled={false} onDone={() => {}} block={blockFor(root)} />)}
    </NativeDependencyProvider></I18nProvider>
}
function open(container: HTMLElement, index = 0) {
    fireEvent.click(container.querySelectorAll('[data-slot="card"] button')[index] ?? container.querySelectorAll('button')[index]!)
}
function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
}

describe('native tool detail dependency consumption', () => {
    it('loads only on component open, accumulates 320+320 bodies across a bounded producer cache, and preserves parallel ownership', async () => {
        const roots = [agent('a'), agent('b')]
        const all = Array.from({ length: 320 }, (_, i) => [trace('a', i), trace('b', i)]).flat()
        let page = 0
        const api = client(async () => {
            page++
            // Each producer response has the accumulated suffix still resident
            // in its cache. Final page omits 136 already returned identities.
            return response(all.slice(0, Math.min(page * 64, all.length)).slice(-504), page >= 10)
        })
        const { container } = render(tree(api, roots))
        expect(api.getMessageDependencies).not.toHaveBeenCalled()
        open(container)
        await waitFor(() => expect(api.getMessageDependencies).toHaveBeenCalledTimes(10))
        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
        const dialog = screen.getByRole('dialog')
        expect(within(dialog).getByText('REPORT_a_0')).toBeInTheDocument()
        fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'REPORT_a_' } })
        expect(within(dialog).getByRole('status')).toHaveTextContent('1/320')
        fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'REPORT_a_160' } })
        await waitFor(() => expect(within(dialog).getByText(/Long report body 160/)).toBeInTheDocument())
        fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'REPORT_a_319' } })
        await waitFor(() => expect(within(dialog).getByText(/Long report body 319/)).toBeInTheDocument())
        fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'REPORT_a_0' } })
        await waitFor(() => expect(within(dialog).getByText(/Long report body 0/)).toBeInTheDocument())
        expect(within(dialog).queryByText('REPORT_b_0')).not.toBeInTheDocument()
        expect(dialog.querySelectorAll('[data-trace-row-id]').length).toBeLessThan(32)
        expect(dialog).toHaveTextContent('Long report body 0')
        expect(api.getMessageDependencies).toHaveBeenNthCalledWith(1, 'session-a', [roots[0]!.id], 1, expect.any(AbortSignal))
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
        open(container, 1)
        await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('REPORT_b_0')).toBeInTheDocument())
        fireEvent.change(within(screen.getByRole('dialog')).getByRole('searchbox'), { target: { value: 'REPORT_b_' } })
        expect(within(screen.getByRole('dialog')).getByRole('status')).toHaveTextContent('1/320')
        fireEvent.change(within(screen.getByRole('dialog')).getByRole('searchbox'), { target: { value: 'REPORT_b_319' } })
        await waitFor(() => expect(within(screen.getByRole('dialog')).getByText(/Long report body 319/)).toBeInTheDocument())
        expect(screen.getByRole('dialog').querySelectorAll('[data-trace-row-id]').length).toBeLessThan(32)
        expect(within(screen.getByRole('dialog')).queryByText('REPORT_a_0')).not.toBeInTheDocument()
        // Root reducer input is unchanged, and dependency data was never sent
        // to the root window/pagination store.
        expect(reduceChatBlocks(roots.map(root => normalizeDecryptedMessage(root)!), null).blocks.every(block => block.kind === 'tool-call' && block.children.length === 0)).toBe(true)
    })

    it('renders nested agent ownership and tool call/result inside its expanded trace', async () => {
        const root = agent('a')
        const nested = agent('nested', 'a')
        const tool = raw({ type: 'agent-run-trace', id: 'tool-start', agentId: 'nested', cardId: 'codex-agent:nested',
            message: { type: 'tool-call', callId: 'read-file', name: 'Read', input: { file_path: '/fixture/report.txt' } }, scope: { parentThreadId: 'a' } }, 20)
        const result = raw({ type: 'agent-run-trace', id: 'tool-result', agentId: 'nested', cardId: 'codex-agent:nested',
            message: { type: 'tool-call-result', callId: 'read-file', output: 'NESTED_FILE_RESULT' }, scope: { parentThreadId: 'a' } }, 21)
        let requests = 0
        const api = client(async () => ++requests === 1
            ? response([nested, trace('nested', 0, 'a'), tool, result])
            : response([trace('nested', 1, 'thread-a'), tool, result]))
        const { container } = render(tree(api, [root]))
        open(container)
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('Read report nested'))
        const nestedButton = within(screen.getByRole('dialog')).getByRole('button', { name: /Read report nested/ })
        fireEvent.click(nestedButton)
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('REPORT_nested_0'))
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /report.txt/ }))
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('NESTED_FILE_RESULT'))
        expect(within(screen.getByRole('dialog')).getAllByRole('button', { name: /Read report nested/ })).toHaveLength(1)
    })

    it.each(['epoch', 'session', 'auth'] as const)('discards and aborts a late %s response', async kind => {
        const pending = deferred<MessageDependenciesResponse>()
        const root = agent('a')
        let token = 'first-auth'
        const nextScope = deferred<MessageDependenciesResponse>()
        let calls = 0
        const api = client(async () => ++calls === 1 ? pending.promise : nextScope.promise)
        api.getAuthToken = () => token
        const view = render(tree(api, [root]))
        open(view.container)
        await waitFor(() => expect(api.getMessageDependencies).toHaveBeenCalledTimes(1))
        const signal = vi.mocked(api.getMessageDependencies).mock.calls[0]![3]!
        if (kind === 'auth') token = 'second-auth'
        view.rerender(tree(api, [root], kind === 'session' ? 'session-b' : 'session-a', kind === 'epoch' ? 2 : 1))
        expect(signal.aborted).toBe(true)
        await act(async () => pending.resolve(response([trace('a', 0)])))
        expect(screen.getByRole('dialog')).not.toHaveTextContent('REPORT_a_0')
    })

    it('shows real loading/error and retries the original seed without reopening', async () => {
        const pending = deferred<MessageDependenciesResponse>()
        const root = agent('a')
        let call = 0
        const api = client(async () => { if (++call === 1) throw new Error('Native bridge unavailable'); return pending.promise })
        const { container } = render(tree(api, [root]))
        open(container)
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Native bridge unavailable'))
        fireEvent.click(screen.getByRole('button', { name: 'Retry history' }))
        expect(screen.getByRole('status')).toHaveTextContent('Loading tool and child history')
        await act(async () => pending.resolve(response([trace('a', 0)])))
        expect(screen.getByRole('dialog')).toHaveTextContent('REPORT_a_0')
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('stops empty progress and cancels when the detail closes', async () => {
        const api = client(async () => response([], false))
        const { container } = render(tree(api, [agent('a')]))
        open(container)
        await waitFor(() => expect(screen.getByRole('button', { name: 'Read more history' })).toBeInTheDocument())
        expect(api.getMessageDependencies).toHaveBeenCalledTimes(2)
        const pending = deferred<MessageDependenciesResponse>()
        vi.mocked(api.getMessageDependencies).mockImplementation(() => pending.promise)
        fireEvent.click(screen.getByRole('button', { name: 'Read more history' }))
        const signal = vi.mocked(api.getMessageDependencies).mock.calls[2]![3]!
        fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
        expect(signal.aborted).toBe(true)
        await act(async () => pending.resolve(response([trace('a', 0)])))
        open(container)
        expect(screen.getByRole('dialog')).not.toHaveTextContent('REPORT_a_0')
    })
    it('limits one automatic burst, then resumes from accumulated bodies on explicit continue', async () => {
        const root = agent('a')
        let page = 0
        const api = client(async () => response([trace('a', page++)], page === 18))
        const { container } = render(tree(api, [root]))
        open(container)
        await waitFor(() => expect(screen.getByRole('button', { name: 'Read more history' })).toBeInTheDocument())
        expect(api.getMessageDependencies).toHaveBeenCalledTimes(16)
        expect(screen.getByRole('dialog')).toHaveTextContent('REPORT_a_0')
        fireEvent.click(screen.getByRole('button', { name: 'Read more history' }))
        await waitFor(() => expect(api.getMessageDependencies).toHaveBeenCalledTimes(18))
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Read more history' })).not.toBeInTheDocument())
        expect(screen.getByRole('dialog')).toHaveTextContent('REPORT_a_17')
        expect(screen.getByRole('dialog')).toHaveTextContent('REPORT_a_0')
    })

    it('rejects a reset response and isolates a replacement API client', async () => {
        const root = agent('a')
        const api = client(async () => ({ ...response([trace('a', 0)], true, 2), reset: true }))
        const view = render(tree(api, [root]))
        open(view.container)
        await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('History changed'))
        expect(screen.getByRole('dialog')).not.toHaveTextContent('REPORT_a_0')
        const replacement = client(async () => response([trace('a', 1)]))
        view.rerender(tree(replacement, [root]))
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('REPORT_a_1'))
        expect(screen.getByRole('dialog')).not.toHaveTextContent('REPORT_a_0')
    })

    it('survives StrictMode teardown and discards late responses after chat destruction', async () => {
        const root = agent('a')
        const api = client(async () => response([trace('a', 0)]))
        const view = render(<StrictMode>{tree(api, [root])}</StrictMode>)
        open(view.container)
        await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('REPORT_a_0'))
        const pending = deferred<MessageDependenciesResponse>()
        const nextApi = client(async () => pending.promise)
        view.rerender(<StrictMode>{tree(nextApi, [root])}</StrictMode>)
        await waitFor(() => expect(nextApi.getMessageDependencies).toHaveBeenCalled())
        const calls = vi.mocked(nextApi.getMessageDependencies).mock.calls
        view.unmount()
        expect(calls.every(call => call[3]?.aborted)).toBe(true)
        await act(async () => pending.resolve(response([trace('a', 2)])))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

})
