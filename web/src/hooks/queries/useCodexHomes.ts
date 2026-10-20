import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function useCodexHomes(api: ApiClient | null, machineId: string | null, enabled = true) {
    return useQuery({
        queryKey: queryKeys.machineCodexHomes(machineId ?? ''),
        enabled: enabled && Boolean(api && machineId),
        queryFn: async () => {
            if (!api || !machineId) throw new Error('Codex home catalog is unavailable')
            const response = await api.getCodexHomes(machineId)
            if (!response.success) throw new Error(response.error || 'Failed to load Codex homes')
            return response
        },
        staleTime: 15_000,
    })
}
