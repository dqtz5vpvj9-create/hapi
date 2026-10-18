import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ToolCallBlock } from '@/chat/types'
import { ToolCard } from '@/components/ToolCard/ToolCard'
import { I18nProvider } from '@/lib/i18n-context'

function renderDetailedBash(command: string, state: 'pending' | 'completed' = 'completed') {
    const completed = state === 'completed'
    const block: ToolCallBlock = {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 1_000,
        tool: {
            id: 'tool-1',
            name: 'Bash',
            state,
            input: { command },
            createdAt: 1_000,
            startedAt: completed ? 1_000 : null,
            completedAt: completed ? 1_500 : null,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            result: completed ? 'ok' : undefined,
        },
        children: [],
    }

    render(
        <I18nProvider>
            <ToolCard
                api={{} as ApiClient}
                sessionId="session-1"
                metadata={null}
                terminalToolDisplayMode="detailed"
                disabled={false}
                onDone={() => {}}
                block={block}
            />
        </I18nProvider>
    )

    return screen.getByRole('button', { name: completed ? /^Ran / : /^Run /, expanded: false })
}

describe('ToolCard command summary and details', () => {
    it('shows an output summary and expands full command content in place', () => {
        const trigger = renderDetailedBash('echo hello && pwd')
        expect(screen.queryByText('Input')).not.toBeInTheDocument()
        expect(screen.getByRole('region', { name: 'Output preview' })).toHaveTextContent('ok')
        fireEvent.click(trigger)
        expect(screen.getByRole('region', { name: 'Command details' })).toHaveTextContent('echo hello && pwd')
        expect(screen.getByRole('region', { name: 'Command details' })).toHaveTextContent('ok')
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('keeps a pending non-approval execution collapsed too', () => {
        const trigger = renderDetailedBash('pwd', 'pending')
        expect(screen.queryByText('Input')).not.toBeInTheDocument()
        fireEvent.click(trigger)
        expect(screen.getByRole('region', { name: 'Command details' })).toHaveTextContent('pwd')
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
})

describe('ToolCard detail dialog', () => {
    it('keeps the tool detail title left-aligned on mobile', () => {
        fireEvent.click(renderDetailedBash('pwd'))
        fireEvent.click(screen.getByRole('button', { name: 'Open full details' }))

        const dialog = screen.getByRole('dialog')
        const title = within(dialog).getByRole('heading')
        expect(title.parentElement).toHaveClass('text-left')
        expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveClass('top-2')
    })
})
