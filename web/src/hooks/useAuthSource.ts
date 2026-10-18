import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getTelegramWebApp, isTelegramEnvironment } from './useTelegram'
import { clearAccessToken, readAccessToken, storeAccessToken } from '@/lib/accessTokenStorage'
import { isNativePlatform } from '@/lib/platform'
import type { AuthSource } from './useAuth'

type SourceScope = { baseUrl: string }
type SourceState = {
    scope: SourceScope
    source: AuthSource | null
    isLoading: boolean
    isTelegram: boolean
    error: 'login.error.secureStorage' | null
}

function getTelegramInitData(): string | null {
    if (isNativePlatform()) return null
    const tg = getTelegramWebApp()
    if (tg?.initData) return tg.initData
    const query = new URLSearchParams(window.location.search)
    return query.get('tgWebAppData') || query.get('initData') || null
}

function removeUrlToken(token: string): void {
    const url = new URL(window.location.href)
    if (url.searchParams.get('token') !== token) return
    url.searchParams.delete('token')
    window.history.replaceState(window.history.state, '', url)
}

export function useAuthSource(baseUrl: string): {
    authSource: AuthSource | null
    isLoading: boolean
    isTelegram: boolean
    error: 'login.error.secureStorage' | null
    setAccessToken: (token: string) => Promise<void>
    clearAuth: () => Promise<void>
} {
    const scope = useMemo(() => ({ baseUrl }), [baseUrl])
    const scopeRef = useRef(scope)
    scopeRef.current = scope
    const revisionRef = useRef(0)
    // A direct-access link belongs to the hub selected at boot. It must never
    // be read again and assigned to another hub after a settings change.
    const directAccess = useRef<{ baseUrl: string; token: string | null } | null>(null)
    if (!directAccess.current) {
        directAccess.current = {
            baseUrl,
            token: typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('token'),
        }
    }
    const [state, setState] = useState<SourceState>({
        scope, source: null, isLoading: Boolean(baseUrl), isTelegram: false, error: null,
    })

    useEffect(() => {
        let cancelled = false
        const revision = ++revisionRef.current
        const current = () => !cancelled && scopeRef.current === scope && revisionRef.current === revision
        const update = (source: AuthSource | null, isTelegram = false, error: SourceState['error'] = null) => {
            if (current()) setState({ scope, source, isLoading: false, isTelegram, error })
        }
        let interval: ReturnType<typeof setInterval> | undefined
        setState({ scope, source: null, isLoading: Boolean(baseUrl), isTelegram: false, error: null })

        const initialize = async () => {
            // Local Capacitor assets have no hub API or credentials of their own.
            if (!baseUrl) { update(null); return }
            const initData = getTelegramInitData()
            if (initData) { update({ type: 'telegram', initData }, true); return }

            try {
                const urlToken = directAccess.current?.baseUrl === baseUrl ? directAccess.current.token : null
                if (urlToken) {
                    await storeAccessToken(baseUrl, urlToken)
                    if (!current()) return
                    directAccess.current!.token = null
                    removeUrlToken(urlToken)
                    update({ type: 'accessToken', token: urlToken })
                    return
                }
                const token = await readAccessToken(baseUrl)
                if (!current()) return
                if (token) { update({ type: 'accessToken', token }); return }
            } catch {
                update(null, false, 'login.error.secureStorage')
                return
            }

            if (isNativePlatform() || !isTelegramEnvironment()) { update(null); return }
            let retries = 0
            interval = setInterval(() => {
                retries += 1
                const initData = getTelegramInitData()
                if (initData) {
                    update({ type: 'telegram', initData }, true)
                    clearInterval(interval)
                } else if (retries >= 20) {
                    update(null)
                    clearInterval(interval)
                }
            }, 250)
        }
        void initialize()
        return () => { cancelled = true; if (interval) clearInterval(interval) }
    }, [scope, baseUrl, directAccess])

    const setAccessToken = useCallback(async (token: string) => {
        if (scopeRef.current !== scope) return
        const revision = ++revisionRef.current
        await storeAccessToken(baseUrl, token)
        if (scopeRef.current === scope && revisionRef.current === revision) {
            setState({ scope, source: { type: 'accessToken', token }, isLoading: false, isTelegram: false, error: null })
        }
    }, [scope, baseUrl])

    const clearAuth = useCallback(async () => {
        if (scopeRef.current !== scope) return
        const revision = ++revisionRef.current
        await clearAccessToken(baseUrl)
        if (scopeRef.current === scope && revisionRef.current === revision) {
            setState({ scope, source: null, isLoading: false, isTelegram: false, error: null })
        }
    }, [scope, baseUrl])

    // Effects run after render. Scope-filter the state now, before any consumer
    // can exchange a credential with the next hub.
    const current = state.scope === scope
    return {
        authSource: current ? state.source : null,
        isLoading: current ? state.isLoading : Boolean(baseUrl),
        isTelegram: current && state.isTelegram,
        error: current ? state.error : null,
        setAccessToken,
        clearAuth,
    }
}
