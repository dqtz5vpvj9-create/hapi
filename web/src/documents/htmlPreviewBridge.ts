import type { HtmlViewState } from '@hapi/protocol/documents'

// Runs inside the opaque-origin frame. Only view state, links and selections
// cross this bridge; original file credentials and the API client stay outside.
export function htmlPreviewBridge(id: string, initial?: HtmlViewState): string {
    function runtime(id: string, initial?: HtmlViewState) {
        const send = (message: object) => parent.postMessage({ ...message, id }, '*')
        const path = (node: Node) => {
            const result: number[] = []
            while (node !== document.body && node.parentNode) {
                result.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node))
                node = node.parentNode
            }
            return result
        }
        const resolve = (parts: number[]) => parts.reduce<Node | undefined>((node, index) => node?.childNodes[index], document.body)
        const state = () => ({ x: scrollX, y: scrollY,
            details: Array.from(document.querySelectorAll('details')).map(element => ({ path: path(element), open: element.open })),
            fields: Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input:not([type=password]):not([type=file]),textarea,select'))
                .map(element => ({ path: path(element), value: element.value, ...('checked' in element ? { checked: element.checked } : {}) })),
        })
        let frame = 0
        const save = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; send({ type: 'state', state: state() }) }) }
        const selection = () => {
            const value = getSelection()
            if (!value?.rangeCount || value.isCollapsed) { send({ type: 'selection' }); return }
            const range = value.getRangeAt(0)
            if (!document.body.contains(range.startContainer) || !document.body.contains(range.endContainer)) return
            send({ type: 'selection', selection: { kind: 'html', quote: value.toString().slice(0, 12000),
                start: { path: path(range.startContainer), offset: range.startOffset }, end: { path: path(range.endContainer), offset: range.endOffset } } })
        }
        document.addEventListener('click', event => {
            const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href],area[href]') : null
            if (!anchor) return
            const href = anchor.getAttribute('href') ?? ''
            event.preventDefault()
            if (href.startsWith('#')) {
                let target = href.slice(1)
                try { target = decodeURIComponent(target) } catch { /* Keep literal anchors. */ }
                if (!target) scrollTo(0, 0)
                else (document.getElementById(target) ?? document.getElementsByName(target)[0])?.scrollIntoView()
            } else send({ type: 'link', href })
        }, true)
        document.addEventListener('submit', event => event.preventDefault(), true)
        document.addEventListener('pointerup', selection)
        document.addEventListener('keyup', selection)
        document.addEventListener('selectionchange', selection)
        addEventListener('scroll', save, { passive: true })
        document.addEventListener('toggle', save, true)
        document.addEventListener('input', save)
        document.addEventListener('change', save)
        addEventListener('message', event => {
            if (event.source !== parent || event.data?.id !== id) return
            if (event.data.type === 'resource') {
                const element = document.querySelector(`[data-hapi-resource="${event.data.resource}"]`)
                if (element && /^data:(?:image|audio|video)\//.test(event.data.url)) element.setAttribute(event.data.attribute, event.data.url)
            } else if (event.data.type === 'clear-selection') getSelection()?.removeAllRanges()
            else if (event.data.type === 'capture-state') send({ type: 'state', state: state() })
        })
        document.addEventListener('DOMContentLoaded', () => {
            const mediaTargets = new Map<Element, number[]>()
            const observer = new IntersectionObserver(entries => {
                for (const entry of entries) if (entry.isIntersecting) {
                    observer.unobserve(entry.target)
                    for (const resource of mediaTargets.get(entry.target) ?? []) send({ type: 'media', resource })
                }
            }, { rootMargin: '300px' })
            document.querySelectorAll<HTMLElement>('[data-hapi-resource]').forEach(element => {
                const target = element.tagName === 'SOURCE' ? element.parentElement! : element
                mediaTargets.set(target, [...mediaTargets.get(target) ?? [], Number(element.dataset.hapiResource)])
                observer.observe(target)
            })
            if (initial) {
                for (const item of initial.details) {
                    const node = resolve(item.path)
                    if (node instanceof HTMLDetailsElement) node.open = item.open
                }
                for (const item of initial.fields) {
                    const node = resolve(item.path)
                    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
                        node.value = item.value
                        if (node instanceof HTMLInputElement && item.checked !== undefined) node.checked = item.checked
                        node.dispatchEvent(new Event('input', { bubbles: true }))
                        node.dispatchEvent(new Event('change', { bubbles: true }))
                    }
                }
                scrollTo(initial.x, initial.y)
            }
            send({ type: 'ready' })
        }, { once: true })
    }
    // This is script text, not HTML attributes; escape HTML's script terminator.
    return `;(${runtime.toString()})(${JSON.stringify(id)},${JSON.stringify(initial ?? null).replaceAll('<', '\\u003c')});`
}
