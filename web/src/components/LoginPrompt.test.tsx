import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { LoginPrompt } from './LoginPrompt'

function renderWithProviders(ui: React.ReactElement) {
    return render(
        <I18nProvider>
            {ui}
        </I18nProvider>
    )
}

describe('LoginPrompt', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        const localStorageMock = {
            getItem: vi.fn(() => 'en'),
            setItem: vi.fn(),
            removeItem: vi.fn(),
            clear: vi.fn(),
            key: vi.fn(() => null),
            length: 0,
        }
        Object.defineProperty(window, 'localStorage', { value: localStorageMock, configurable: true })
    })

    it('does not clear first hub URL edit when hub URL required', async () => {
        renderWithProviders(
            <LoginPrompt
                baseUrl="https://app.example.com"
                serverUrl={null}
                setServerUrl={vi.fn((value: string) => ({ ok: true as const, value }))}
                clearServerUrl={vi.fn()}
                requireServerUrl={true}
                onLogin={vi.fn()}
            />
        )

        fireEvent.change(screen.getByPlaceholderText('Access token'), { target: { value: 'token' } })
        fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

        const hubInput = await screen.findByPlaceholderText('https://hapi.example.com')
        expect(screen.getByText('Hub URL required. Please set it before signing in.')).toBeInTheDocument()

        fireEvent.change(hubInput, { target: { value: 'https://hub.example.com' } })

        expect(hubInput).toHaveValue('https://hub.example.com')
        expect(screen.queryByText('Hub URL required. Please set it before signing in.')).not.toBeInTheDocument()
    })
})

 it('shows a human-readable error without raw HTTP response bodies', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({error:'Invalid access token'}), {status:401, statusText:'Unauthorized'}))
    try {
        renderWithProviders(<LoginPrompt baseUrl="http://localhost:3006" serverUrl={null} setServerUrl={vi.fn()} clearServerUrl={vi.fn()} onLogin={vi.fn()} />)
        fireEvent.change(screen.getByPlaceholderText('Access token'), {target:{value:'invalid-fixture'}})
        fireEvent.click(screen.getByRole('button', {name:'Sign In'}))
        expect(await screen.findByText('The access token is incorrect. Check that the token belongs to the selected Hub.')).toBeInTheDocument()
        expect(screen.queryByText(/HTTP 401/)).not.toBeInTheDocument()
    } finally {fetch.mockRestore()}
})
