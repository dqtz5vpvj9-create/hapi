import { useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionSummary } from '@/types/api'
import { useCodexHomes } from '@/hooks/queries/useCodexHomes'
import { useTranslation } from '@/lib/use-translation'
import { useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'

export function CodexHomeMigrationDialog({ api, session, isOpen, onClose }: {
    api: ApiClient
    session: SessionSummary
    isOpen: boolean
    onClose: () => void
}) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const machineId = session.metadata?.machineId ?? ''
    const homes = useCodexHomes(api, machineId, isOpen)
    const sourceHome = session.metadata?.codexHome ?? session.metadata?.codexStoreId ?? ''
    const threadId = session.metadata?.codexSessionId ?? session.metadata?.agentSessionId ?? ''
    const targets = useMemo(() => (homes.data?.homes ?? []).filter(home => home.path !== sourceHome), [homes.data?.homes, sourceHome])
    const [targetHomeId, setTargetHomeId] = useState('')
    const [targetProvider, setTargetProvider] = useState('')
    const [targetModel, setTargetModel] = useState('')
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const target = targets.find(home => home.id === targetHomeId) ?? targets[0]

    useEffect(() => {
        if (isOpen && !targets.some(home => home.id === targetHomeId)) setTargetHomeId(targets[0]?.id ?? '')
    }, [isOpen, targetHomeId, targets])

    if (!isOpen) return null
    const submit = async () => {
        if (!target || !sourceHome || !threadId) return
        setPending(true); setError(null)
        try {
            const result = await api.migrateCodexThread(machineId, {
                sourceHome, targetHome: target.path, threadId, sessionId: session.id,
                ...(targetProvider.trim() ? { targetProvider: targetProvider.trim() } : {}),
                ...(targetModel.trim() ? { targetModel: targetModel.trim() } : {}),
            })
            if (!result.success) throw new Error(result.error ?? 'Migration failed')
            await queryClient.invalidateQueries({ queryKey: queryKeys.session(session.id) })
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            onClose()
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason))
        } finally { setPending(false) }
    }

    return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
        <div className="w-full max-w-lg rounded-xl border border-[var(--app-divider)] bg-[var(--app-bg)] p-4 shadow-xl">
            <h2 className="text-base font-semibold">{t('codexHomeMigration.title')}</h2>
            <p className="mt-1 text-xs text-[var(--app-hint)]">{t('codexHomeMigration.description')}</p>
            {!sourceHome || !threadId ? <p className="mt-3 text-sm text-red-600">{t('codexHomeMigration.missingBinding')}</p> : null}
            <label className="mt-3 flex flex-col gap-1 text-xs text-[var(--app-hint)]">
                <span>{t('codexHomeMigration.target')}</span>
                <select value={target?.id ?? ''} onChange={event => setTargetHomeId(event.target.value)}
                    className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm">
                    {targets.map(home => <option key={home.id} value={home.id}>{home.label} — {home.path}</option>)}
                </select>
            </label>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <input value={targetProvider} onChange={event => setTargetProvider(event.target.value)} placeholder={t('codexHomeMigration.provider')}
                    className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm" />
                <input value={targetModel} onChange={event => setTargetModel(event.target.value)} placeholder={t('codexHomeMigration.model')}
                    className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm" />
            </div>
            {error ? <div role="alert" className="mt-2 text-xs text-red-600">{error}</div> : null}
            <div className="mt-4 flex justify-end gap-2">
                <button type="button" onClick={onClose} disabled={pending}
                    className="rounded-lg border border-[var(--app-divider)] px-3 py-2 text-sm disabled:opacity-40">{t('button.cancel')}</button>
                <button type="button" onClick={() => void submit()} disabled={pending || !target || !sourceHome || !threadId}
                    className="rounded-lg bg-[var(--app-fg)] px-3 py-2 text-sm text-[var(--app-bg)] disabled:opacity-40">
                    {pending ? t('codexHomeMigration.migrating') : t('codexHomeMigration.action')}
                </button>
            </div>
        </div>
    </div>
}
