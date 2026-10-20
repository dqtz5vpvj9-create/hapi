import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { useDshBundles } from '@/hooks/queries/useDshBundles'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

/**
 * DSH profile bundle switches for one machine.
 *
 * The list mirrors the dsh installation's own bundle catalog: every package the
 * installation can compose, marked with whether this profile currently loads
 * it. Enabling only accepts names from that catalog, so the UI never asks for
 * a package name.
 */
export function MachineDshBundles({ api, machineId }: { api: ApiClient; machineId: string }) {
    const { t } = useTranslation()
    const catalog = useDshBundles(api, machineId)
    const queryClient = useQueryClient()

    const update = useMutation({
        mutationFn: async (input: { name: string; enabled: boolean }) => {
            return await api.setMachineDshBundle(machineId, input.name, input.enabled)
        },
        onSuccess: (state) => {
            queryClient.setQueryData(queryKeys.machineDshBundles(machineId), state)
        },
    })

    const entries = catalog.data?.available ?? []
    return (
        <div className="mt-3 rounded-lg border border-[var(--app-divider)] p-3">
            <div className="mb-2 text-xs text-[var(--app-hint)]">
                {catalog.data ? `${catalog.data.profile} · ${catalog.data.dshHome}` : t('loading')}
            </div>
            <ul className="flex flex-col" aria-label={t('settings.machines.dshBundles')}>
                {entries.map((entry) => (
                    <li key={entry.name} className="flex items-start justify-between gap-3 border-b border-[var(--app-divider)] py-2 last:border-b-0">
                        <div className="min-w-0">
                            <div className="truncate font-mono text-xs text-[var(--app-fg)]">{entry.name}</div>
                            {entry.description ? (
                                <div className="mt-0.5 line-clamp-2 text-xs text-[var(--app-hint)]">{entry.description}</div>
                            ) : null}
                        </div>
                        {entry.switchable ? (
                            <button
                                type="button"
                                disabled={update.isPending}
                                aria-pressed={entry.enabled}
                                className={`shrink-0 rounded border px-2 py-1 text-xs disabled:opacity-40 ${
                                    entry.enabled
                                        ? 'border-[var(--app-divider)] text-[var(--app-hint)]'
                                        : 'border-[var(--app-link)] text-[var(--app-link)]'
                                }`}
                                onClick={() => update.mutate({ name: entry.name, enabled: !entry.enabled })}
                            >
                                {entry.enabled
                                    ? t('settings.machines.dshBundleDisable')
                                    : t('settings.machines.dshBundleEnable')}
                            </button>
                        ) : (
                            <span className="shrink-0 rounded border border-[var(--app-divider)] px-2 py-1 text-xs text-[var(--app-hint)]">
                                {t('settings.machines.dshBundleRequired')}
                            </span>
                        )}
                    </li>
                ))}
                {entries.length === 0 && !catalog.isLoading ? (
                    <li className="py-2 text-xs text-[var(--app-hint)]">{t('settings.machines.dshBundlesEmpty')}</li>
                ) : null}
            </ul>
            {catalog.data?.restartRequired ? (
                <div role="status" className="mt-2 text-xs text-amber-600">
                    {t('settings.machines.dshBundleRestart')}
                </div>
            ) : null}
            {update.error ? (
                <div className="mt-2 text-xs text-red-600">
                    {update.error instanceof Error ? update.error.message : String(update.error)}
                </div>
            ) : null}
            {catalog.error ? (
                <div className="mt-2 text-xs text-red-600">
                    {catalog.error instanceof Error ? catalog.error.message : String(catalog.error)}
                </div>
            ) : null}
        </div>
    )
}
