import type { MessageListNavigation } from '@/components/AssistantChat/VirtualMessageList'
import { captureReadingAnchor, restoreReadingAnchor, CODE_READING_SOURCE_READY } from '@/lib/reading-anchor'
import { ChatViewport, type ViewportLanding } from './dsh/use-chat-viewport'
import type { ChatScrollPosition } from './dsh/types'
import type { ScrollFollow } from './dsh/use-scroll-follow'
import type { NativeChatProjection } from './nativeProjection'

/** Geometry adapter only. DSH Reading/Navigation retain policy ownership. */
export class NativeChatViewport extends ChatViewport {
    onDetach?: () => void
    onReveal?: () => void
    navigationVersion = 0
    readerDelta = 0
    navigation: MessageListNavigation | null = null
    private codeRestore: { reading: NonNullable<ChatScrollPosition['reading']>; finished: boolean } | null = null
    private retained: ChatScrollPosition | null = null
    private retainedDocumentTop: number | null = null
    private pageCommitPending = false
    private layoutPosition: { key: string; top: number } | null = null
    private disposed = false
    constructor(private projection: NativeChatProjection) { super() }
    override attach(list: HTMLElement, column: HTMLElement) {
        super.attach(list, column)
        this.disposed = false
        list.addEventListener(CODE_READING_SOURCE_READY, this.layoutCommitted)
        list.addEventListener('scroll', this.releaseForReaderMotion, { capture: true, passive: true })
        // Cancel even while a destination is still waiting for its virtual DOM.
        for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) list.addEventListener(type, this.interrupt, { capture: true, passive: true })
    }
    override detach() {
        this.onDetach?.()
        this.disposed = true
        const list = this.elements?.list
        list?.removeEventListener(CODE_READING_SOURCE_READY, this.layoutCommitted)
        list?.removeEventListener('scroll', this.releaseForReaderMotion, true)
        for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) list?.removeEventListener(type, this.interrupt, true)
        super.detach()
    }
    private interrupt = (event: Event) => {
        if (event instanceof KeyboardEvent && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return
        if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable]')) return
        this.readScroll()
        this.stopPreserving()
        this.events?.interact()
    }
    layoutCommitted = () => { this.invalidate(); this.events?.resize() }
    captureVirtualLayout() {
        // Explicit navigation/bookmark restoration already owns its position.
        if (this.retained || !this.elements) return
        const viewport = this.elements.scroller
        const bounds = viewport.getBoundingClientRect()
        const padding = parseFloat(getComputedStyle(viewport).scrollPaddingTop) || 0
        const row = [...viewport.querySelectorAll<HTMLElement>('[data-chat-node-key]')].find(row => {
            const rect = row.getBoundingClientRect()
            return rect.height > 0 && rect.bottom > bounds.top + padding && rect.top < bounds.bottom
        })
        this.layoutPosition = row ? { key: row.dataset.chatNodeKey!, top: row.getBoundingClientRect().top - bounds.top } : null
    }
    restoreVirtualLayout = () => {
        const position = this.layoutPosition
        this.layoutPosition = null
        if (!position || !this.elements) return
        const row = super.anchor(position.key)
        const metrics = this.metrics()
        if (!row || !metrics) return
        const top = row.getBoundingClientRect().top - this.elements.scroller.getBoundingClientRect().top
        if (Math.abs(top - position.top) <= 0.5) return
        this.write(metrics.top + top - position.top, metrics, null, { key: position.key, top })
    }
    private releaseForReaderMotion = (event: Event) => {
        const elements = this.elements
        if (!elements || event.target !== elements.scroller || !this.retained || this.retainedDocumentTop === null) return
        const row = super.anchor(this.projection.ownerOf(this.retained.anchorKey))
        if (!row) return
        const documentTop = row.getBoundingClientRect().top - elements.scroller.getBoundingClientRect().top + elements.scroller.scrollTop
        // A native anchoring adjustment moves both the row's document position
        // and scrollTop. Wheel/touch inertia moves only scrollTop. Release the
        // retained page anchor for the latter, even without another input event.
        if (Math.abs(documentTop - this.retainedDocumentTop) <= 0.5 && super.readScroll()?.movedByReader) {
            this.stopPreserving()
        }
    }
    override readScroll() {
        const scroll = super.readScroll()
        this.readerDelta = scroll ? scroll.metrics.top - Math.min(this.observation.top, scroll.metrics.floor) : 0
        // Chrome can deliver actual wheel motion before the wheel callback.
        // Browser anchoring must resume for that reader-owned geometry even
        // while DSH's unchanged 500 ms sample is pending.
        if (scroll?.movedByReader && scroll.metrics.floor - scroll.metrics.top > 24 && this.elements) {
            this.elements.scroller.style.overflowAnchor = 'auto'
        }
        return scroll
    }
    override scrollToBottom(follow: ScrollFollow) {
        const elements = this.elements
        if (elements) {
            const room = parseFloat(elements.column.style.getPropertyValue('--native-reading-tail-room')) || 0
            const distance = elements.scroller.scrollHeight - elements.scroller.clientHeight - elements.scroller.scrollTop
            // Retiring the short-page blank space must not clamp scrollTop
            // backwards while the reader is moving down toward the tail.
            const remaining = Math.max(0, room - Math.max(0, distance))
            if (remaining > 0.5) elements.column.style.setProperty('--native-reading-tail-room', `${remaining}px`)
            else elements.column.style.removeProperty('--native-reading-tail-room')
        }
        if (this.elements) this.elements.scroller.style.overflowAnchor = 'none'
        return super.scrollToBottom(follow)
    }
    override capturePosition(): ChatScrollPosition | null {
        return this.captureReading(true)
    }
    private captureReading(pin: boolean): ChatScrollPosition | null {
        const viewport = this.elements?.scroller
        if (!viewport) return null
        const bounds = viewport.getBoundingClientRect()
        const padding = parseFloat(getComputedStyle(viewport).scrollPaddingTop) || 0
        const row = [...viewport.querySelectorAll<HTMLElement>('[data-chat-node-key]')].find(element => {
            const rect = element.getBoundingClientRect()
            return rect.height > 0 && rect.bottom > bounds.top + padding && rect.top < bounds.bottom
        })
        const node = row && this.projection.get(row.dataset.chatNodeKey!)
        // Prefer the disclosure actually at the reading line over body text
        // farther down. Otherwise virtualization pins that later paragraph and
        // can unmount the visible header for a frame during a prepend.
        if (row && (node?.process && !node.process.open || node?.group && !node.group.open)) {
            const anchorKey = row.dataset.chatNodeKey!
            const anchorTop = row.getBoundingClientRect().top - bounds.top
            if (pin) this.navigation?.pinReading(anchorKey)
            return { anchorKey, anchorTop, scrollTop: viewport.scrollTop, reading: {
                id: `hapi-message-${node?.messageKey ?? anchorKey}`, topOffset: anchorTop, disclosure: true,
            } }
        }
        const reading = captureReadingAnchor(viewport)
        if (!reading) return null
        if (pin) this.navigation?.pinReading(this.projection.ownerOf(reading.id))
        return { anchorKey: reading.id, anchorTop: reading.topOffset, scrollTop: viewport.scrollTop, reading }
    }
    /** React can render a long page while the compositor continues a gesture.
     * Re-sample the old DOM at the mutation boundary, not before that render.
     * Pinning happened at request publication; this read must not set React state. */
    refreshPreservedReading() {
        if (!this.pageCommitPending) return
        this.pageCommitPending = false
        this.layoutPosition = null
        if (!this.retained) return
        const current = this.captureReading(false)
        if (!current) return
        this.retained = current
        this.retainedDocumentTop = current.anchorTop + current.scrollTop
    }
    preparePageCommit() {
        this.beginPreserving()
        this.pageCommitPending = true
    }
    protected override anchor(key: string, identity: 'position' | 'node' = 'position'): HTMLElement | null {
        return this.resolveAnchor(key, true, identity)
    }
    private resolveAnchor(key: string, reveal: boolean, identity: 'position' | 'node' = 'position'): HTMLElement | null {
        const owner = this.projection.ownerOf(key)
        if (reveal && this.projection.reveal(owner)) { this.onReveal?.(); return null }
        const found = super.anchor(owner, identity)
        if (found) return found
        if (this.navigation?.contains(owner)) this.navigation.reveal(owner)
        return null
    }
    override restore(position: ChatScrollPosition): ViewportLanding | null {
        const viewport = this.elements?.scroller
        if (!viewport) return null
        const owner = this.projection.ownerOf(position.anchorKey)
        const row = this.resolveAnchor(owner, !position.reading?.disclosure)
        // HAPI's context loader handles missing data. A missing virtual seat is
        // never evidence of deletion, and raw scrollTop is not a valid fallback.
        if (!row) return null
        viewport.style.overflowAnchor = 'auto'
        this.navigation?.pinReading(owner)
        const node = this.projection.get(owner)
        const original = position.reading ?? { id: position.anchorKey, topOffset: position.anchorTop }
        const part = node && viewport.ownerDocument.getElementById(`hapi-reading-${node.key}`)
        const message = node && viewport.ownerDocument.getElementById(`hapi-message-${node.key}`)
        const reading = { ...original, id: original.disclosure ? row.id
            : (original.id.startsWith('hapi-reading-') ? part : message)?.id ?? row.id }
        if (reading.code) {
            // The scroll adapter wraps the same saved bookmark on each read.
            // Keep its asynchronous CodeMirror placement alive across layout
            // publications until the actual bookmark or navigation changes.
            if (this.codeRestore?.reading !== original) {
                const task = { reading: original, finished: false }
                this.codeRestore = task
                restoreReadingAnchor(viewport, reading, {
                    isCurrent: () => !this.disposed && this.codeRestore === task,
                    onScroll: () => { const metrics = this.metrics(); if (metrics) this.acknowledge(metrics) },
                    onRestored: success => {
                        if (this.codeRestore !== task || this.disposed) return
                        if (success) { task.finished = true; this.layoutCommitted() }
                        else this.codeRestore = null
                    },
                })
            }
            if (!this.codeRestore?.finished) return null
        } else if (!restoreReadingAnchor(viewport, reading)) return null
        const metrics = this.metrics()
        if (!metrics) return null
        const landing = { metrics, position, turn: null }
        this.observation = { top: metrics.top, landing }
        if (this.retained) this.retainedDocumentTop = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top + metrics.top
        return landing
    }
    // HAPI starts pagination during a gesture, unlike DSH's explicit button.
    // Reader sampling/scrollend retain the settled anchor; the store's
    // before-apply boundary samples once more immediately before publication.
    override beginPaging() { this.stopPreserving() }
    override beginPreserving(position = this.capturePosition()) {
        // Replacing retained geometry is not cancellation of a history lookup.
        super.stopPreserving()
        this.codeRestore = null
        this.retained = position
        this.retainedDocumentTop = position ? position.anchorTop + position.scrollTop : null
        const elements = this.elements
        if (position && elements) {
            // A short initial page leaves real blank space below its content.
            // Retain that space while prepending; without it the browser clamps
            // the requested anchor offset at the new floor and moves the header.
            const unused = elements.scroller.clientHeight - elements.column.getBoundingClientRect().height
            if (unused > 0.5) {
                const previous = parseFloat(elements.column.style.getPropertyValue('--native-reading-tail-room')) || 0
                elements.column.style.setProperty('--native-reading-tail-room', `${previous + unused}px`)
            }
        }
    }
    override stopPreserving() {
        this.navigationVersion++
        this.pageCommitPending = false
        this.layoutPosition = null
        super.stopPreserving()
        this.retained = null
        this.retainedDocumentTop = null
        this.codeRestore = null
        this.navigation?.releaseDestination()
    }
    override get preserving() { return this.retained !== null }
    override preserve() { return this.retained ? this.restore(this.retained) : null }
    override navigationSettled(landing: ViewportLanding) {
        if (!landing.position) return
        this.navigation?.pinReading(this.projection.ownerOf(landing.position.anchorKey))
        this.beginPreserving(landing.position)
        if (this.elements) this.elements.scroller.style.overflowAnchor = 'auto'
    }
    override isTurnMountPending(turn: number) {
        const target = this.turns.find(item => item.turn === turn)
        return Boolean(target && this.projection.get(this.projection.ownerOf(target.anchorKey)))
    }
    override readVisibleTurn(metrics = this.metrics()) {
        // DSH locates the active turn from outer row boxes. A turn indicator
        // does not need HAPI's character/code bookmark or a new reading pin.
        // Adapt only the row collection to the currently mounted virtual seats.
        const elements = this.elements
        if (!elements || !metrics || !this.turns.length) return null
        const line = elements.scroller.getBoundingClientRect().top + Math.min(96, metrics.height * 0.2)
        const rows = elements.column.querySelectorAll<HTMLElement>('[data-chat-node-key]')
        let low = 0, high = rows.length
        let reading = this.turns[0].turn
        while (low < high) {
            const middle = (low + high) >>> 1
            const row = rows[middle]
            if (row.getBoundingClientRect().top > line) high = middle
            else {
                reading = this.turns.find(item => item.anchorKey === row.dataset.chatNodeKey)?.turn ?? reading
                low = middle + 1
            }
        }
        return reading
    }
    override scrollToTurnAtOrAfter(turn: number) {
        // Navigation fallbacks must come from the loaded data, not mounted DOM.
        const target = this.turns.find(item => item.turn >= turn)
        return target ? this.scrollToTurn(target.turn) : null
    }
}
