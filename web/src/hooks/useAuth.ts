import { disconnectSessionReadSync } from '@/lib/sessionLastSeen'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiClient, ApiError } from '@/api/client'
import type { AuthResponse } from '@/types/api'
import { storeAccessToken } from '@/lib/accessTokenStorage'

export type AuthSource =
    | { type: 'telegram'; initData: string }
    | { type: 'accessToken'; token: string }

function decodeJwtExpMs(token: string): number | null {
    const parts = token.split('.')
    if (parts.length < 2) return null

    const payloadBase64Url = parts[1] ?? ''
    const payloadBase64 = payloadBase64Url
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(payloadBase64Url.length / 4) * 4, '=')

    try {
        const decoded = globalThis.atob(payloadBase64)
        const payload = JSON.parse(decoded) as { exp?: unknown }
        if (typeof payload.exp !== 'number') return null
        return payload.exp * 1000
    } catch {
        return null
    }
}

function getAuthPayload(source: AuthSource): { initData: string } | { accessToken: string } {
    if (source.type === 'telegram') {
        return { initData: source.initData }
    }
    return { accessToken: source.token }
}

function isNotBoundError(error: unknown): boolean {
    return error instanceof ApiError && error.status === 401 && error.code === 'not_bound'
}

type AuthScope = { baseUrl: string; source: AuthSource | null }
type AuthState = {
    scope: AuthScope
    token: string | null
    user: AuthResponse['user'] | null
    isLoading: boolean
    error: string | null
    needsBinding: boolean
}

function emptyAuth(scope: AuthScope): AuthState {
    return { scope, token: null, user: null, isLoading: Boolean(scope.source), error: null, needsBinding: false }
}

