import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { CodexSessionSyncDialog } from './CodexSessionSyncDialog'

describe('Codex session dialog scrollable description', () => {
    afterEach(() => {
        cleanup()
        window.localStorage.clear()
    })

    it.each(['connect', 'import'] as const)(
        'keeps the %s description accessible inside the scroll area, outside the fixed header',
        (mode) => {
            render(
                <I18nProvider>
                    <CodexSessionSyncDialog
                        isOpen
                        mode={mode}
                        onClose={vi.fn()}
                        sessions={[]}
                        currentCodexSessionId={null}
                        onConfirm={vi.fn(async () => {})}
                        onRestartCodexDesktop={vi.fn(async () => {})}
                        isPending={false}
                        isRestartingCodexDesktop={false}
                        isLoading={false}
                    />
                </I18nProvider>
            )

            const dialog = screen.getByRole('dialog')
            const descriptionId = dialog.getAttribute('aria-describedby')
            expect(descriptionId).toBeTruthy()
            const description = document.getElementById(descriptionId!)
            expect(description).not.toBeNull()
            expect(description?.textContent?.trim().length).toBeGreaterThan(0)
            expect(dialog).toHaveAccessibleDescription(description!.textContent!)

            // Long explanatory copy must yield to the fixed title and actions
            // on short screens; actual pixel bounds are covered in Playwright.
            const scrollArea = screen.getByTestId('codex-session-scroll')
            const header = screen.getByTestId('codex-import-dialog-header')
            expect(scrollArea).toContainElement(description)
            expect(header).not.toContainElement(description)
            expect(header).toContainElement(screen.getByRole('heading'))
            expect(scrollArea).toHaveClass('min-h-0', 'overflow-y-auto')
            expect(scrollArea).not.toContainElement(screen.getByRole('button', { name: 'Cancel' }))
            expect(scrollArea).not.toContainElement(screen.getByRole('button', { name: 'Close' }))
        }
    )
})
