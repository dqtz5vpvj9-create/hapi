import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from './ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

function block(name: string): ToolCallBlock {
    return { kind: 'tool-call', id: 'compact-fixture', localId: null, createdAt: 1000, children: [],
        tool: { id: 'compact-fixture', name, state: 'completed', input: { command: 'ssh example.invalid inspect-report', target: 'child-a' }, result: 'FULL_RESULT_BODY',
            createdAt: 1000, startedAt: 1000, completedAt: 1100, execStartedAt: null, execCompletedAt: null, description: null } }
}
function ui(value: ToolCallBlock, api = {} as ApiClient, mode: 'compact' | 'detailed' = 'compact') {
    return <I18nProvider><ToolCard api={api} sessionId="fixture-session" metadata={null} terminalToolDisplayMode={mode} disabled={false} onDone={() => {}} block={value} /></I18nProvider>
}

describe('compact tool entry behavior', () => {
    it.each(['wait_agent', 'send_message', 'ssh', 'Bash', 'AgentRun', 'unknown_custom_tool'])('%s hides input/output until details, including with command summary preference', name => {
        const view = render(ui(block(name), undefined, 'detailed'))
        expect(screen.queryByText('Input')).not.toBeInTheDocument()
        expect(screen.queryByText('FULL_RESULT_BODY')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { expanded: false }))
        const dialog = screen.getByRole('dialog')
        expect(dialog).toHaveTextContent('FULL_RESULT_BODY')
        expect(dialog).toHaveTextContent('Result')
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        expect(view.container).not.toHaveTextContent('FULL_RESULT_BODY')
    })
    it('updates running/completed status in the same collapsed entry', () => {
        const value = block('send_message')
        value.tool.state = 'running'
        const view = render(ui(value))
        expect(screen.getByLabelText('running')).toBeInTheDocument()
        view.rerender(ui({ ...value, tool: { ...value.tool, state: 'completed', result: 'NEW_RESULT' } }))
        expect(screen.queryByLabelText('running')).not.toBeInTheDocument()
        expect(screen.getByLabelText('completed')).toBeInTheDocument()
        expect(screen.queryByText('NEW_RESULT')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { expanded: false }))
        expect(screen.getByRole('dialog')).toHaveTextContent('NEW_RESULT')
    })
    it('keeps permission input and actual approval action available outside details', async () => {
        const approvePermission = vi.fn(async () => {})
        const value = block('Bash')
        value.tool.state = 'pending'
        value.tool.permission = { id: 'permission-fixture', status: 'pending' }
        render(ui(value, { approvePermission } as unknown as ApiClient))
        expect(screen.getByText('Input')).toBeInTheDocument()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /^Allow$/ }))
        await waitFor(() => expect(approvePermission).toHaveBeenCalledWith('fixture-session', 'permission-fixture'))
    })
    it('keeps question choices and submits the selected answer without opening details', async () => {
        const approvePermission = vi.fn(async () => {})
        const value = block('AskUserQuestion')
        value.tool.state = 'pending'
        value.tool.input = { questions: [{ question: 'Pick a report', options: [{ label: 'Alpha', description: null }, { label: 'Beta', description: null }], multiSelect: false }] }
        value.tool.permission = { id: 'question-fixture', status: 'pending' }
        render(ui(value, { approvePermission } as unknown as ApiClient))
        fireEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
        await waitFor(() => expect(approvePermission).toHaveBeenCalled())
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
})
