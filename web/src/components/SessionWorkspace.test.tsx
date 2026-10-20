import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionWorkspace } from './SessionWorkspace'

beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('SessionWorkspace navigation', () => {
    it('keeps all workspace views visible and respects unavailable terminal access', () => {
        const select = vi.fn()
        render(<I18nProvider><SessionWorkspace open view="directories" path="/project"
            terminalAvailable={false} filesAvailable onSelect={select} onClose={() => {}}
            chat={<p>Retained conversation</p>} panel={<p>Project tree</p>} /></I18nProvider>)

        expect(screen.getByRole('button', { name: 'Project files' })).toHaveAttribute('aria-current', 'page')
        expect(screen.getByRole('button', { name: 'Terminal' })).toBeDisabled()
        const changes = screen.getByRole('button', { name: 'Code changes' })
        fireEvent.click(changes)
        expect(select).toHaveBeenCalledWith('changes')
    })

    it('keeps a retained background panel hidden without moving focus', () => {
        const ui = (foreground: boolean) => <I18nProvider>
            <button type="button">Other pane</button>
            <SessionWorkspace open={foreground} foreground={foreground} keepPanelMounted view="directories"
                terminalAvailable filesAvailable onSelect={() => {}} onClose={() => {}}
                chat={<p>Retained conversation</p>} panel={<p>Project tree</p>} />
        </I18nProvider>
        const { rerender } = render(ui(true))
        const next = screen.getByRole('button', { name: 'Other pane' })
        next.focus()
        rerender(ui(false))
        expect(screen.getByRole('region', { hidden: true })).not.toBeVisible()
        expect(next).toHaveFocus()
        rerender(ui(true))
        expect(screen.getByRole('region', { name: 'Workspace' })).toBeVisible()
    })

    it('leaves focus with the new view when choosing Terminal moves it there', async () => {
        render(<I18nProvider>
            <button type="button">Terminal input</button>
            <SessionWorkspace open view="directories" terminalAvailable filesAvailable
                onSelect={() => screen.getByRole('button', { name: 'Terminal input' }).focus()}
                onClose={() => {}} chat={null} panel={<p>Project tree</p>} />
        </I18nProvider>)
        fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Terminal input' })).toHaveFocus())
        expect(screen.getByRole('button', { name: 'Terminal input' })).toHaveFocus()
    })
})
