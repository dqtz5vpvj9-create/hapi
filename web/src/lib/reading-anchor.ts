export type ReadingAnchor = {
    id: string
    topOffset: number
    text?: {
        path: number[]
        offset: number
        quote: string
        quoteStart: number
        topOffset: number
    }
    code?: {
        source: number
        innerTopOffset?: number
        position: number
        quote: string
        quoteStart: number
        topOffset: number
    }
}

export type ReadingRestoreOptions = {
    isCurrent: () => boolean
    onScroll: () => void
    onRestored: (restored: boolean) => void
}
export type CodeReadingSource = {
    positionAt: (node: Text, offset: number) => Pick<NonNullable<ReadingAnchor['code']>, 'position' | 'quote' | 'quoteStart' | 'innerTopOffset'> | null
    restore: (viewport: HTMLElement, anchor: NonNullable<ReadingAnchor['code']>, options: ReadingRestoreOptions) => void
}
export const CODE_READING_SOURCE_READY = 'hapi-code-reading-source-ready'
const codeSources = new WeakMap<HTMLElement, CodeReadingSource>()
export function registerCodeReadingSource(element: HTMLElement, source: CodeReadingSource): () => void {
    codeSources.set(element, source)
    element.dispatchEvent(new Event(CODE_READING_SOURCE_READY, { bubbles: true }))
    return () => { codeSources.delete(element) }
}

const MESSAGE_SELECTOR = '.happy-thread-messages > [id], .happy-thread-messages [id^="hapi-message-"], [data-hapi-reading-part][id]'
const capturedTextNodes = new WeakMap<NonNullable<ReadingAnchor['text']>, { node: Text; offset: number; quoteStart: number }>()
const MAX_LOOKUP_NODES = 512
const MAX_LOOKUP_CHARACTERS = 64 * 1024

function characterRect(node: Text, offset: number): DOMRect | null {
    if (!node.length || typeof node.ownerDocument.createRange().getClientRects !== 'function') return null
    const range = node.ownerDocument.createRange()
    range.setStart(node, Math.min(offset, node.length - 1))
    range.setEnd(node, Math.min(offset + 1, node.length))
    return Array.from(range.getClientRects()).find(rect => rect.width > 0 && rect.height > 0) ?? null
}

function textAtPoint(document: Document, x: number, y: number): { node: Text; offset: number } | null {
    const caretDocument = document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
        caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
    const position = caretDocument.caretPositionFromPoint?.(x, y)
    if (position?.offsetNode.nodeType === Node.TEXT_NODE) return { node: position.offsetNode as Text, offset: position.offset }
    const range = caretDocument.caretRangeFromPoint?.(x, y)
    return range?.startContainer.nodeType === Node.TEXT_NODE
        ? { node: range.startContainer as Text, offset: range.startOffset }
        : null
}

/** A bounded set of native caret hit tests finds visible text without scanning
 * every line of a long code block. Row identity remains the non-text fallback. */
