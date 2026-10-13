import { Component, createRef, type ReactNode } from 'react'
import { captureSessionListViewBookmark, resolveSessionListViewBookmark, SessionListViewRestoration, type SessionListViewBookmark } from './sessionListViewBookmark'

type View = 'recent' | 'directory'
type Props = { children: ReactNode; className: string; sessions: readonly { id: string }[]; preferFirstVisible?: boolean; onScrollRestored?: (offset: number) => void; view?: View; bookmarkScope?: string; hasSessions?: boolean }
type ContentSnapshot = { kind: 'content'; scrollTop: number; anchors: { element: HTMLElement; top: number }[]; bookmark: SessionListViewBookmark }
type Snapshot = ContentSnapshot | { kind: 'view'; bookmark?: SessionListViewBookmark }

/** Read the old DOM at commit time, before rows move between pinned sections. */
export class SessionListScrollAnchor extends Component<Props, object, Snapshot | null> {
    private contentRef = createRef<HTMLDivElement>()
    private bookmarks: Partial<Record<View, SessionListViewBookmark>> = {}
    private bookmarkScope = this.props.bookmarkScope
    private committedView = this.props.view
    private committedSessions = this.props.sessions
    private pending: { bookmark: SessionListViewBookmark; stable: boolean } | null = null
    private settleFrame: number | null = null
    private removeInputListeners: (() => void) | null = null
    private restoreResizeObserver: ResizeObserver | null = null

    private cancelRestoration = (rerender = true) => {
        if (this.settleFrame !== null) cancelAnimationFrame(this.settleFrame)
        this.settleFrame = null
        this.removeInputListeners?.()
        this.removeInputListeners = null
        this.restoreResizeObserver?.disconnect()
        this.restoreResizeObserver = null
        const wasPending = this.pending !== null
        this.pending = null
        if (wasPending && rerender) this.forceUpdate()
    }

    private restoreBookmark = () => {
        const content = this.contentRef.current, container = content?.parentElement
        if (!content || !container || !this.pending?.stable) return
        if (container.getBoundingClientRect().height <= 0) return
        const before = container.scrollTop
        const target = resolveSessionListViewBookmark(content, container, this.pending.bookmark)
        if (Math.abs(before - target) > 0.5) container.scrollTop = target
        this.props.onScrollRestored?.(container.scrollTop)
        // Finish at the aligned item or an ordinary browser end clamp. A
        // changed landing may mount another virtual window; let its measured
        // commit align once more before releasing the temporary root pins.
        if (Math.abs(container.scrollTop - before) <= 0.5) {
            this.cancelRestoration()
        } else {
            if (this.settleFrame !== null) cancelAnimationFrame(this.settleFrame)
            const pending = this.pending
            this.settleFrame = requestAnimationFrame(() => {
                if (this.pending !== pending) return
                this.settleFrame = null
                this.restoreBookmark()
            })
        }
    }

    private onBookmarkLayout = (stable: boolean) => {
        if (!this.pending) return
        this.pending.stable = stable
        if (stable) this.restoreBookmark()
    }

    private startRestoration = (bookmark: SessionListViewBookmark, stable: boolean) => {
        this.pending = { bookmark, stable }
        const container = this.contentRef.current?.parentElement
        if (!container) return
        const cancel = () => this.cancelRestoration()
        const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
        for (const event of events) container.addEventListener(event, cancel, { capture: true, passive: true })
        this.removeInputListeners = () => {
            for (const event of events) container.removeEventListener(event, cancel, true)
        }
        const ResizeObserverClass = container.ownerDocument.defaultView?.ResizeObserver
        if (ResizeObserverClass) {
            const pending = this.pending
            this.restoreResizeObserver = new ResizeObserverClass(() => {
                if (this.pending !== pending) return
                // A hidden pane can reveal without changing its virtual range.
                if (!pending.stable && container.getBoundingClientRect().height > 0) this.forceUpdate()
                else this.restoreBookmark()
            })
            this.restoreResizeObserver.observe(container)
        }
    }

    componentWillUnmount() { this.cancelRestoration(false) }

