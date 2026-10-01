import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionQuickSwitcher } from './SessionQuickSwitcher'

afterEach(cleanup)

function makeSession(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides
    }
}


const sessions = [
    makeSession({ id: 'a', updatedAt: 200, metadata: { name: 'Native debugging', path: '/work/hapi', machineId: 'linux' } }),
    makeSession({ id: 'b', updatedAt: 100, metadata: { name: 'Web interface', path: '/work/hapi', machineId: 'windows' } }),
]

function setup() {
    const onSelect = vi.fn()
    const onOpenChange = vi.fn()
    const view = (rows = sessions, open = true) => <I18nProvider><SessionQuickSwitcher open={open} onOpenChange={onOpenChange} sessions={rows} machineLabelsById={{ linux: 'Build host', windows: 'Desktop' }} onSelect={onSelect} /></I18nProvider>
    const result = render(view())
    return { ...result, view, onSelect, onOpenChange }
}

it('searches across machines and opens the matching session with Enter', () => {
    const { onSelect, onOpenChange } = setup()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'desktop hapi' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('b')
    expect(onOpenChange).toHaveBeenCalledWith(false)
})

it('preserves the keyboard selection when live activity reorders sessions', () => {
    const { onSelect, rerender, view } = setup()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
    rerender(view([sessions[0], { ...sessions[1], updatedAt: 300 }]))
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(onSelect).toHaveBeenCalledWith('b')
})

it('does not navigate on an IME confirmation or an empty result', () => {
    const { onSelect } = setup()
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter', isComposing: true })
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'nothing-matches-this' } })
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    expect(screen.queryByRole('option')).toBeNull()
    expect(onSelect).not.toHaveBeenCalled()
})

it('resets the query on reopening and supports pointer selection', () => {
    const { onSelect, rerender, view } = setup()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'desktop' } })
    rerender(view(sessions, false))
    rerender(view())
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('')
    fireEvent.click(screen.getAllByRole('option')[0])
    expect(onSelect).toHaveBeenCalledWith('a')
})
