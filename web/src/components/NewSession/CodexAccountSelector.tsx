import { useState } from 'react'
import type { CodexAccountSummary } from '@/types/api'
import { SelectControl } from '@/components/ui/select-control'
import { useTranslation } from '@/lib/use-translation'

export function CodexAccountSelector(props: {
    accounts: CodexAccountSummary[]
    value: string
    currentAccountId: string | null
    isLoading: boolean
    isDisabled: boolean
    error: string | null
    onChange: (accountId: string) => void
    onImportCurrent: () => Promise<void>
    onRename: (account: CodexAccountSummary, label: string) => Promise<void>
    onDelete: (account: CodexAccountSummary) => Promise<void>
}) {
    const { t } = useTranslation()
    const [managing, setManaging] = useState(false)
    const [pending, setPending] = useState(false)

    const run = async (operation: () => Promise<void>) => {
        setPending(true)
        try { await operation() } finally { setPending(false) }
    }

    return (
        <div className="flex flex-col gap-1.5 px-3 py-3">
            <div className="flex items-center justify-between gap-3">
                <label className="text-xs font-medium text-[var(--app-hint)]">{t('newSession.codexAccount')}</label>
                <div className="flex gap-3 text-xs">
                    <button type="button" className="text-[var(--app-link)] disabled:opacity-50" disabled={pending || props.isDisabled} onClick={() => void run(props.onImportCurrent)}>
                        {t('newSession.codexAccount.importCurrent')}
                    </button>
                    {props.accounts.length ? (
                        <button type="button" className="text-[var(--app-link)]" onClick={() => setManaging(value => !value)}>
                            {managing ? t('button.done') : t('button.manage')}
                        </button>
                    ) : null}
                </div>
            </div>
            <SelectControl
                value={props.value}
                disabled={props.isDisabled || props.isLoading || pending}
                onChange={(event) => props.onChange(event.target.value)}
                className="py-2 pl-3 text-sm rounded-lg border border-[var(--app-divider)] bg-[var(--app-bg)] text-[var(--app-text)] focus:outline-none focus:ring-2 focus:ring-[var(--app-link)] disabled:opacity-50"
            >
                <option value="">{t('newSession.codexAccount.default')}</option>
                {props.accounts.map(account => (
                    <option key={account.id} value={account.id}>
                        {account.label}{account.id === props.currentAccountId ? ` · ${t('newSession.codexAccount.current')}` : ''}
                    </option>
                ))}
            </SelectControl>
            {props.error ? <div className="text-xs text-red-600">{props.error}</div> : null}
            {managing ? (
                <div className="rounded-lg border border-[var(--app-divider)]">
                    {props.accounts.map(account => (
                        <div key={account.id} className="flex items-center gap-2 border-b border-[var(--app-divider)] px-3 py-2 last:border-b-0">
                            <span className="min-w-0 flex-1 truncate text-sm">{account.label}</span>
                            <button type="button" className="text-xs text-[var(--app-link)] disabled:opacity-50" disabled={pending} onClick={() => {
                                const label = window.prompt(t('newSession.codexAccount.renamePrompt'), account.label)?.trim()
                                if (label && label !== account.label) void run(() => props.onRename(account, label))
                            }}>{t('button.rename')}</button>
                            <button type="button" className="text-xs text-red-600 disabled:opacity-50" disabled={pending} onClick={() => {
                                if (window.confirm(t('newSession.codexAccount.deleteConfirm', { label: account.label }))) void run(() => props.onDelete(account))
                            }}>{t('button.delete')}</button>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    )
}
