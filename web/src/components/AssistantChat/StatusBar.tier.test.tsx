import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { StatusBar } from './StatusBar'

afterEach(cleanup)
beforeEach(() => localStorage.clear())
describe('session status and confirmed tier', () => {
    it.each([true, false])('shows confirmed tiers in compact=%s without classifying Yolo as failure', compact => {
        const bar = (serviceTier?: string | null) => <I18nProvider><StatusBar compact={compact}
            active thinking agentState={null} agentFlavor="codex" permissionMode="yolo" serviceTier={serviceTier} /></I18nProvider>
        const view = render(bar('priority'))
        expect(view.container.querySelector('[data-service-tier="fast"] svg')).toBeTruthy()
        expect(view.container.querySelector('[data-service-tier="fast"]')?.textContent).toBe('')
        expect(view.container.querySelector('[data-service-tier="fast"]')).toHaveAttribute('aria-label', 'Fast Mode: Fast')
        expect(screen.getByText('Yolo').className).toContain('text-[var(--app-fg)]')
        view.rerender(bar('standard'))
        expect(view.container.querySelector('[data-service-tier]')).toBeNull()
        for (const tier of [null, undefined, 'unknown', 'default']) {
            view.rerender(bar(tier))
            expect(view.container.querySelector('[data-service-tier]')).toBeNull()
        }
    })
    it('uses green running, neutral online, red real errors, and amber approvals', () => {
        const bar = (thinking: boolean, status?: 'systemError' | 'active', waitingOn: Array<'approval'> = []) => <I18nProvider>
            <StatusBar active thinking={thinking} agentState={null}
                execution={status ? { status, waitingOn, owner: 'test', generation: 'g1', sequence: 1, turnId: null, startedAt: null, completedAt: null } : undefined} /></I18nProvider>
        const view = render(bar(true))
        expect(screen.getByText('Running').className).toContain('text-[var(--app-badge-success-text)]')
        view.rerender(bar(false))
        expect(screen.getByText('online').className).toContain('text-[var(--app-fg)]')
        view.rerender(bar(false, 'systemError'))
        expect(screen.getByText('Execution error').className).toContain('text-[var(--app-badge-error-text)]')
        view.rerender(bar(true, 'active', ['approval']))
        expect(screen.getByText('permission required').className).toContain('text-[#FF9500]')
    })
})
