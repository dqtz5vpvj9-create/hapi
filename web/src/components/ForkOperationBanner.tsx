import { useState } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import type { ForkCloseConfirmation, ForkOperationController, ForkOperationView, ForkRiskConfirmation } from '@/lib/fork-operation'
import { useTranslation } from '@/lib/use-translation'

export function ForkOperationBanner({ controller, view, sourceActive = true }: { controller: ForkOperationController; view: ForkOperationView; sourceActive?: boolean }) {
    const { t } = useTranslation()
    const [risk, setRisk] = useState<{ controller: ForkOperationController; confirmation: ForkRiskConfirmation } | null>(null)
    const [closeRequest, setCloseRequest] = useState<{ controller: ForkOperationController; confirmation: ForkCloseConfirmation } | null>(null)
    const operation = view.operation
    if (!view.intent && !operation && !view.error && !view.blockingSourceSessionId && !view.closure) return null
    const ready = operation?.status === 'created' && operation.binding === 'ready'
    const known = operation?.status === 'created' && !ready
    const rejected = operation?.status === 'rejected'
    const terminalUnresolved = rejected && operation.code === 'fork_source_unresolved'
    const operationId = view.intent?.operationId ?? operation?.operationId
    const canSendOriginal = view.notObserved === true && !!view.intent && !operation && !view.blockingSourceSessionId
    const canActOnUnknown = sourceActive && view.sourceStateVerified === true && operation?.status === 'indeterminate' && view.revision !== null
        && view.sourceHeadId === operation.operationId && !view.blockingSourceSessionId
    const status = terminalUnresolved ? 'terminalUnresolved' : view.blockingSourceSessionId ? 'blockedSource' : !operationId ? 'unavailable' : canSendOriginal ? 'notObserved' : ready ? 'ready' : known ? 'binding' : rejected ? 'rejected'
        : operation?.status === 'running' ? 'running' : 'unknown'
    // GlassChrome notices float over the scrolling thread. Use an opaque
    // surface, not app-subtle-bg's translucent tint, so history cannot bleed
    // through the diagnostics. GlassScene measures the full natural height.
    return <div role="status" data-testid="fork-operation-banner" className="mx-auto w-full max-w-content rounded-lg border border-[var(--app-border)] bg-[var(--app-dialog-bg)] px-3 py-2 text-sm text-[var(--app-fg)] break-words">
        <p>{t(`fork.operation.${status}`)}</p>
        {operation?.status === 'indeterminate' ? <p className="mt-1 text-[var(--app-hint)]">{t('fork.operation.fenced')}</p> : null}
        {view.existingRequest ? <p className="mt-1 text-[var(--app-hint)]">{t('fork.operation.existing')}</p> : null}
        {!sourceActive && operationId && !ready && !rejected ? <p className="mt-1 text-[var(--app-hint)]">{t('fork.operation.reconnect')}</p> : null}
        {operationId ? <p className="mt-1 break-all text-xs text-[var(--app-hint)] select-text">{t('fork.operation.id')}: {operationId}</p> : null}
        {view.sourceMessage ? <p className="mt-1 text-[var(--app-hint)]">{view.sourceMessage}</p> : null}
        {operation?.message ? <p className="mt-1 text-[var(--app-hint)]">{operation.message}</p> : null}
        {view.closure ? <div data-testid="fork-close-result" className="mt-2 border-t border-[var(--app-border)] pt-2">
            <p>{t(`fork.operation.closeResult.${view.closure.result}`)}</p>
            <p className="mt-1 break-all text-xs text-[var(--app-hint)] select-text">{t('fork.operation.closeTarget')}: {view.closure.operationId}</p>
            {view.closure.message ? <p className="mt-1 text-[var(--app-hint)]">{view.closure.message}</p> : null}
        </div> : null}
        {view.error ? <p role="alert" className="mt-1 text-[var(--app-danger)]">{view.error}</p> : null}
        <div className="mt-2 flex flex-wrap gap-3">
            <button type="button" disabled={view.busy} onClick={() => void controller.check()} className="underline disabled:opacity-50">
                {view.busy ? t('fork.operation.checking') : t('fork.operation.check')}
            </button>
            {view.blockingSourceSessionId ? <button type="button" disabled={view.busy} onClick={() => void controller.openOriginalSource()} className="underline disabled:opacity-50">
                {t('fork.operation.openOriginalSource')}
            </button> : null}
            {canSendOriginal ? <button type="button" disabled={view.busy} onClick={() => void controller.sendOriginal()} className="underline disabled:opacity-50">
                {t('fork.operation.sendOriginal')}
            </button> : null}
            {canActOnUnknown ? <button type="button" disabled={view.busy} onClick={() => setRisk({ controller,
                confirmation: { operationId: operation.operationId, revision: view.revision! } })} className="underline disabled:opacity-50">
                {t('fork.operation.createAnother')}
            </button> : null}
            {canActOnUnknown ? <button type="button" disabled={view.busy} onClick={() => setCloseRequest({ controller,
                confirmation: { operationId: operation.operationId, revision: view.revision! } })} className="underline disabled:opacity-50">
                {t('fork.operation.closeUnadmitted')}
            </button> : null}
            {known ? <button type="button" disabled={view.busy} onClick={() => void controller.reconcile()} className="underline disabled:opacity-50">
                {t('fork.operation.recover')}
            </button> : null}
            {ready ? <button type="button" disabled={view.busy} onClick={() => void controller.open()} className="underline disabled:opacity-50">
                {t('fork.operation.open')}
            </button> : null}
            {view.busy ? <button type="button" onClick={controller.cancelNavigation} className="underline">
                {t('fork.operation.stay')}
            </button> : null}
        </div>
        {(ready || rejected) && !terminalUnresolved ? <p className="mt-1 text-[var(--app-hint)]">{t('fork.operation.fresh')}</p> : null}
        <ConfirmDialog isOpen={risk !== null} onClose={() => setRisk(null)} title={t('fork.operation.riskTitle')}
            description={`${t('fork.operation.riskWarning')}\n\n${t('fork.operation.id')}: ${risk?.confirmation.operationId ?? ''}`}
            confirmLabel={t('fork.operation.createAnother')} confirmingLabel={t('fork.operation.creatingAnother')}
            onConfirm={async () => { if (risk) await risk.controller.createAnother(risk.confirmation) }}
            isPending={view.busy} destructive />
        <ConfirmDialog isOpen={closeRequest !== null} onClose={() => setCloseRequest(null)} title={t('fork.operation.closeTitle')}
            description={`${t('fork.operation.closeWarning')}\n\n${t('fork.operation.id')}: ${closeRequest?.confirmation.operationId ?? ''}`}
            confirmLabel={t('fork.operation.closeUnadmitted')} confirmingLabel={t('fork.operation.closing')}
            onConfirm={async () => { if (closeRequest) await closeRequest.controller.closeUnadmitted(closeRequest.confirmation) }}
            isPending={view.busy} destructive />
    </div>
}
