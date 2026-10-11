import { reconcileSessionSummary } from '@/lib/sessionSummaryPatch'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export type UseSessionsOptions = {
    enabled?: boolean
}

export function useSessions(api: ApiClient | null, options: UseSessionsOptions = {}): {
    sessions: SessionSummary[]
    isLoading: boolean
    error: string | null
    refetch: () => Promise<unknown>
} {
    const queryClient = useQueryClient()
    const query = useQuery({
        queryKey: queryKeys.sessions,
        queryFn: async () => {
            if (!api) {
                throw new Error('API unavailable')
            }
            const incoming = await api.getSessions()
            const current = queryClient.getQueryData<{ sessions: SessionSummary[] }>(queryKeys.sessions)
            const byId = new Map(current?.sessions.map(session => [session.id, session]))
            return { ...incoming, sessions: incoming.sessions.map(session => reconcileSessionSummary(byId.get(session.id), session)) }
        },
        enabled: Boolean(api) && (options.enabled ?? true),
    })

    return {
        sessions: query.data?.sessions ?? [],
        isLoading: query.isLoading,
        error: query.error instanceof Error ? query.error.message : query.error ? 'Failed to load sessions' : null,
        refetch: query.refetch,
    }
}
