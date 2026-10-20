import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { useCallback } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useActiveSuggestions } from '@/hooks/useActiveSuggestions'
import { useSkills } from './useSkills'

function createApi() {
    return {
        getSkills: vi.fn(async () => ({
            success: true as const,
            skills: [
                { name: 'lark-base', description: 'Bitable operations' },
                { name: 'lark-calendar', description: 'Calendar operations' }
            ]
        }))
    } as unknown as ApiClient & { getSkills: ReturnType<typeof vi.fn> }
}

function Harness(props: { api: ApiClient }) {
    const { getSuggestions } = useSkills(props.api, 'session-1')
    const handler = useCallback((query: string) => getSuggestions(query), [getSuggestions])
    const [suggestions] = useActiveSuggestions('$', handler)
    return <div data-testid="count">{suggestions.length}</div>
}

describe('useSkills autocomplete', () => {
    it('does not refetch in a loop while the skill menu is open', async () => {
        const api = createApi()
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

        render(
            <QueryClientProvider client={client}>
                <Harness api={api} />
            </QueryClientProvider>
        )

        await waitFor(() => expect(api.getSkills).toHaveBeenCalled())
        await new Promise((resolve) => setTimeout(resolve, 600))

        expect(api.getSkills.mock.calls.length).toBeLessThanOrEqual(2)
    })
})
