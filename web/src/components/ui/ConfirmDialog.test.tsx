import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ConfirmDialog } from './ConfirmDialog'

function renderDialog(centerTitle = false) {
    render(
        <I18nProvider>
            <ConfirmDialog
                isOpen={true}
                onClose={vi.fn()}
                title="Archive Session"
                description="Archive this session?"
                confirmLabel="Archive"
                confirmingLabel="Archiving..."
                onConfirm={vi.fn(async () => {})}
                isPending={false}
                centerTitle={centerTitle}
            />
        </I18nProvider>
    )
}

describe('ConfirmDialog', () => {
    it('centers an opted-in title on the close button centerline', () => {
        renderDialog(true)

        const dialog = screen.getByRole('dialog')
        const title = within(dialog).getByRole('heading', { name: 'Archive Session' })
        const description = within(dialog).getByText('Archive this session?')

        expect(title.parentElement).toHaveClass('pr-0')
        expect(title).toHaveClass('min-h-6', 'px-10', 'text-center', 'leading-6')
        expect(description).toHaveClass('mt-2', 'text-left')
        expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveClass('top-3', 'h-8')
    })

    it('keeps the default dialog title layout when centering is not requested', () => {
        renderDialog()

        const title = screen.getByRole('heading', { name: 'Archive Session' })

        expect(title.parentElement).toHaveClass('pr-12')
        expect(title).not.toHaveClass('min-h-6', 'px-10', 'leading-6')
    })
})

it('locks repeated confirmation and dismissal until completion, then permits explicit retry', async () => {
    const { fireEvent, act, waitFor } = await import('@testing-library/react')
    let reject!: (error: Error) => void
    const confirm = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail })).mockResolvedValue(undefined)
    const close = vi.fn()
    render(<I18nProvider><ConfirmDialog isOpen onClose={close} title="Fork recovery" description="Original session stays unchanged" confirmLabel="Create branch" confirmingLabel="Creating branch" onConfirm={confirm} isPending={false} /></I18nProvider>)
    const button = screen.getByRole('button', { name: 'Create branch' })
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
    await act(async () => { reject(new Error('Runner offline')) })
    expect(screen.getByRole('alert')).toHaveTextContent('Runner offline')
    fireEvent.click(screen.getByRole('button', { name: 'Create branch' }))
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
})
