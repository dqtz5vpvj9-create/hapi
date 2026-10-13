import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { usePlatform } from '@/hooks/usePlatform'
import { usePwaUpdateContext } from '@/lib/pwa-update-context'
import { useTranslation } from '@/lib/use-translation'
import { useVoiceOptional } from '@/lib/voice-context'

/** Mirrors the existing three banner predicates, for positioning only. */
export function hasNetworkStatusBanner(state: { online: boolean; hubConnected: boolean; syncing: boolean; reconnecting: boolean }): boolean {
    return (state.online && state.syncing) || state.reconnecting || (!state.online && !state.hubConnected)
}

export function PwaUpdateBanner({ topClassName, withinContent = false }: { topClassName?: string; withinContent?: boolean } = {}) {
    const { t } = useTranslation()
    const { needRefresh, reload } = usePwaUpdateContext()
    const isOnline = useOnlineStatus()
    const { haptic } = usePlatform()

    if (!needRefresh) {
        return null
    }

    const topClass = topClassName ?? (withinContent || isOnline
        ? 'top-[calc(env(safe-area-inset-top)+0.5rem)]'
        : 'top-[calc(env(safe-area-inset-top)+2.5rem)]')

    return (
        <div
            data-testid="pwa-update-banner"
            className={`${withinContent ? 'absolute' : 'fixed'} left-4 right-4 bg-[var(--app-secondary-bg)] border border-[var(--app-border)] rounded-lg p-4 shadow-lg z-50 ${topClass}`}
        >
            <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--app-fg)]">
                        {t('pwa.update.title')}
                    </p>
                    <p className="text-xs text-[var(--app-hint)] mt-0.5">
                        {t('pwa.update.body')}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => {
                        haptic.impact('light')
                        reload()
                    }}
                    className="shrink-0 px-4 py-2 bg-[var(--app-fg)] text-[var(--app-bg)] rounded-lg text-sm font-medium active:opacity-80"
                >
                    {t('pwa.update.reload')}
                </button>
            </div>

            <details className="mt-3 border-t border-[var(--app-border)] pt-2">
                <summary className="cursor-pointer text-xs text-[var(--app-link)] active:opacity-60 list-none [&::-webkit-details-marker]:hidden">
                    {t('pwa.update.whyToggle')}
                </summary>
                <p className="mt-2 text-xs text-[var(--app-hint)] leading-relaxed">
                    {t('pwa.update.whyBody')}
                </p>
            </details>
        </div>
    )
}

export function PwaUpdateBannerWithStatusOffset({
    isSyncing,
    isReconnecting,
    withinContent = false,
    networkStatusVisible = false,
}: {
    isSyncing: boolean
    isReconnecting: boolean
    withinContent?: boolean
    networkStatusVisible?: boolean
}) {
    const voice = useVoiceOptional()
    // The authenticated content area already starts below network banners.
    // Voice errors remain a viewport overlay; retain their existing clearance.
    const hasTopStatusBanner =
        (!withinContent && (isSyncing || isReconnecting)) ||
        Boolean(voice && voice.status === 'error' && voice.errorMessage)

    return (
        <PwaUpdateBanner
            withinContent={withinContent}
            topClassName={hasTopStatusBanner
                ? 'top-[calc(env(safe-area-inset-top)+3rem)]'
                : withinContent && networkStatusVisible ? 'top-2' : undefined}
        />
    )
}
