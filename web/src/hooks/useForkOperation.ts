import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { ApiClient } from '@/api/client'
import { createForkOperationController } from '@/lib/fork-operation'
import { usePane } from '@/workspace/PaneContext'

export function useForkOperation(api: ApiClient, sourceSessionId: string, enabled: boolean,
    navigate: (sessionId: string) => Promise<unknown>) {
    const pane = usePane()
    const navigation = useRef(navigate)
    useLayoutEffect(() => { navigation.current = navigate }, [navigate])
    const scope = api.getForkOperationScope?.()
    const controller = useMemo(() => enabled ? createForkOperationController({
        api, sourceSessionId, navigate: id => navigation.current(id),
    }) : null, [api, sourceSessionId, enabled, scope])
    const empty = useMemo(() => ({ revision: null, busy: false }), [])
    const view = useSyncExternalStore(controller?.subscribe ?? (() => () => {}), controller?.getSnapshot ?? (() => empty))
    useEffect(() => {
        if (!controller) return
        void controller.restore()
        const changed = () => controller.syncStorage()
        window.addEventListener('storage', changed)
        return () => { window.removeEventListener('storage', changed) }
    }, [controller])
    useLayoutEffect(() => {
        if (!controller) return
        const cancel = controller.cancelNavigation
        pane?.beforeHide.add(cancel)
        return () => { cancel(); pane?.beforeHide.delete(cancel) }
    }, [controller, pane?.beforeHide])
    useLayoutEffect(() => {
        if (pane && !pane.focused) controller?.cancelNavigation()
    }, [controller, pane?.focused])
    return { controller, view }
}
