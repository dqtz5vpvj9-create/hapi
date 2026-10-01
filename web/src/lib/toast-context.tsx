import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient, type Query } from '@tanstack/react-query'
import type { SessionResponse, SessionsResponse } from '@/types/api'
import { randomId } from '@/lib/randomId'

export type Toast = {
    id: string
    title: string
    body: string
    sessionId: string
    url: string
    kind?: 'ready'
}

export type ToastContextValue = {
    toasts: Toast[]
    addToast: (toast: Omit<Toast, 'id'>) => void
    removeToast: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)
const TOAST_DURATION_MS = 6000

function createToastId(): string {
    return randomId()
}

export function ToastProvider({ children }: { children: ReactNode }) {
    const queryClient = useQueryClient()
    const thinkingRef = useRef(new Map<string, boolean>())
    const [toasts, setToasts] = useState<Toast[]>([])
    const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

    useEffect(() => {
        const sync = (query: Query) => {
            const key = query.queryKey[0]
            const sessions = key === 'sessions'
                ? (query.state.data as SessionsResponse | undefined)?.sessions
                : key === 'session' ? [(query.state.data as SessionResponse | undefined)?.session] : []
            for (const session of sessions ?? []) {
                if (!session || thinkingRef.current.get(session.id) === session.thinking) continue
                thinkingRef.current.set(session.id, session.thinking)
                if (session.thinking) {
                    setToasts(current => current.filter(toast => toast.sessionId !== session.id || toast.kind !== 'ready'))
                }
            }
        }
        const cache = queryClient.getQueryCache()
        for (const query of cache.getAll()) sync(query)
        return cache.subscribe(event => {
            // Observe accepted SSE/REST cache data synchronously. A late ready
            // event in the same SSE stream must see the new running state.
            if (event.type === 'updated' && event.action.type === 'success') sync(event.query)
            if (event.type === 'removed' && event.query.queryKey[0] === 'sessions') thinkingRef.current.clear()
        })
    }, [queryClient])

    useEffect(() => {
        return () => {
            for (const timer of timersRef.current.values()) {
                clearTimeout(timer)
            }
            timersRef.current.clear()
        }
    }, [])

    const removeToast = useCallback((id: string) => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id))
        const timer = timersRef.current.get(id)
        if (timer) {
            clearTimeout(timer)
            timersRef.current.delete(id)
        }
    }, [])

    const addToast = useCallback((toast: Omit<Toast, 'id'>) => {
        if (toast.kind === 'ready' && thinkingRef.current.get(toast.sessionId)) return
        const id = createToastId()
        setToasts((prev) => [...prev, { id, ...toast }])
        const timer = setTimeout(() => {
            removeToast(id)
        }, TOAST_DURATION_MS)
        timersRef.current.set(id, timer)
    }, [removeToast])

    const value = useMemo<ToastContextValue>(() => ({
        toasts,
        addToast,
        removeToast
    }), [toasts, addToast, removeToast])

    return (
        <ToastContext.Provider value={value}>
            {children}
        </ToastContext.Provider>
    )
}

export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext)
    if (!ctx) {
        throw new Error('useToast must be used within ToastProvider')
    }
    return ctx
}
