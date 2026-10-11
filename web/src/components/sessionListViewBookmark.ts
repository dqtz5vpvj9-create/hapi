import { createContext } from 'react'

export type SessionListViewBookmark = {
    scrollTop: number
    anchors: { id: string; rootId?: string; top: number }[]
}

export const SessionListViewRestoration = createContext<{
    bookmark: SessionListViewBookmark
    onLayout: (stable: boolean) => void
} | null>(null)

const selector = '[data-session-scroll-anchor], [data-session-view-anchor]'
const identity = (element: HTMLElement) => element.dataset.sessionViewAnchor || element.dataset.sessionScrollAnchor

// Capture only when leaving a view. Keep a few visible survivors, never a
// full-list snapshot or a listener doing projection work on every scroll.
export function captureSessionListViewBookmark(content: HTMLElement, container: HTMLElement): SessionListViewBookmark {
    const bookmark: SessionListViewBookmark = { scrollTop: container.scrollTop, anchors: [] }
    if (container.scrollTop <= 0) return bookmark
    const viewport = container.getBoundingClientRect()
    for (const element of content.querySelectorAll<HTMLElement>(selector)) {
        const id = identity(element)
        if (!id || element.closest('.collapsible-panel:not([data-open])')) continue
        const rect = element.getBoundingClientRect()
        if (rect.top >= viewport.bottom) break
        const isRow = element.classList.contains('session-list-item') || element.hasAttribute('data-session-view-anchor')
        if (rect.height > 0 && rect.bottom > viewport.top && (isRow || rect.top >= viewport.top)) {
            bookmark.anchors.push({ id, rootId: element.closest<HTMLElement>('[data-recent-root]')?.dataset.recentRoot, top: rect.top - viewport.top })
            if (bookmark.anchors.length === 8) break
        }
    }
    return bookmark
}

export function resolveSessionListViewBookmark(content: HTMLElement, container: HTMLElement, bookmark: SessionListViewBookmark): number {
    if (bookmark.scrollTop <= 0) return 0
    const elements = new Map(Array.from(content.querySelectorAll<HTMLElement>(selector))
        .map(element => [identity(element), element]))
    for (const anchor of bookmark.anchors) {
        const element = elements.get(anchor.id)
        if (!element || element.closest('.collapsible-panel:not([data-open])')) continue
        const rect = element.getBoundingClientRect()
        if (rect.height > 0) {
            // A phone row can become shorter at the desktop breakpoint. Keep
            // at least a slice of its identity visible after that resize.
            const top = Math.max(anchor.top, 1 - rect.height)
            return container.scrollTop + rect.top - container.getBoundingClientRect().top - top
        }
    }
    // If all semantic anchors disappeared, do not land in unrelated content.
    // A numeric fallback is only for a capture with no measurable identity.
    return bookmark.anchors.length ? 0 : bookmark.scrollTop
}