export function captureReadingAnchor(viewport: HTMLElement): ReadingAnchor | null {
    const bounds = viewport.getBoundingClientRect()
    const rows = Array.from(viewport.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR))
    const first = rows.find(row => { const rect = row.getBoundingClientRect(); return rect.bottom > bounds.top && rect.top < bounds.bottom })
    if (!first) return null
    const fallback = { id: first.id, topOffset: first.getBoundingClientRect().top - bounds.top }
    for (const dy of [8, 24, 48, 80, 128, 208, 320]) {
        const y = bounds.top + dy
        if (y >= bounds.bottom) break
        for (const fraction of [0.08, 0.25, 0.5, 0.75, 0.92]) {
            const point = textAtPoint(viewport.ownerDocument, bounds.left + bounds.width * fraction, y)
            if (!point || !point.node.data.trim()) continue
            const row = point.node.parentElement?.closest<HTMLElement>(MESSAGE_SELECTOR)
            if (!row || !viewport.contains(row)) continue
            const offset = Math.min(point.offset, point.node.length - 1)
            const rect = characterRect(point.node, offset)
            // Caret hit tests can return nearby text when the pointer is over
            // an image or a gap. Only accept an actually visible nearby line.
            if (!rect || rect.top < bounds.top || rect.bottom > bounds.bottom
                || y < rect.top - 2 || y > rect.bottom + 2) continue
            const codeElement = point.node.parentElement?.closest<HTMLElement>('[data-hapi-large-code]')
            const source = codeElement && codeSources.get(codeElement)
            const codePosition = source?.positionAt(point.node, offset)
            // Line-number gutters are not source characters. CodeMirror owns
            // positions in its document, independently of recycled text nodes.
            if (source && !codePosition) continue
            const path: number[] = []
            let node: Node = point.node
            while (node !== row) {
                const parent = node.parentNode!
                path.unshift(Array.prototype.indexOf.call(parent.childNodes, node))
                node = parent
            }
            const quoteStart = Math.max(0, offset - 16)
            const text = { path, offset, quoteStart, quote: point.node.data.slice(quoteStart, offset + 48), topOffset: rect.top - bounds.top }
            capturedTextNodes.set(text, { node: point.node, offset, quoteStart })
            return { id: row.id, topOffset: row.getBoundingClientRect().top - bounds.top, text,
                ...(codePosition ? { code: { ...codePosition,
                    source: Array.from(row.querySelectorAll('[data-hapi-large-code]')).indexOf(codeElement!),
                    topOffset: rect.top - bounds.top } } : {}) }
        }
    }
    return fallback
}

function resolveText(row: HTMLElement, anchor: NonNullable<ReadingAnchor['text']>): { node: Text; offset: number } | null {
    // Preserve the actual live node across layout changes. A DOM path alone
    // cannot distinguish an inserted token from the token previously read.
    const original = capturedTextNodes.get(anchor)
    if (original && row.contains(original.node)
        && original.node.data.slice(original.quoteStart, original.quoteStart + anchor.quote.length) === anchor.quote) {
        return { node: original.node, offset: original.offset }
    }
    // Replaced Markdown nodes need a unique passage, with bounded work. Short
    // repeated code tokens are unsuitable for finding a replacement node.
    if (anchor.quote.length < 16) return null
    const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT)
    let match: { node: Text; offset: number } | null = null
    let visited = 0
    let characters = 0
    while (walker.nextNode()) {
        const text = walker.currentNode as Text
        characters += text.length
        if (++visited > MAX_LOOKUP_NODES || characters > MAX_LOOKUP_CHARACTERS) return null
        const start = text.data.indexOf(anchor.quote)
        if (start < 0) continue
        if (match || text.data.indexOf(anchor.quote, start + 1) >= 0) return null
        match = { node: text, offset: start + anchor.offset - anchor.quoteStart }
    }
    if (match) capturedTextNodes.set(anchor, { ...match, quoteStart: match.offset - anchor.offset + anchor.quoteStart })
    return match
}

export function restoreReadingAnchor(viewport: HTMLElement, anchor: ReadingAnchor, options?: ReadingRestoreOptions): boolean {
    const row = viewport.ownerDocument.getElementById(anchor.id)
    if (!row || !viewport.contains(row)) { options?.onRestored(false); return false }
    if (anchor.code) {
        const element = row.querySelectorAll<HTMLElement>('[data-hapi-large-code]')[anchor.code.source]
        const source = element && codeSources.get(element)
        if (!source) { options?.onRestored(false); return false }
        source.restore(viewport, anchor.code, options ?? {
            isCurrent: () => viewport.contains(row), onScroll: () => {}, onRestored: () => {}
        })
        return false // Model restoration completes in CodeMirror's measure phase.
    }
    const bounds = viewport.getBoundingClientRect()
    if (anchor.text) {
        const point = resolveText(row, anchor.text)
        const rect = point ? characterRect(point.node, point.offset) : null
        if (rect) {
            const delta = rect.top - bounds.top - anchor.text.topOffset
            if (Math.abs(delta) > 0.5) viewport.scrollTop += delta
            return true
        }
    }
    const delta = row.getBoundingClientRect().top - bounds.top - anchor.topOffset
    if (Math.abs(delta) > 0.5) viewport.scrollTop += delta
    return true
}
