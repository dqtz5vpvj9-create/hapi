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
    const { needRefresh, reload, native, status, progress, error, retry } = usePwaUpdateContext()
    const isOnline = useOnlineStatus()
    const { haptic } = usePlatform()

    const appRequired = native && status === 'app-required'
    const downloading = native && status === 'downloading'
    const applying = native && status === 'applying'
    const updateError = native && (status === 'error' || Boolean(error)) && !appRequired
    if (!needRefresh && !appRequired && !downloading && !applying && !updateError) {
        return null
    }

    const topClass = topClassName ?? (withinContent || isOnline
        ? 'top-[calc(env(safe-area-inset-top)+0.5rem)]'
        : 'top-[calc(env(safe-area-inset-top)+2.5rem)]')

    return (
        <div
            data-testid="pwa-update-banner"
            role="status"
            className={`${withinContent ? 'absolute' : 'fixed'} left-4 right-4 bg-[var(--app-secondary-bg)] border border-[var(--app-border)] rounded-lg p-4 shadow-lg z-50 ${topClass}`}
        >
            <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--app-fg)]">
                        {t(appRequired ? 'native.update.appTitle'
                            : updateError ? 'native.update.errorTitle'
                                : downloading ? 'native.update.downloading'
                                    : 'pwa.update.title')}
                    </p>
                    <p className="text-xs text-[var(--app-hint)] mt-0.5">
                        {t(appRequired ? 'native.update.appBody'
                            : updateError ? 'native.update.errorBody'
                                : applying ? 'native.update.applying'
                                    : native ? 'native.update.body' : 'pwa.update.body')}
                    </p>
                    {downloading && (
                        <progress
                            aria-label={t('native.update.downloading')}
                            className="mt-2 w-full h-1.5"
                            max={1}
                            value={progress ?? undefined}
                        />
                    )}
                </div>
                {!appRequired && <button
                    type="button"
                    disabled={Boolean(downloading || applying)}
                    onClick={() => {
                        haptic.impact('light')
                        if (updateError && !needRefresh) retry?.()
                        else reload()
                    }}
                    className="shrink-0 px-4 py-2 bg-[var(--app-fg)] text-[var(--app-bg)] rounded-lg text-sm font-medium active:opacity-80 disabled:opacity-50 disabled:cursor-wait"
                >
                    {t(applying ? 'native.update.applying'
                        : updateError && !needRefresh ? 'native.update.retry'
                            : native ? 'native.update.action' : 'pwa.update.reload')}
                </button>}
            </div>

            <details className="mt-3 border-t border-[var(--app-border)] pt-2">
                <summary className="cursor-pointer text-xs text-[var(--app-link)] active:opacity-60 list-none [&::-webkit-details-marker]:hidden">
                    {t(native ? 'native.update.details' : 'pwa.update.whyToggle')}
                </summary>
                <p className="mt-2 text-xs text-[var(--app-hint)] leading-relaxed">
                    {t(native ? 'native.update.whyBody' : 'pwa.update.whyBody')}
                </p>
                {native && error && <p className="mt-2 text-xs text-[var(--app-hint)] break-words">{error}</p>}
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
