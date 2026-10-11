// Serialized into the synthetic local page. Lean RAF sampling never reads DOM.
export function installRecentProbe(options) {
    const state = { options, entryAt: null, readyAt: null, firstWheelAt: null, armed: false, frames: [], wheels: [], longTasks: [], snapshots: [], probeMs: 0, dropped: 0, wheelTargetDiagnostics: [], outsideWheelCount: 0 }
    let viewport = null, list = null, raf = 0
    function pixelCoordinate(top, bottom, ratio = window.devicePixelRatio || 1) {
        const first = Math.ceil(top * ratio), last = Math.ceil(bottom * ratio) - 1
        return first <= last ? Math.floor((first + last) / 2) / ratio : null
    }
    const rect = element => { const r = element.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width } }
    const expectedTitle = id => 'Recent benchmark ' + String(Number(id.split('-').at(-1))).padStart(4, '0')
    function sample() {
        const started = performance.now()
        viewport = document.querySelector('.app-session-list-content')
        list = document.querySelector('[data-testid="recent-session-list"]')
        if (!viewport || !list) return { at: started, correct: false, errors: ['Recent viewport/list absent'] }
        const bounds = rect(viewport), masks = []
        for (const overlay of document.querySelectorAll('.app-new-task-input')) {
            const r = rect(overlay)
            if (r.height > 0 && r.width > 0 && r.bottom > bounds.top && r.top < bounds.bottom && r.left < bounds.right && r.right > bounds.left) masks.push(r)
        }
        const usable = { ...bounds }
        for (const mask of masks) if (mask.left <= bounds.left + 12 && mask.right >= bounds.right - 12) usable.bottom = Math.min(usable.bottom, mask.top)
        const errors = [], rows = [], intervals = [], headings = [], hitFailures = [], nodes = list.querySelectorAll('[data-session-tree-id]')
        for (const element of nodes) {
            const r = rect(element)
            if (r.bottom <= usable.top || r.top >= usable.bottom || r.height <= 0) continue
            const id = element.dataset.sessionTreeId
            const title = element.querySelector('.app-session-row-title')?.textContent?.trim()
            const button = element.querySelector('.session-list-item')
            const top = Math.max(r.top, usable.top), bottom = Math.min(r.bottom, usable.bottom)
            const ratio = window.devicePixelRatio || 1
            const x = Math.floor((Math.max(bounds.left, r.left) + Math.min(bounds.width, r.width) * .55) * ratio) / ratio
            const y = pixelCoordinate(top, bottom)
            let hit = 'unobservable'
            if (y !== null) {
                if (!masks.some(mask => x >= mask.left && x < mask.right && y >= mask.top && y < mask.bottom)) {
                    const target = document.elementFromPoint(x, y)
                    hit = !!target && (element === target || element.contains(target))
                    if (!hit) {
                        errors.push('hit:' + id)
                        const describe = node => node ? { tag: node.tagName, className: String(node.className).slice(0, 240), rect: rect(node), overlayAncestor: !!node.closest('.app-new-task-input') } : null
                        hitFailures.push({ id, x, y, clipped: { top, bottom }, target: describe(target), alternatives: [Math.floor(y), Math.floor(y) + .25, Math.floor(y) + .49, Math.floor(y) + .5].map(testY => ({ y: testY, target: describe(document.elementFromPoint(x, testY)) })) })
                    }
                }
            }
            if (title !== expectedTitle(id)) errors.push('title:' + id)
            if (!button || r.width < 10) errors.push('geometry:' + id)
            rows.push({ id, title, top: r.top, bottom: r.bottom, hit })
            intervals.push([top, bottom])
        }
        for (const heading of list.querySelectorAll('.app-session-date-heading')) {
            const r = rect(heading)
            if (r.bottom > usable.top && r.top < usable.bottom && r.height > 0) {
                intervals.push([Math.max(r.top, usable.top), Math.min(r.bottom, usable.bottom)])
                const next = heading.nextElementSibling
                const tree = next?.matches('[data-session-tree-id]') ? next : next?.querySelector('[data-session-tree-id]')
                const id = tree?.getAttribute('data-session-tree-id')
                if (id) {
                    const index = Number(id.slice(5)) - 1
                    const date = new Date(Date.UTC(2026, 9, 10, 12) - Math.floor(index / 5) * 86400000 - index)
                    const today = new Date(), yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
                    const expected = date.toDateString() === today.toDateString() ? 'Today' : date.toDateString() === yesterday.toDateString() ? 'Yesterday' : date.toLocaleDateString(document.documentElement.lang || undefined, { month: 'short', day: 'numeric' })
                    const paddingTop = parseFloat(getComputedStyle(heading).paddingTop)
                    headings.push({ id, text: heading.textContent, expected, paddingTop })
                    if (heading.textContent !== expected) errors.push('date:' + id)
                    if (paddingTop !== (index === 0 ? 12 : 18)) errors.push('date-padding:' + id)
                } else errors.push('date-owner-missing')
            }
        }
        intervals.sort((a, b) => a[0] - b[0])
        const listBounds = rect(list)
        let covered = Math.max(usable.top, listBounds.top)
        const coverageEnd = Math.min(usable.bottom, listBounds.bottom)
        for (const [top, bottom] of intervals) {
            if (top - covered > 4) errors.push('blank:' + (top - covered).toFixed(2))
            covered = Math.max(covered, bottom)
        }
        if (coverageEnd - covered > 4) errors.push('blank-end:' + (coverageEnd - covered).toFixed(2))
        if (!rows.length) errors.push('no-visible-rows')
        for (let index = 1; index < rows.length; index++) if (Number(rows[index].id.slice(5)) <= Number(rows[index - 1].id.slice(5))) errors.push('order')
        const workMs = performance.now() - started
        state.probeMs += workMs
        return { at: started, correct: errors.length === 0, errors, hitFailures, rows, bounds, usable, masks, mountedRows: nodes.length, domNodes: list.querySelectorAll('*').length,
            scrollTop: viewport.scrollTop, scrollHeight: viewport.scrollHeight, maxScrollTop: viewport.scrollHeight - viewport.clientHeight,
            dateHeadings: headings, workMs }
    }
    document.addEventListener('click', event => {
        const button = event.target instanceof Element ? event.target.closest('.app-session-list-views button') : null
        if (button?.textContent?.trim() === 'Recent' && state.entryAt === null) state.entryAt = performance.now()
    }, { capture: true, passive: true })
    document.addEventListener('wheel', event => {
        if (!state.armed) return
        const targetViewport = event.target?.closest?.('.app-session-list-content')
        const accepted = !!targetViewport?.querySelector('[data-testid="recent-session-list"]')
        if (state.wheelTargetDiagnostics.length < 16) state.wheelTargetDiagnostics.push({ at: performance.now(), accepted, sameElement: targetViewport === viewport, previousConnected: viewport?.isConnected ?? null, targetClass: String(event.target?.className ?? '').slice(0, 100) })
        if (!accepted) { state.outsideWheelCount++; return }
        viewport = targetViewport
        const at = performance.now()
        if (state.firstWheelAt === null) state.firstWheelAt = at
        if (state.wheels.length < 300) state.wheels.push({ at, eventAt: event.timeStamp, deltaY: event.deltaY, trusted: event.isTrusted })
        else state.dropped++
    }, { capture: true, passive: true })
    try { new PerformanceObserver(items => { for (const entry of items.getEntries()) if (state.longTasks.length < 500) state.longTasks.push({ at: entry.startTime, duration: entry.duration }) }).observe({ type: 'longtask', buffered: true }) } catch (error) { state.longTaskError = String(error) }
    function frame(at) {
        if (!state.armed) return
        if (state.frames.length < 600) state.frames.push(at); else state.dropped++
        if (options.mode === 'full' && state.snapshots.length < 300) state.snapshots.push(sample())
        raf = requestAnimationFrame(frame)
    }
    window.__recentRecovery = {
        pixelCoordinate,
        ready() { const value = sample(); if (value.correct && state.readyAt === null) { state.readyAt = performance.now(); state.initial = value }; return value.correct },
        arm() { if (!state.initial) throw new Error('Probe armed before a correct first viewport'); const current = sample(); if (!current.correct) throw new Error('Current viewport changed before arm: ' + current.errors.join(',')); state.atArm = current; state.armed = true; raf = requestAnimationFrame(frame); return { readyAt: state.readyAt, armedAt: performance.now(), point: { x: current.bounds.left + current.bounds.width * .5, y: current.bounds.top + current.bounds.height * .4 }, viewportHeight: current.bounds.height } },
        stop() { state.armed = false; cancelAnimationFrame(raf); state.final = sample(); return state },
        peek() { return { state: { entryAt: state.entryAt, readyAt: state.readyAt, firstWheelAt: state.firstWheelAt, frames: state.frames.length, dropped: state.dropped }, sample: sample() } },
    }
}
