import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { useCodexHomes } from '@/hooks/queries/useCodexHomes'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'

export function MachineCodexHomes({ api, machineId }: { api: ApiClient; machineId: string }) {
    const { t } = useTranslation()
    const catalog = useCodexHomes(api, machineId)
    const queries = useQueryClient()
    const [label, setLabel] = useState('')
    const [path, setPath] = useState('')
    const [sourceHome, setSourceHome] = useState('')
    const [targetHome, setTargetHome] = useState('')
    const [threadId, setThreadId] = useState('')
    const [sessionId, setSessionId] = useState('')
    const [targetProvider, setTargetProvider] = useState('')
    const [targetModel, setTargetModel] = useState('')
    const [migration, setMigration] = useState<string | null>(null)
    const [warnings, setWarnings] = useState<string[]>([])
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const run = async (operation: () => Promise<{ success: boolean; error?: string }>) => {
        setPending(true); setError(null)
        try {
            const result = await operation()
            if (!result.success) throw new Error(result.error || t('settings.machines.codexHomesFailed'))
            await queries.invalidateQueries({ queryKey: queryKeys.machineCodexHomes(machineId) })
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason))
        } finally { setPending(false) }
    }
    const add = () => {
        if (!label.trim() || !path.trim()) return
        void run(async () => {
            const result = await api.saveCodexHome(machineId, { label: label.trim(), path: path.trim() })
            if (result.success) { setLabel(''); setPath('') }
            return result
        })
    }
    return <div className="mt-3 rounded-lg border border-[var(--app-divider)] p-3 text-sm">
        <div className="space-y-2">
            {catalog.data?.homes?.map(home => <div key={home.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate font-medium">{home.label}{home.official ? ' · official' : ''}</div>
                    <div className="truncate text-xs text-[var(--app-hint)]">{home.path}</div>
                </div>
                {home.id !== 'default' ? <button type="button" disabled={pending}
                    className="rounded border border-[var(--app-divider)] px-2 py-1 text-xs disabled:opacity-40"
                    onClick={() => void run(() => api.deleteCodexHome(machineId, home.id))}>{t('settings.machines.codexHomesRemove')}</button> : null}
            </div>)}
            {catalog.isLoading ? <div className="text-xs text-[var(--app-hint)]">{t('settings.machines.codexHomesLoading')}</div> : null}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <input value={label} onChange={event => setLabel(event.target.value)} placeholder={t('settings.machines.codexHomesLabel')}
                className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm" />
            <input value={path} onChange={event => setPath(event.target.value)} placeholder={t('settings.machines.codexHomesPath')}
                className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm" />
        </div>
        <button type="button" disabled={pending || !label.trim() || !path.trim()}
            className="mt-2 rounded-lg border border-[var(--app-divider)] px-3 py-2 text-sm disabled:opacity-40" onClick={add}>
            {t('settings.machines.codexHomesAdd')}
        </button>
        <div className="mt-4 border-t border-[var(--app-divider)] pt-3">
            <div className="mb-2 text-xs font-medium">{t('settings.machines.codexHomesMigrate')}</div>
            <div className="grid gap-2 sm:grid-cols-3">
                <input value={sourceHome} onChange={event => setSourceHome(event.target.value)} placeholder={t('settings.machines.codexHomesSource')}
                    className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm" />
                <input value={targetHome} onChange={event => setTargetHome(event.target.value)} placeholder={t('settings.machines.codexHomesTarget')}
                    className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm" />
                <input value={threadId} onChange={event => setThreadId(event.target.value)} placeholder={t('settings.machines.codexHomesThread')}
                    className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm" />
                <input value={sessionId} onChange={event => setSessionId(event.target.value)} placeholder={t('settings.machines.codexHomesSession')}
                    className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm" />
                <input value={targetProvider} onChange={event => setTargetProvider(event.target.value)} placeholder={t('settings.machines.codexHomesProvider')}
                    className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm" />
                <input value={targetModel} onChange={event => setTargetModel(event.target.value)} placeholder={t('settings.machines.codexHomesModel')}
                    className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm" />
            </div>
            <button type="button" disabled={pending || !sourceHome.trim() || !targetHome.trim() || !threadId.trim()}
                className="mt-2 rounded-lg border border-[var(--app-divider)] px-3 py-2 text-sm disabled:opacity-40"
                onClick={() => void run(async () => {
                    const result = await api.migrateCodexThread(machineId, {
                        sourceHome: sourceHome.trim(), targetHome: targetHome.trim(), threadId: threadId.trim(),
                        ...(sessionId.trim() ? { sessionId: sessionId.trim() } : {}),
                        ...(targetProvider.trim() ? { targetProvider: targetProvider.trim() } : {}),
                        ...(targetModel.trim() ? { targetModel: targetModel.trim() } : {}),
                    })
                    if (result.success) { setMigration(result.journalPath ?? null); setWarnings(result.warnings ?? []) }
                    return result
                })}>
                {t('settings.machines.codexHomesMigrateAction')}
            </button>
            {migration ? <div className="mt-2 text-xs text-[var(--app-hint)]">{t('settings.machines.codexHomesMigrated')}: {migration}</div> : null}
            {warnings.length > 0 ? <div className="mt-1 text-xs text-amber-600">{warnings.join(' · ')}</div> : null}
        </div>
        {error ? <div role="alert" className="mt-2 text-xs text-red-600">{error}</div> : null}
    </div>
}
