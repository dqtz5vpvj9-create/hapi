type PrepareUpdate = () => void | Promise<void>
const preparations = new Set<PrepareUpdate>()
const ROUTE_KEY = 'hapi:native-update-route'
const ROUTE_MAX_AGE_MS = 5 * 60 * 1000
let routeRestored = false

export function wasNativeUpdateRouteRestored(): boolean {
    return routeRestored
}

/** Mounted editors can finish durable draft writes before the WebView is replaced. */
export function registerNativeUpdatePreparation(prepare: PrepareUpdate): () => void {
    preparations.add(prepare)
    return () => { preparations.delete(prepare) }
}

export async function prepareNativeUpdateReload(): Promise<void> {
    // A fresh attempt can save editor snapshots and then fail. Those snapshots
    // must not be consumed by a normal remount in this same document.
    routeRestored = false
    await Promise.all([...preparations].map(prepare => prepare()))
    const path = window.location.pathname + window.location.search + window.location.hash
    // Keep the existing origin, including its authentication and draft stores.
    // A denied storage write aborts activation instead of claiming state was saved.
    sessionStorage.setItem(ROUTE_KEY, JSON.stringify({ path, savedAt: Date.now() }))
}

/** Capacitor may reload at / after changing its asset directory. Restore only a local, recent route. */
export function restoreNativeUpdateRoute(): void {
    routeRestored = false
    try {
        const stored = sessionStorage.getItem(ROUTE_KEY)
        sessionStorage.removeItem(ROUTE_KEY)
        if (!stored) return
        const record: unknown = JSON.parse(stored)
        if (!record || typeof record !== 'object') return
        const { path, savedAt } = record as { path?: unknown; savedAt?: unknown }
        if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
            || /[\\\u0000-\u001f]/.test(path) || typeof savedAt !== 'number'
            || !Number.isFinite(savedAt) || savedAt > Date.now() || Date.now() - savedAt > ROUTE_MAX_AGE_MS) return
        window.history.replaceState(null, '', path)
        routeRestored = true
    } catch {
        // A damaged route hint must not prevent the installed bundle from starting.
    }
}
