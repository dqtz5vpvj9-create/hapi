import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { CREATABLE_AGENT_FLAVORS, type AgentAvailabilityEntry } from '@hapi/protocol'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

import { AgentSelector } from './AgentSelector'
import type { AgentType } from './types'

function renderedAgentValues(agents: readonly AgentType[] = CREATABLE_AGENT_FLAVORS): string[] {
    const { container } = render(
        <AgentSelector
            agent={'claude' as AgentType}
            agents={agents}
            availability={agents.map((agent) => ({ agent, available: true }))}
            isDisabled={false}
            onRefresh={() => {}}
            onAgentChange={() => {}}
        />
    )
    return Array.from(container.querySelectorAll('input[type="radio"]'))
        .map((el) => (el as HTMLInputElement).value)
}

describe('AgentSelector', () => {
    it('does not offer the sunset Gemini CLI as a new-session agent', () => {
        expect(renderedAgentValues()).not.toContain('gemini')
    })

    it('offers exactly the creatable agent flavors', () => {
        expect(renderedAgentValues()).toEqual([...CREATABLE_AGENT_FLAVORS])
    })

    it('renders only Agents reported available by the machine', () => {
        expect(renderedAgentValues(['claude', 'codex'])).toEqual(['claude', 'codex'])
    })

    it.each([
        [{ agent: 'dsh', available: false, reason: 'not_found' }, 'newSession.agentCommandNotFound'],
        [{ agent: 'dsh', available: false, reason: 'invalid_configuration' }, 'newSession.agentConfigurationInvalid'],
        [{ agent: 'dsh', available: false }, 'newSession.agentReportedUnavailable'],
        [undefined, 'newSession.agentNotReported'],
    ] as const)('explains the reported DSH availability without offering an invalid launch (%s)', (entry, reason) => {
        const onAgentChange = vi.fn()
        render(<AgentSelector agent="claude" agents={['claude', 'codex']}
            availability={[{ agent: 'claude', available: true }, { agent: 'codex', available: true }, ...(entry ? [entry] : [])]}
            isDisabled={false} onRefresh={() => {}} onAgentChange={onAgentChange} />)

        expect(screen.queryByText('DeepSeek Harness (DSH)')).not.toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'newSession.otherAgents' }))
        const dsh = screen.getByText('DeepSeek Harness (DSH)').closest('li')!
        expect(within(dsh).getByText(reason)).toBeInTheDocument()
        expect(within(dsh).queryByRole('radio')).not.toBeInTheDocument()
        expect(screen.queryByText('Gemini')).not.toBeInTheDocument()
        expect(onAgentChange).not.toHaveBeenCalled()
    })

    it('rechecks availability and exposes a newly installed DSH without changing the selected agent', () => {
        const onRefresh = vi.fn()
        const onAgentChange = vi.fn()
        const availability: AgentAvailabilityEntry[] = [{ agent: 'claude', available: true }, { agent: 'dsh', available: false, reason: 'not_found' }]
        const props = { agent: 'claude' as const, agents: ['claude'] as const, availability, isDisabled: false, onRefresh, onAgentChange }
        const view = render(<AgentSelector {...props} />)

        fireEvent.click(screen.getByRole('button', { name: 'newSession.otherAgents' }))
        fireEvent.click(screen.getByRole('button', { name: 'newSession.refreshAgents' }))
        expect(onRefresh).toHaveBeenCalledOnce()
        view.rerender(<AgentSelector {...props} isRefreshing />)
        expect(screen.getByRole('button', { name: 'newSession.refreshAgents' })).toBeDisabled()
        expect(screen.getByRole('dialog')).toBeInTheDocument()

        view.rerender(<AgentSelector {...props} agents={['claude', 'dsh']}
            availability={[{ agent: 'claude', available: true }, { agent: 'dsh', available: true }]} />)
        expect(screen.queryByText('DeepSeek Harness (DSH)')).not.toBeInTheDocument()
        expect(screen.getByRole('radio', { name: 'DeepSeek Harness' })).not.toBeChecked()
        expect(screen.getByRole('radio', { name: 'Claude' })).toBeChecked()
        expect(onAgentChange).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('radio', { name: 'DeepSeek Harness' }))
        expect(onAgentChange).toHaveBeenCalledWith('dsh')
    })

    it('keeps diagnostics out of the form when every supported agent is available', () => {
        renderedAgentValues()
        expect(screen.queryByRole('button', { name: 'newSession.otherAgents' })).not.toBeInTheDocument()
    })
})