export function useAuth(authSource: AuthSource | null, baseUrl: string): {
    token: string | null
    user: AuthResponse['user'] | null
    api: ApiClient | null
    isLoading: boolean
    error: string | null
    needsBinding: boolean
    bind: (accessToken: string) => Promise<void>
} {
    const scope = useMemo(() => ({ baseUrl, source: authSource }), [baseUrl, authSource])
    const scopeRef = useRef(scope)
    scopeRef.current = scope
    const mountedRef = useRef(true)
    const [stored, setStored] = useState(() => emptyAuth(scope))
    // A hub/account switch invalidates the public state during render, before
    // effects and network consumers can observe a new URL with an old JWT.
    const state = stored.scope === scope ? stored : emptyAuth(scope)
    const { token, user, isLoading, error, needsBinding } = state
    const tokenRef = useRef(token)
    tokenRef.current = token
    const refreshState = useMemo(() => ({
        promise: null as Promise<string | null> | null,
        lastAttempt: 0,
    }), [scope])

    useEffect(() => {
        mountedRef.current = true
        return () => { mountedRef.current = false; tokenRef.current = null }
    }, [])

    const isCurrent = useCallback(() => mountedRef.current && scopeRef.current === scope, [scope])
    const publish = useCallback((patch: Partial<Omit<AuthState, 'scope'>>) => {
        if (!isCurrent()) return
        setStored(previous => ({ ...(previous.scope === scope ? previous : emptyAuth(scope)), ...patch, scope }))
    }, [scope, isCurrent])

    const refreshAuth = useCallback(async (options?: {
        minTtlMs?: number
        hardFail?: boolean
        force?: boolean
    }): Promise<string | null> => {
        const source = scope.source
        if (!isCurrent() || !source || !scope.baseUrl) return null
        const currentToken = tokenRef.current
        const expMs = currentToken ? decodeJwtExpMs(currentToken) : null
        const minTtlMs = options?.minTtlMs ?? 0
        const now = Date.now()
        const ttlMs = expMs ? expMs - now : null
        const needsRefreshForTtl = ttlMs !== null && ttlMs <= minTtlMs
        if (!options?.force && ttlMs !== null && ttlMs > minTtlMs) return currentToken
        if (!options?.force && !needsRefreshForTtl && now - refreshState.lastAttempt < 15_000) return currentToken
        if (refreshState.promise) return await refreshState.promise

        const run = async () => {
            refreshState.lastAttempt = now
            try {
                const client = new ApiClient('', { baseUrl: scope.baseUrl })
                const auth = await client.authenticate(getAuthPayload(source))
                if (!isCurrent()) return null
                tokenRef.current = auth.token
                publish({ token: auth.token, user: auth.user, error: null, needsBinding: false })
                return auth.token
            } catch (error) {
                if (!isCurrent()) return null
                if (source.type === 'telegram' && isNotBoundError(error)) {
                    tokenRef.current = null
                    publish({ token: null, user: null, error: null, needsBinding: true })
                    return null
                }
                if (options?.hardFail || (expMs !== null && Date.now() >= expMs)) {
                    tokenRef.current = null
                    publish({ token: null, user: null, error: source.type === 'telegram'
                        ? 'Session expired. Reopen the Mini App from Telegram.'
                        : 'Session expired. Please login again.' })
                }
                return null
            }
        }
        const pending = run()
        refreshState.promise = pending
        try { return await pending } finally {
            if (refreshState.promise === pending) refreshState.promise = null
        }
    }, [scope, refreshState, isCurrent, publish])

    const bind = useCallback(async (accessToken: string) => {
        if (!isCurrent()) return
        const source = scope.source
        if (!source || source.type !== 'telegram') {
            publish({ error: 'Binding is only supported in Telegram.' })
            return
        }
        publish({ isLoading: true, error: null })
        try {
            const client = new ApiClient('', { baseUrl: scope.baseUrl })
            const auth = await client.bind({ initData: source.initData, accessToken })
            if (!isCurrent()) return
            await storeAccessToken(scope.baseUrl, accessToken)
            if (!isCurrent()) return
            tokenRef.current = auth.token
            publish({ token: auth.token, user: auth.user, needsBinding: false })
        } catch (error) {
            if (!isCurrent()) return
            publish({ error: error instanceof Error ? error.message : 'Binding failed' })
            throw error
        } finally {
            publish({ isLoading: false })
        }
    }, [scope, isCurrent, publish])

    // Refreshes for the same account keep the ApiClient stable. A previous
    // lifetime's callbacks must never read credentials from the current scope.
    let authIdentity = ''
    if (token) {
        try {
            const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
            authIdentity = JSON.stringify([payload.ns, payload.uid])
        } catch { /* Placeholder tokens have no identity in tests. */ }
    }
    const hasToken = token !== null
    const api = useMemo(() => hasToken ? new ApiClient(tokenRef.current ?? '', {
        baseUrl: scope.baseUrl,
        getToken: () => isCurrent() ? tokenRef.current : null,
        onUnauthorized: () => refreshAuth({ force: true }),
    }) : null, [scope, isCurrent, refreshAuth, hasToken, authIdentity])

    useEffect(() => { if (!hasToken) disconnectSessionReadSync() }, [hasToken])

    useEffect(() => {
        let cancelled = false
        const source = scope.source
        if (!source || !scope.baseUrl) {
            publish({ token: null, user: null, isLoading: false, needsBinding: false, error: null })
            return
        }
        const run = async () => {
            publish({ isLoading: true, error: null, needsBinding: false })
            try {
                const client = new ApiClient('', { baseUrl: scope.baseUrl })
                const auth = await client.authenticate(getAuthPayload(source))
                if (cancelled || !isCurrent()) return
                tokenRef.current = auth.token
                publish({ token: auth.token, user: auth.user, needsBinding: false })
            } catch (error) {
                if (cancelled || !isCurrent()) return
                if (source.type === 'telegram' && isNotBoundError(error)) {
                    publish({ token: null, user: null, error: null, needsBinding: true })
                } else {
                    publish({ needsBinding: false, error: error instanceof Error ? error.message : 'Auth failed' })
                }
            } finally {
                if (!cancelled) publish({ isLoading: false })
            }
        }
        void run()
        return () => { cancelled = true }
    }, [scope, isCurrent, publish])

    useEffect(() => {
        if (!token || !authSource) return
        const expMs = decodeJwtExpMs(token)
        if (!expMs) return
        let cancelled = false
        let timeout: ReturnType<typeof setTimeout> | undefined
        const schedule = (delayMs: number) => {
            if (timeout) clearTimeout(timeout)
            timeout = setTimeout(() => void refresh(), Math.max(0, delayMs))
        }
        const refresh = async () => {
            if (cancelled) return
            const refreshed = await refreshAuth({ force: true })
            if (!cancelled && !refreshed && Date.now() < expMs) schedule(15_000)
        }
        schedule(expMs - 60_000 - Date.now())
        return () => { cancelled = true; if (timeout) clearTimeout(timeout) }
    }, [authSource, refreshAuth, token])

    useEffect(() => {
        if (!authSource) return
        const handleActive = () => { void refreshAuth({ minTtlMs: 60_000 }) }
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') handleActive()
        }
        window.addEventListener('focus', handleActive)
        document.addEventListener('visibilitychange', handleVisibilityChange)
        return () => {
            window.removeEventListener('focus', handleActive)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [authSource, refreshAuth])

    return { token, user, api, isLoading, error, needsBinding, bind }
}
