import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export function useCodexAccounts(api: ApiClient | null, machineId: string | null, enabled = true) {
    return useQuery({
        queryKey: queryKeys.machineCodexAccounts(machineId ?? ''),
        enabled: enabled && Boolean(api && machineId),
        queryFn: async () => {
            if (!api || !machineId) throw new Error('Codex account catalog is unavailable')
            const response = await api.getMachineCodexAccounts(machineId)
            if (!response.success) throw new Error(response.error || 'Failed to load Codex accounts')
            return response
        },
        staleTime: 15_000,
    })
}