    getSnapshotBeforeUpdate(previousProps: Props): Snapshot | null {
        const content = this.contentRef.current
        const container = content?.parentElement
        const scopeChanged = previousProps.bookmarkScope !== this.props.bookmarkScope
        if (scopeChanged || this.props.hasSessions === false) {
            this.bookmarks = {}
            this.bookmarkScope = this.props.bookmarkScope
            this.cancelRestoration(false)
        }
        if (previousProps.view !== this.props.view) {
            this.cancelRestoration(false)
            if (!scopeChanged && previousProps.hasSessions !== false && this.props.hasSessions !== false
                && content && container && previousProps.view) {
                this.bookmarks[previousProps.view] = captureSessionListViewBookmark(content, container)
            }
            const bookmark = this.props.view ? this.bookmarks[this.props.view] : undefined
            if (bookmark) this.startRestoration(bookmark, this.props.view !== 'recent')
            return { kind: 'view', bookmark }
        }
        if (previousProps.sessions === this.props.sessions) return null
        this.cancelRestoration(false)
        if (!content || !container || container.scrollTop <= 0) return null
        const viewport = container.getBoundingClientRect()
        const anchors: ContentSnapshot['anchors'] = []
        for (const element of content.querySelectorAll<HTMLElement>('[data-session-scroll-anchor], [data-session-view-anchor]')) {
            if (element.closest('.collapsible-panel:not([data-open])')) continue
            const rect = element.getBoundingClientRect()
            if (rect.top >= viewport.bottom) break
            // A project's box can span the whole viewport; only anchor its visible header.
            const isRow = element.classList.contains('session-list-item') || element.hasAttribute('data-session-view-anchor')
            if (rect.height > 0 && rect.bottom > viewport.top && (isRow || rect.top >= viewport.top)) {
                anchors.push({ element, top: rect.top - viewport.top })
            }
        }
        return { kind: 'content', scrollTop: container.scrollTop, anchors, bookmark: scopeChanged ? { scrollTop: container.scrollTop, anchors: [] } : captureSessionListViewBookmark(content, container) }
    }

    componentDidUpdate(_previousProps: Props, _previousState: object, snapshot: Snapshot | null) {
        this.committedView = this.props.view
        this.committedSessions = this.props.sessions
        const content = this.contentRef.current
        const container = content?.parentElement
        if (!content || !container || !snapshot) return
        if (snapshot.kind === 'view') {
            if (snapshot.bookmark) {
                if (this.props.view !== 'recent') this.restoreBookmark()
            } else {
                container.scrollTop = 0
                this.props.onScrollRestored?.(container.scrollTop)
            }
            return
        }
        const viewportTop = container.getBoundingClientRect().top
        // Directory groups prefer the least-reordered survivor. Recent keeps
        // the first visible row that survives in the committed window; if it
        // leaves the window or is removed, the next surviving row takes over.
        // Compare content offsets so native anchoring cannot hide a move.
        const candidates = snapshot.anchors
            .filter(({ element }) => content.contains(element)
                && !element.closest('.collapsible-panel:not([data-open])'))
            .map(anchor => ({ ...anchor, rect: anchor.element.getBoundingClientRect() }))
            .filter(({ rect }) => rect.height > 0)
            .map(anchor => ({
                ...anchor,
                shift: anchor.rect.top - viewportTop + container.scrollTop - anchor.top - snapshot.scrollTop,
            }))
        const anchor = this.props.preferFirstVisible ? candidates[0]
            : candidates.sort((a, b) => Math.abs(a.shift) - Math.abs(b.shift))[0]
        if (!anchor && this.props.view === 'recent' && snapshot.bookmark.anchors.length) {
            // A large insertion above the reader can move every surviving row
            // outside the next virtual range. Restore at most eight identities,
            // before paint, instead of keeping an entire subtree mounted.
            const ids = new Set(this.props.sessions.map(session => session.id))
            const surviving = snapshot.bookmark.anchors.filter(item => item.rootId && ids.has(item.rootId))
            if (surviving.length) {
                this.startRestoration({ ...snapshot.bookmark, anchors: surviving }, false)
                this.forceUpdate()
                return
            }
            // Actual deletion/filtering keeps the existing numeric fallback.
        }
        const scrollTop = anchor ? snapshot.scrollTop + anchor.shift : snapshot.scrollTop
        if (Math.abs(container.scrollTop - scrollTop) > 0.5) container.scrollTop = scrollTop
        // Publish the browser's actual landing, including native anchoring,
        // before paint; the observer must never replay the scroll write.
        this.props.onScrollRestored?.(container.scrollTop)
    }

    render() {
        const bookmark = this.bookmarkScope === this.props.bookmarkScope && this.props.hasSessions !== false
            ? this.committedView !== this.props.view && this.props.view ? this.bookmarks[this.props.view]
                : this.committedSessions === this.props.sessions ? this.pending?.bookmark : undefined
            : undefined
        return <SessionListViewRestoration.Provider value={bookmark ? { bookmark, onLayout: this.onBookmarkLayout } : null}>
            <div ref={this.contentRef} className={this.props.className}>
                {this.props.children}
            </div>
        </SessionListViewRestoration.Provider>
    }
}
