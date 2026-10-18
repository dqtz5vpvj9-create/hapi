import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { NativeUpdateController } from '@/lib/nativeUpdate'
import { prepareNativeUpdateReload } from '@/lib/nativeUpdateReload'

export const NATIVE_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

export function useNativeUpdate() {
    const [controller] = useState(() => new NativeUpdateController())
    const lifecycle = useRef(0)
    const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [controller])
    const getSnapshot = useCallback(() => controller.getSnapshot(), [controller])
    const state = useSyncExternalStore(subscribe, getSnapshot)

    useEffect(() => {
        const generation = ++lifecycle.current
        let mounted = true
        const check = () => { void controller.check().catch(() => {}) }

        // A mounted shell is ready even while offline or awaiting Hub login.
        // Confirm startup before requesting the independent update feed.
        void controller.initialize().then(() => {
            if (mounted) check()
        }).catch(() => {})

        const interval = window.setInterval(check, NATIVE_UPDATE_CHECK_INTERVAL_MS)
        const onVisible = () => {
            if (document.visibilityState === 'visible') check()
        }
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('online', check)

        return () => {
            mounted = false
            window.clearInterval(interval)
            document.removeEventListener('visibilitychange', onVisible)
            window.removeEventListener('online', check)
            // StrictMode immediately remounts the same effect. Dispose only
            // after a real unmount, so its development probe cannot disable OTA.
            queueMicrotask(() => {
                if (lifecycle.current === generation) controller.dispose()
            })
        }
    }, [controller])

    const reload = useCallback(() => {
        void controller.apply(prepareNativeUpdateReload).catch(() => {})
    }, [controller])
    const retry = useCallback(() => {
        void controller.check().catch(() => {})
    }, [controller])

    return { ...state, native: true as const, reload, retry }
}
