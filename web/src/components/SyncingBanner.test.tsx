import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { SyncingBanner } from './SyncingBanner'

const online = vi.fn(() => true)
vi.mock('@/hooks/useOnlineStatus', () => ({ useOnlineStatus: () => online() }))

describe('SyncingBanner layout', () => {
    beforeEach(() => online.mockReturnValue(true))
    afterEach(cleanup)

    it('reserves layout space without covering navigation', () => {
        const { container } = render(<I18nProvider><SyncingBanner isSyncing /></I18nProvider>)
        const banner = container.querySelector('[data-network-status="SyncingBanner"]')
        expect(banner).toHaveClass('shrink-0')
        expect(banner).not.toHaveClass('fixed')
        expect(banner).toHaveTextContent(/sync/i)
    })

    it('still yields to offline status', () => {
        online.mockReturnValue(false)
        render(<I18nProvider><SyncingBanner isSyncing /></I18nProvider>)
        expect(screen.queryByText(/sync/i)).toBeNull()
    })
})
