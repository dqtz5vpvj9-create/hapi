import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { useCodexAccounts } from '@/hooks/queries/useCodexAccounts'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'
import { CodexDeviceLogin } from '@/components/CodexDeviceLogin'
import { CodexAccountSelector } from '@/components/NewSession/CodexAccountSelector'

export function MachineCodexAccounts({ api, machineId }: { api: ApiClient; machineId: string }) {
    const { t } = useTranslation()
    const catalog = useCodexAccounts(api, machineId)
    const queries = useQueryClient()
    const [selected, setSelected] = useState('')
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const run = async (operation: () => Promise<{ success: boolean; error?: string }>) => {
        setPending(true)
        setError(null)
        try {
            const result = await operation()
            if (!result.success) throw new Error(result.error || t('session.status.codexAccount.switchFailed'))
            await queries.invalidateQueries({ queryKey: queryKeys.machineCodexAccounts(machineId) })
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason))
        } finally { setPending(false) }
    }
    return <div className="mt-3 rounded-lg border border-[var(--app-divider)]">
        <CodexAccountSelector
            accounts={catalog.data?.accounts ?? []}
            value={selected || catalog.data?.currentAccountId || ''}
            currentAccountId={catalog.data?.currentAccountId ?? null}
            isLoading={catalog.isLoading} isDisabled={pending}
            error={error ?? (catalog.error instanceof Error ? catalog.error.message : null)}
            onChange={setSelected}
            onImportCurrent={() => run(() => api.importCurrentCodexAccount(machineId))}
            onRename={(account, label) => run(() => api.renameCodexAccount(machineId, account.id, label))}
            onDelete={account => run(() => api.deleteCodexAccount(machineId, account.id))}
        />
        <div className="px-3 pb-3">
            <button type="button" disabled={pending || !selected || selected === catalog.data?.currentAccountId}
                className="rounded-lg border border-[var(--app-divider)] px-3 py-2 text-sm disabled:opacity-40"
                onClick={() => void run(() => api.switchMachineCodexAccount(machineId, selected))}>
                {pending ? t('session.status.codexAccount.switching') : t('session.status.codexAccount.switch')}
            </button>
        </div>
        <CodexDeviceLogin api={api} machineId={machineId} onComplete={account => setSelected(account.id)} />
    </div>
}
