/** Opening replay is limited to the outer reader, never editors/actions or a
 * nested scrollport. This filter does not change ordinary browser input. */
export function isOpeningReaderTarget(target: EventTarget | null, viewport: HTMLElement): boolean {
    if (!(target instanceof Element) || !viewport.contains(target)) return false
    if (target.closest('input,textarea,[contenteditable],[role="textbox"],[data-composer-seat],button,a,[role="button"],pre,[data-hapi-large-code],[data-step-process-body]')) return false
    for (let node: Element | null = target; node && node !== viewport; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (/(auto|scroll)/.test(`${style.overflowY} ${style.overflowX}`)) return false
    }
    return true
}

export function openingWheelPixels(event: WheelEvent, viewport: HTMLElement): number | null {
    if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)
        || !isOpeningReaderTarget(event.target, viewport)) return null
    const style = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? getComputedStyle(viewport) : null
    const line = style ? parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 16) * 1.2 : 0
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 1
        : event.deltaMode === WheelEvent.DOM_DELTA_LINE ? line
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientHeight : 0
    const delta = event.deltaY * unit
    return Number.isFinite(delta) && delta !== 0 ? delta : null
}
