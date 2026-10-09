import { useTranslation } from '@/lib/use-translation'

/** Contextual help only: never launches an agent or changes authentication. */
export function RunnerSetupHint() {
    const { t } = useTranslation()
    return (
        <section className="px-3 py-3 text-sm" aria-label={t('setup.title')}>
            <p className="font-medium">{t('setup.title')}</p>
            <p className="mt-1 text-[var(--app-hint)]">{t('setup.description')}</p>
            <ol className="mt-2 list-decimal space-y-2 pl-5">
                <li>{t('setup.hubReady')}</li>
                <li>{t('setup.runner')} <code className="select-all">hapi auth login</code>{' → '}<code className="select-all">hapi runner start</code></li>
                <li>{t('setup.agent')}</li>
            </ol>
            <details className="mt-2 text-[var(--app-hint)]">
                <summary className="cursor-pointer">{t('setup.troubleshoot')}</summary>
                <p className="mt-1">{t('setup.remoteHint')}</p>
                <p className="mt-1"><code>hapi runner status</code>{' · '}<code>hapi doctor</code></p>
            </details>
        </section>
    )
}
