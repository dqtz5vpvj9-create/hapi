import { isFastServiceTier } from './AssistantChat/codexFastMode'
import { useTranslation } from '@/lib/use-translation'

/** Only confirmed tier values describe this session, never its model name or activity. */
export function SessionServiceTier({ flavor, serviceTier }: {
    flavor?: string | null
    serviceTier?: string | null
}) {
    const { t } = useTranslation()
    if (flavor !== 'codex' || !isFastServiceTier(serviceTier)) return null
    const label = t('misc.fastModeFast')
    const description = `${t('misc.fastMode')}: ${label}`
    return <span className="app-session-service-tier inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-xs text-[var(--app-fg)]"
        data-service-tier="fast" title={description} aria-label={description}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
            <path d="M13 2 4 14h7l-1 8 10-13h-7l1-7Z" />
        </svg>
    </span>
}
