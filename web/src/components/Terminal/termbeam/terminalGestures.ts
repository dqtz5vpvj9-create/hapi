// Adapted from TermBeam TerminalPane touch handlers. See UPSTREAM.md and LICENSE.
import type { Terminal } from '@xterm/xterm'

export function attachTerminalGestures(container: HTMLElement, terminal: Terminal, onFontSize: (size: number) => void): () => void {
    let pinchStartDist = 0
    let pinchStartFont = 0
    let pinchActive = false
    let zoomTimer: ReturnType<typeof setTimeout> | null = null
    let lastY = 0
    let lastTime = 0
    let velocity = 0
    let coastRaf = 0
    let tracking = false
    let startX = 0
    let startY = 0
    let claimed = false
    let pendingPixels = 0
    let tapEligible = false

    function touchDist(touches: TouchList) {
        const first = touches[0]!
        const second = touches[1]!
        return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)
    }

    function scrollPixels(dy: number) {
        if (terminal.buffer.active.type === 'alternate') {
            // xterm owns mouse-wheel reporting and application cursor mode.
            terminal.element?.dispatchEvent(new WheelEvent('wheel', {
                deltaY: dy, deltaMode: WheelEvent.DOM_DELTA_PIXEL, bubbles: true, cancelable: true,
                clientX: startX, clientY: lastY,
            }))
        } else {
            const screen = container.querySelector('.xterm-screen')
            const lineHeight = (screen?.getBoundingClientRect().height ?? 0) / terminal.rows
            if (!lineHeight) return
            pendingPixels += dy
            const lines = Math.trunc(pendingPixels / lineHeight)
            if (lines) {
                terminal.scrollLines(lines)
                pendingPixels -= lines * lineHeight
            }
        }
    }

    function onTouchStart(event: TouchEvent) {
        cancelAnimationFrame(coastRaf)
        if (event.touches.length === 2) {
            pinchActive = true
            tapEligible = false
            tracking = false
            pinchStartDist = touchDist(event.touches)
            pinchStartFont = terminal.options.fontSize ?? 13
            return
        }
        if (event.touches.length !== 1) return
        tracking = true
        tapEligible = true
        claimed = false
        startX = event.touches[0]!.clientX
        startY = event.touches[0]!.clientY
        lastY = startY
        lastTime = performance.now()
        velocity = 0
        pendingPixels = 0
        // Lazy claim: preserve native TUI taps until the finger moves.
    }

    function onTouchMove(event: TouchEvent) {
        if (pinchActive && event.touches.length === 2) {
            event.preventDefault()
            event.stopPropagation()
            const size = Math.min(32, Math.max(9, Math.round(pinchStartFont * touchDist(event.touches) / pinchStartDist)))
            if (zoomTimer) clearTimeout(zoomTimer)
            zoomTimer = setTimeout(() => onFontSize(size), 50)
            return
        }
        if (!tracking || event.touches.length !== 1) return
        const y = event.touches[0]!.clientY
        if (!claimed) {
            if (Math.abs(y - startY) < 4) return
            claimed = true
            tapEligible = false
        }
        event.preventDefault()
        event.stopPropagation()
        const now = performance.now()
        const dt = now - lastTime
        const dy = lastY - y
        if (Math.abs(dy) >= 1) {
            if (dt > 0) velocity = dy / dt
            scrollPixels(dy)
            lastY = y
            lastTime = now
        }
    }

    function coast() {
        velocity *= 0.96
        if (Math.abs(velocity) < 0.05 || terminal.buffer.active.type !== 'normal') return
        scrollPixels(velocity * 16)
        coastRaf = requestAnimationFrame(coast)
    }

    function onTouchEnd(event: TouchEvent) {
        const touch = event.changedTouches[0]
        if (tapEligible && !pinchActive && touch && Math.abs(touch.clientX - startX) < 10 && Math.abs(touch.clientY - startY) < 10 && !terminal.options.disableStdin) {
            terminal.focus()
            terminal.textarea?.focus({ preventScroll: true })
            // Preserve compatibility clicks for terminal links and mouse-aware TUIs.
        }
        if (tracking && claimed && terminal.buffer.active.type === 'normal' && Math.abs(velocity) > 0.15) coastRaf = requestAnimationFrame(coast)
        tracking = false
        tapEligible = false
        pinchActive = false
    }

    function onTouchCancel() {
        tracking = false
        tapEligible = false
        pinchActive = false
        if (zoomTimer) clearTimeout(zoomTimer)
        cancelAnimationFrame(coastRaf)
    }

    container.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
    container.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
    container.addEventListener('touchend', onTouchEnd, { capture: true })
    container.addEventListener('touchcancel', onTouchCancel, { capture: true })
    return () => {
        onTouchCancel()
        container.removeEventListener('touchstart', onTouchStart, { capture: true })
        container.removeEventListener('touchmove', onTouchMove, { capture: true })
        container.removeEventListener('touchend', onTouchEnd, { capture: true })
        container.removeEventListener('touchcancel', onTouchCancel, { capture: true })
    }
}
