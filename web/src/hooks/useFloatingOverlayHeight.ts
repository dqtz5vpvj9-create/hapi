import { useLayoutEffect, useState, type RefObject } from 'react'

/** Keep an upward-anchored composer menu inside the readable viewport. The
 * existing bottom anchor stays fixed; only the menu's scrollable height changes. */
export function useFloatingOverlayHeight(panelRef: RefObject<HTMLElement | null>, maxHeight: number): number {
    const [availableHeight, setAvailableHeight] = useState(maxHeight)

    useLayoutEffect(() => {
        const panel = panelRef.current
        if (!panel) return
        const viewport = window.visualViewport
        const chat = panel.closest('.app-chat')
        const header = chat?.querySelector<HTMLElement>('.app-chat-header')
        let frame = 0

        const measure = () => {
            frame = 0
            const viewportTop = viewport?.offsetTop ?? 0
            const headerBottom = header?.getBoundingClientRect().bottom ?? viewportTop
            const top = Math.max(viewportTop, headerBottom) + 12
            const bottom = panel.getBoundingClientRect().bottom
            const height = Math.min(maxHeight, Math.max(0, Math.floor(bottom - top)))
            setAvailableHeight(previous => previous === height ? previous : height)
        }
        const schedule = () => {
            if (!frame) frame = requestAnimationFrame(measure)
        }
        const observer = new ResizeObserver(schedule)
        observer.observe(panel)
        // Changing the editor's size moves an upward-anchored menu without
        // necessarily resizing that menu. Observe its positioning container too.
        if (panel.offsetParent) observer.observe(panel.offsetParent)
        if (chat) observer.observe(chat)
        if (header) observer.observe(header)
        viewport?.addEventListener('resize', schedule)
        viewport?.addEventListener('scroll', schedule)
        window.addEventListener('resize', schedule)
        measure()

        return () => {
            cancelAnimationFrame(frame)
            observer.disconnect()
            viewport?.removeEventListener('resize', schedule)
            viewport?.removeEventListener('scroll', schedule)
            window.removeEventListener('resize', schedule)
        }
    }, [panelRef, maxHeight])

    return Math.min(maxHeight, availableHeight)
}
