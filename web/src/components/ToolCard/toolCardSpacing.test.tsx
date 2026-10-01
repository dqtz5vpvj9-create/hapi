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

    return screen.getByRole('button', { expanded: false })
}

describe('ToolCard command summary and details', () => {
    it('keeps command output hidden until the user opens details', () => {
        const trigger = renderDetailedBash('echo hello && pwd')
        expect(screen.queryByText('Input')).not.toBeInTheDocument()
        expect(screen.queryByText('ok')).not.toBeInTheDocument()
        fireEvent.click(trigger)
        expect(screen.getByRole('dialog')).toHaveTextContent('echo hello && pwd')
        expect(screen.getByRole('dialog')).toHaveTextContent('ok')
    })

    it('keeps a pending non-approval execution collapsed too', () => {
        const trigger = renderDetailedBash('pwd', 'pending')
        expect(screen.queryByText('Input')).not.toBeInTheDocument()
        fireEvent.click(trigger)
        expect(screen.getByRole('dialog')).toHaveTextContent('pwd')
    })
})

describe('ToolCard detail dialog', () => {
    it('keeps the tool detail title left-aligned on mobile', () => {
        renderDetailedBash('pwd')

        fireEvent.click(screen.getByRole('button', { expanded: false }))

        const dialog = screen.getByRole('dialog')
        const title = within(dialog).getByRole('heading')
        expect(title.parentElement).toHaveClass('text-left')
        expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveClass('top-2')
    })
})
