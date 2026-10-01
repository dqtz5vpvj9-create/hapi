import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { MessageStatusIndicator } from './MessageStatusIndicator'

afterEach(cleanup)

describe('terminal failed message actions', () => {
    it('offers an explicit discard that does not invoke retry', () => {
        const onDiscard = vi.fn()
        const onRetry = vi.fn()
        render(<I18nProvider><MessageStatusIndicator status="failed" onDiscard={onDiscard} onRetry={onRetry} /></I18nProvider>)
        fireEvent.click(screen.getByRole('button', { name: 'Discard failed message' }))
        expect(onDiscard).toHaveBeenCalledTimes(1)
        expect(onRetry).not.toHaveBeenCalled()
    })
    it('does not offer local discard for a sending or queued message', () => {
        const { rerender } = render(<I18nProvider><MessageStatusIndicator status="sending" onDiscard={vi.fn()} /></I18nProvider>)
        expect(screen.queryByRole('button')).toBeNull()
        rerender(<I18nProvider><MessageStatusIndicator status="queued" onDiscard={vi.fn()} /></I18nProvider>)
        expect(screen.queryByRole('button')).toBeNull()
    })
})
