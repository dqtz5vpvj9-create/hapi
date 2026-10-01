import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CodexImportActions } from './CodexImportActions'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

describe('CodexImportActions', () => {
    it('opens the existing native Codex session chooser from one entry point', () => {
        const onChooseHistory = vi.fn()

        render(
            <CodexImportActions
                selectedSession={null}
                isLoading={false}
                isDisabled={false}
                error={null}
                onChooseHistory={onChooseHistory}
                onClear={vi.fn()}
            />
        )

        fireEvent.click(screen.getByRole('button', { name: 'codexConnect.choose' }))

        expect(onChooseHistory).toHaveBeenCalledOnce()
        expect(screen.getAllByRole('button')).toHaveLength(1)
    })

    it('blocks opening the native session chooser while sessions are loading', () => {
        const onChooseHistory = vi.fn()

        render(
            <CodexImportActions
                selectedSession={null}
                isLoading={true}
                isDisabled={false}
                error={null}
                onChooseHistory={onChooseHistory}
                onClear={vi.fn()}
            />
        )

        const chooseButton = screen.getByRole('button', { name: 'codexConnect.loading' })
        expect(chooseButton).toBeDisabled()
        fireEvent.click(chooseButton)
        expect(onChooseHistory).not.toHaveBeenCalled()
    })
})
