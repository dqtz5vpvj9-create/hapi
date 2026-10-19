import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { CodexSubagentMessagesResponse } from '@hapi/protocol/apiTypes'
import { I18nProvider } from '@/lib/i18n-context'
import { CodexSubagentDialog } from './CodexSubagentDialog'

type Page = CodexSubagentMessagesResponse
const result = (text: string, threadId = 'child'): Page => ({ threadId, messages: [{ id: `${threadId}:0`, role: 'assistant', kind: 'message', text, createdAt: 0 }], before: null, hasMore: false, after: 10, epoch: 'epoch' })
function ui(api: ApiClient, threadId = 'child', open = true) {
    return <I18nProvider><CodexSubagentDialog api={api} parentSessionId="parent" threadId={threadId} title="Review agent" isOpen={open} onClose={() => {}} /></I18nProvider>
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('native subagent detail dialog', () => {
    it('renders Markdown, expandable reasoning and paired failed tool details without execution controls', async () => {
        const response: Page = { ...result(''), messages: [
            { id: 'child:0', role: 'user', kind: 'message', text: '**Review this change**', createdAt: 1000 },
            { id: 'child:10', role: 'assistant', kind: 'reasoning', text: 'Inspect the boundary first.', createdAt: 1100 },
            { id: 'child:20', role: 'tool', kind: 'tool-call', callId: 'command', toolName: 'exec_command', input: { cmd: 'bun test' }, text: 'exec_command', createdAt: 1200 },
            { id: 'child:30', role: 'tool', kind: 'tool-result', callId: 'command', output: { stdout: 'failed assertion', exit_code: 1 }, text: 'failed assertion', createdAt: 2200 },
            { id: 'child:40', role: 'tool', kind: 'tool-call', callId: 'pending', toolName: 'request_user_input', input: { question: 'Proceed?' }, text: 'request_user_input', createdAt: 2300 },
            { id: 'child:50', role: 'tool', kind: 'tool-call', callId: 'plan', toolName: 'ExitPlanMode', input: { plan: 'Read the source' }, text: 'plan', createdAt: 2500 },
            { id: 'child:60', role: 'tool', kind: 'tool-result', callId: 'plan', text: 'recorded plan', createdAt: 2600 },
        ] }
        const api = { getAuthToken: () => 'auth', getCodexSubagentMessages: vi.fn().mockResolvedValue(response) } as unknown as ApiClient
        render(ui(api))
        const task = await screen.findByText('Review this change')
        expect(task.tagName).toBe('STRONG')
        const reasoning = screen.getByText('Reasoning summary').closest('details')!
        expect(reasoning.open).toBe(false)
        fireEvent.click(screen.getByText('Reasoning summary'))
        expect(reasoning.open).toBe(true)
        expect(document.querySelector('[data-hapi-command][data-hapi-tool-state="error"]')).toBeInTheDocument()
        expect(screen.getByText(/Result not recorded in this window/)).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /approve|allow|implement|send/i })).not.toBeInTheDocument()
        expect(document.querySelectorAll('[data-native-subagent-message]')).toHaveLength(5)
    })
    it('does not replace another child with a late earlier-page result', async () => {
        let complete!: (page: Page) => void
        const request = vi.fn().mockResolvedValueOnce({ ...result('first child'), before: 1, hasMore: true })
            .mockImplementationOnce(() => new Promise<Page>(resolve => { complete = resolve }))
            .mockResolvedValueOnce(result('second child', 'other'))
        const api = { getAuthToken: () => 'auth', getCodexSubagentMessages: request } as unknown as ApiClient
        const { rerender } = render(ui(api))
        await screen.findByText('first child')
        fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
        expect(request).toHaveBeenCalledTimes(2)
        const signal = request.mock.calls[1][2].signal as AbortSignal
        rerender(ui(api, 'other'))
        await screen.findByText('second child')
        expect(signal.aborted).toBe(true)
        await act(async () => { complete(result('late old child')); await Promise.resolve() })
        expect(screen.queryByText('late old child')).not.toBeInTheDocument()
        expect(screen.getByText('second child')).toBeInTheDocument()
    })
    it('polls only while visible and open and refreshes immediately after foregrounding', async () => {
        vi.useFakeTimers()
        let visibility: DocumentVisibilityState = 'visible'
        vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
        const request = vi.fn().mockResolvedValue(result('visible record'))
        const api = { getAuthToken: () => 'auth', getCodexSubagentMessages: request } as unknown as ApiClient
        const { rerender } = render(ui(api))
        await act(async () => { await Promise.resolve() })
        expect(screen.getByText('visible record')).toBeInTheDocument()
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
        await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
        expect(request).toHaveBeenCalledTimes(2)
        visibility = 'hidden'
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); vi.advanceTimersByTime(8000); await Promise.resolve() })
        expect(request).toHaveBeenCalledTimes(2)
        visibility = 'visible'
        await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve() })
        expect(request).toHaveBeenCalledTimes(3)
        rerender(ui(api, 'child', false))
        await act(async () => { vi.advanceTimersByTime(8000); await Promise.resolve() })
        expect(request).toHaveBeenCalledTimes(3)
    })
})
