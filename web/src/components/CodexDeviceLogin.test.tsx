import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { CodexDeviceLogin } from './CodexDeviceLogin'
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const login = { id: 'attempt', userCode: 'ABCD-EFGH', verificationUrl: 'https://auth.openai.com/codex/device', expiresAt: Date.now() + 900000, status: 'pending' }
function setup(api: unknown, onComplete = vi.fn()) {
    render(<QueryClientProvider client={new QueryClient()}><CodexDeviceLogin api={api as ApiClient} machineId="machine" onComplete={onComplete} /></QueryClientProvider>)
}
describe('device login web flow', () => {
    it('shows device code and authorization link then saves the completed account', async () => {
        const onComplete = vi.fn()
        const api = { codexDeviceLogin: vi.fn().mockResolvedValueOnce({ success: true, login }).mockResolvedValue({ success: true, login: { ...login, status: 'completed', account: { id: 'account', label: 'Personal' } } }) }
        setup(api, onComplete)
        fireEvent.click(screen.getByText('codex.login.add'))
        expect(await screen.findByText('ABCD-EFGH')).toBeTruthy()
        expect(screen.getByText('codex.login.open').getAttribute('href')).toBe(login.verificationUrl)
        await waitFor(() => expect(onComplete).toHaveBeenCalledWith({ id: 'account', label: 'Personal' }), { timeout: 3000 })
    })
    it('offers cancellation and shows its outcome', async () => {
        const api = { codexDeviceLogin: vi.fn().mockResolvedValueOnce({ success: true, login }).mockResolvedValue({ success: true, login: { ...login, status: 'cancelled' } }) }
        setup(api)
        fireEvent.click(screen.getByText('codex.login.add'))
        await screen.findByText('ABCD-EFGH')
        fireEvent.click(screen.getByText('button.cancel'))
        expect(await screen.findByText('codex.login.cancelled')).toBeTruthy()
    })
})
