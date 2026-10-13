import type { NativeRuntimeState } from '@hapi/protocol/schemas'
import { useEffect, useState } from 'react'
import { useTranslation } from '@/lib/use-translation'

/** Display timer only. Exactly one bridge owns continuation requests. */
export function CapacityNotice({ active, execution, onCancel, cancelDisabled }: {
    active: boolean
    execution?: NativeRuntimeState | null
    onCancel?: () => void
    cancelDisabled?: boolean
}) {
    const { t } = useTranslation()
    const [now, setNow] = useState(Date.now)
    const recovery = execution?.capacityRecovery
    useEffect(() => {
        if (recovery?.phase !== 'waiting') return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 1_000)
        return () => clearInterval(timer)
    }, [recovery?.phase, recovery?.retryAt])
    if (!active || !recovery || recovery.turnId !== execution.turnId
        || !['active', 'systemError'].includes(execution.status)) return null
    if (recovery.phase === 'retrying' && execution.status !== 'active') return null
    const seconds = Math.max(0, Math.ceil(((recovery.retryAt ?? now) - now) / 1_000))
    const description = recovery.phase === 'waiting'
        ? seconds > 0 ? t('codex.capacity.waiting', { seconds, attempt: recovery.attempt ?? 1, max: recovery.maxAttempts ?? 5 })
            : t('codex.capacity.checking')
        : t(`codex.capacity.${recovery.phase === 'failed' && recovery.reason ? recovery.reason : recovery.phase}`)
    return <div role="status" aria-live="polite" data-capacity-state={recovery.phase}
        className="mb-2 rounded-xl border border-[var(--app-divider)] bg-[var(--app-subtle-bg)] px-3 py-2 text-sm text-[var(--app-fg)]">
        <div className="font-medium">{t('codex.capacity.title')}</div>
        <div className="mt-1 text-[var(--app-hint)]">{description}</div>
        {(recovery.phase === 'waiting' || recovery.phase === 'continuing') && onCancel ?
            <button type="button" disabled={cancelDisabled} onClick={onCancel}
                className="mt-2 min-h-11 rounded-lg border border-[var(--app-divider)] px-3 disabled:opacity-50">
                {t('codex.capacity.cancel')}
            </button> : null}
    </div>
}
