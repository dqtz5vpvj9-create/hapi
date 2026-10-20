import { CodexDeviceLogin } from '@/components/CodexDeviceLogin'
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { useCodexAccounts } from '@/hooks/queries/useCodexAccounts'
import { queryKeys } from '@/lib/query-keys'
import { useTranslation } from '@/lib/use-translation'
import { SelectControl } from '@/components/ui/select-control'

export function CodexAccountSwitcher(props: {
    api: ApiClient
    machineId: string
    sessionId: string
    activeAccountId?: string
    activeAccountLabel?: string
    disabled?: boolean
}) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const accounts = useCodexAccounts(props.api, props.machineId)
    const [selected, setSelected] = useState(props.activeAccountId ?? '')
    const [pending, setPending] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => setSelected(props.activeAccountId ?? ''), [props.activeAccountId])

    const switchAccount = async () => {
        if (!selected || selected === props.activeAccountId) return
        setPending(true)
        setError(null)
        try {
            const result = await props.api.switchSessionCodexAccount(props.sessionId, selected)
            if (!result.success) throw new Error(result.error || t('session.status.codexAccount.switchFailed'))
            await queryClient.invalidateQueries({ queryKey: queryKeys.session(props.sessionId) })
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t('session.status.codexAccount.switchFailed'))
        } finally {
            setPending(false)
        }
    }

    return (
        <section className="min-w-0">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                {t('session.status.codexAccount')}
            </h3>
            <div className="flex items-center gap-2">
                <SelectControl
                    value={selected}
                    disabled={props.disabled || pending || accounts.isLoading}
                    onChange={event => setSelected(event.target.value)}
                    className="min-w-0 flex-1 rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] px-2 py-1.5 text-xs text-[var(--app-text)] disabled:opacity-50"
                >
                    {!props.activeAccountId ? <option value="">{props.activeAccountLabel ?? t('newSession.codexAccount.default')}</option> : null}
                    {(accounts.data?.accounts ?? []).map(account => <option key={account.id} value={account.id}>{account.label}</option>)}
                </SelectControl>
                <button
                    type="button"
                    className="rounded-md border border-[var(--app-divider)] px-2 py-1.5 text-xs text-[var(--app-link)] disabled:opacity-40"
                    disabled={props.disabled || pending || !selected || selected === props.activeAccountId}
                    onClick={() => void switchAccount()}
                >
                    {pending ? t('session.status.codexAccount.switching') : t('session.status.codexAccount.switch')}
                </button>
            </div>
            <CodexDeviceLogin key={props.machineId} api={props.api} machineId={props.machineId} onComplete={account => setSelected(account.id)} />
            {props.disabled ? <div className="mt-1 text-[11px] text-[var(--app-hint)]">{t('session.status.codexAccount.wait')}</div> : null}
            {error || accounts.error ? <div className="mt-1 text-[11px] text-red-600">{error ?? (accounts.error as Error).message}</div> : null}
        </section>
    )
}
