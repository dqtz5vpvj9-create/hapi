import { useCallback, useEffect, useRef, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'
import { isBundledNativePlatform } from '@/lib/platform'

export const PWA_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000
export const PWA_UPDATE_RELOAD_FALLBACK_MS = 2000

export async function requestPwaUpdateReload(
    updateSW: ((reloadPage?: boolean) => Promise<void>) | null | undefined,
    options: {
        reloadPage?: () => void
        setTimeoutFn?: typeof setTimeout
        clearTimeoutFn?: typeof clearTimeout
    } = {},
): Promise<void> {
    const reloadPage = options.reloadPage ?? (() => window.location.reload())
    const setTimeoutFn = options.setTimeoutFn ?? setTimeout
    const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout

    if (!updateSW) {
        reloadPage()
        return
    }

    let reloaded = false
    const doReload = () => {
        if (reloaded) {
            return
        }
        reloaded = true
        reloadPage()
    }

    const onControllerChange = () => {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
        doReload()
    }

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    let fallbackTimer: ReturnType<typeof setTimeout> | undefined

    try {
        await updateSW(true)
    } catch (error) {
        console.error('PWA update failed', error)
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
        if (fallbackTimer !== undefined) {
            clearTimeoutFn(fallbackTimer)
        }
        doReload()
        return
    }

    fallbackTimer = setTimeoutFn(() => {
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
        doReload()
    }, PWA_UPDATE_RELOAD_FALLBACK_MS)
}

export function setupRegistrationUpdateChecks(
    registration: ServiceWorkerRegistration,
): () => void {
    const intervalId = window.setInterval(() => {
        void registration.update()
    }, PWA_UPDATE_CHECK_INTERVAL_MS)

    const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
            void registration.update()
        }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
        window.clearInterval(intervalId)
        document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
}

export function usePwaUpdate() {
    const [needRefresh, setNeedRefresh] = useState(false)
    const updateSWRef = useRef<((reloadPage?: boolean) => Promise<void>) | null>(null)
    const cleanupRef = useRef<(() => void) | null>(null)

    useEffect(() => {
        // Native application updates replace the bundled assets. A service worker
        // would introduce a second cache that could keep the previous app version.
        if (isBundledNativePlatform()) return

        const updateSW = registerSW({
            onNeedRefresh() {
                setNeedRefresh(true)
            },
            onOfflineReady() {
                console.log('App ready for offline use')
            },
            onRegistered(registration) {
                cleanupRef.current?.()
                cleanupRef.current = null

                if (!registration) {
                    return
                }

                cleanupRef.current = setupRegistrationUpdateChecks(registration)
            },
            onRegisterError(error) {
                console.error('SW registration error:', error)
            },
        })

        updateSWRef.current = updateSW

        return () => {
            cleanupRef.current?.()
            cleanupRef.current = null
            updateSWRef.current = null
        }
    }, [])

    // 中文注释：等待中的版本只在页面切到后台后才自动应用。前台有正在流的回合时
    // 保持旧页面不打断，但离开页面（锁屏、切 App）再回来就一定是最新版本。
    useEffect(() => {
        if (!needRefresh) return
        let timer: ReturnType<typeof setTimeout> | undefined
        const applyWhenHidden = () => {
            if (document.visibilityState !== 'hidden' || timer !== undefined) return
            timer = setTimeout(() => {
                timer = undefined
                void requestPwaUpdateReload(updateSWRef.current)
            }, 5000)
        }
        const cancelWhenVisible = () => {
            if (document.visibilityState === 'visible' && timer !== undefined) {
                clearTimeout(timer)
                timer = undefined
            }
        }
        document.addEventListener('visibilitychange', applyWhenHidden)
        document.addEventListener('visibilitychange', cancelWhenVisible)
        return () => {
            if (timer !== undefined) clearTimeout(timer)
            document.removeEventListener('visibilitychange', applyWhenHidden)
            document.removeEventListener('visibilitychange', cancelWhenVisible)
        }
    }, [needRefresh])

    const reload = useCallback(() => {
        void requestPwaUpdateReload(updateSWRef.current)
    }, [])

    return { needRefresh, reload }
}
