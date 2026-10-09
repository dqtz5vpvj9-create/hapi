import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** First presentation is a layout decision, not a timer. Keep the real body
 * mounted for measurement, and never hide it again for background updates. */
export function useInitialChatPresentation(
    sessionId: string,
    viewportRef: RefObject<HTMLDivElement | null>,
    contentRef: RefObject<HTMLDivElement | null>,
    ready: () => boolean,
) {
    const [presentedSession, setPresentedSession] = useState<string | null>(null)
    const current = useRef({ sessionId, ready, presented: false })
    current.current = { sessionId, ready, presented: presentedSession === sessionId }
    const check = useCallback(() => {
        const value = current.current
        if (!value.presented && viewportRef.current?.getClientRects().length && value.ready()) {
            setPresentedSession(value.sessionId)
        }
    }, [viewportRef])
    useLayoutEffect(check)
    useLayoutEffect(() => {
        if (presentedSession === sessionId) return
        const viewport = viewportRef.current, content = contentRef.current
        if (!viewport || !content) return
        // These callbacks only publish visibility. The existing scroll owner
        // performs positioning before the readiness predicate can succeed.
        const observer = new ResizeObserver(check)
        observer.observe(viewport)
        observer.observe(content)
        viewport.addEventListener('scroll', check)
        return () => { observer.disconnect(); viewport.removeEventListener('scroll', check) }
    }, [sessionId, presentedSession, viewportRef, contentRef, check])
    return { presented: presentedSession === sessionId, check }
}
