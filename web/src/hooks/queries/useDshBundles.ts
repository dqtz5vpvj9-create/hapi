import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

/** Read the DSH profile bundles composed for one machine. */
export function useDshBundles(api: ApiClient | null, machineId: string | null, enabled = true) {
    return useQuery({
        queryKey: queryKeys.machineDshBundles(machineId ?? ''),
        enabled: enabled && Boolean(api && machineId),
        queryFn: async () => {
            if (!api || !machineId) throw new Error('DSH bundle catalog is unavailable')
            return await api.getMachineDshBundles(machineId)
        },
        staleTime: 15_000,
    })
}
