import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionWorkspace } from './SessionWorkspace'

beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('SessionWorkspace contextual navigation', () => {
    it('keeps all workspace views reachable through the keyboard menu and respects unavailable terminal access', () => {
        const select = vi.fn()
        render(<I18nProvider><SessionWorkspace open view="directories" path="/project"
            terminalAvailable={false} filesAvailable onSelect={select} onClose={() => {}}
            chat={<p>Retained conversation</p>} panel={<p>Project tree</p>} /></I18nProvider>)

        expect(screen.queryByRole('menu')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Project files' }))
        const current = screen.getByRole('menuitemradio', { name: 'Project files' })
        expect(current).toHaveAttribute('aria-checked', 'true')
        expect(screen.getByRole('menuitemradio', { name: 'Terminal' })).toBeDisabled()
        current.focus()
        fireEvent.keyDown(current, { key: 'ArrowDown' })
        const changes = screen.getByRole('menuitemradio', { name: 'Code changes' })
        expect(changes).toHaveFocus()
        fireEvent.click(changes)
        expect(select).toHaveBeenCalledWith('changes')
        expect(screen.queryByRole('menu')).toBeNull()
    })

    it('closes a retained pane menu without moving focus back into the background pane', () => {
        const ui = (foreground: boolean) => <I18nProvider>
            <button type="button">Other pane</button>
            <SessionWorkspace open foreground={foreground} view="directories"
                terminalAvailable filesAvailable onSelect={() => {}} onClose={() => {}}
                chat={<p>Retained conversation</p>} panel={<p>Project tree</p>} />
        </I18nProvider>
        const { rerender } = render(ui(true))
        fireEvent.click(screen.getByRole('button', { name: 'Project files' }))
        expect(screen.getByRole('menu')).toBeVisible()
        const next = screen.getByRole('button', { name: 'Other pane' })
        next.focus()
        rerender(ui(false))
        expect(screen.queryByRole('menu')).toBeNull()
        expect(next).toHaveFocus()
        rerender(ui(true))
        expect(screen.queryByRole('menu')).toBeNull()
    })

    it('leaves focus with the new view when choosing Terminal moves it there', async () => {
        render(<I18nProvider>
            <button type="button">Terminal input</button>
            <SessionWorkspace open view="directories" terminalAvailable filesAvailable
                onSelect={() => screen.getByRole('button', { name: 'Terminal input' }).focus()}
                onClose={() => {}} chat={null} panel={<p>Project tree</p>} />
        </I18nProvider>)
        fireEvent.click(screen.getByRole('button', { name: 'Project files' }))
        fireEvent.click(screen.getByRole('menuitemradio', { name: 'Terminal' }))
        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
        expect(screen.getByRole('button', { name: 'Terminal input' })).toHaveFocus()
    })
})
