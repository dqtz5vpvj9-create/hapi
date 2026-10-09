import { createContext, useCallback, useContext, useRef, useLayoutEffect, type ReactNode, type RefObject } from 'react'
import { useNavigate } from '@tanstack/react-router'

/** Local presentation ownership. A pane never owns the agent's lifetime. */
export type PaneContextValue = {
    paneId: string
    sessionId: string
    headerTarget?: HTMLElement | null
    menuItems?: (close: () => void) => ReactNode
    focused: boolean
    root: RefObject<HTMLElement | null>
    navigate: ReturnType<typeof useNavigate>
    beforeHide: Set<() => void>
    editing?: Set<() => boolean>
}

export const PaneContext = createContext<PaneContextValue | null>(null)
export const usePane = () => useContext(PaneContext)

/** Remote layout changes must not unmount an editor with local input or an in-flight action. */
export function usePaneEditing(dirty: boolean) {
    const pane = usePane()
    const current = useRef(dirty)
    current.current = dirty
    useLayoutEffect(() => {
        const read = () => current.current
        pane?.editing?.add(read)
        return () => { pane?.editing?.delete(read) }
    }, [pane?.editing])
}

/** Async results keep the initiating pane binding; never replace a later chat. */
export function usePaneNavigate(): ReturnType<typeof useNavigate> {
    const routeNavigate = useNavigate()
    const pane = usePane()
    const current = useRef(pane)
    current.current = pane
    useLayoutEffect(() => { current.current = pane; return () => { current.current = null } }, [pane])
    return useCallback((options) => {
        if (!pane) return routeNavigate(options)
        if (current.current?.paneId !== pane.paneId || current.current?.sessionId !== pane.sessionId) return Promise.resolve()
        return pane.navigate(options)
    }, [pane?.paneId, pane?.sessionId, pane?.navigate, routeNavigate])
}
