import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { HappyThread } from '@/components/AssistantChat/HappyThread'
import { clearMessageWindow } from './message-window-store'
import LargeCodeView from '@/components/LargeCodeView'
import { captureReadingAnchor, restoreReadingAnchor } from './reading-anchor'

// Geometry is controlled at CodeMirror's public measurement boundary. Its
// EditorState/Text document is real; the mounted DOM is a recycled short token.
const measured = vi.hoisted(() => ({
    requests: [] as Array<{ read: () => any; write: (value: any) => void }>,
    unmounted: false, tokenTop: 0, scroll: null as HTMLElement | null, views: [] as any[], positions: [] as number[]
}))
vi.mock('@codemirror/language-data', () => ({ languages: [] }))
vi.mock('@codemirror/view', async importOriginal => {
    const actual = await importOriginal<typeof import('@codemirror/view')>()
    class View {
        static editable = actual.EditorView.editable
        static contentAttributes = actual.EditorView.contentAttributes
        static lineWrapping = actual.EditorView.lineWrapping
        static theme = actual.EditorView.theme
        static scrollIntoView = actual.EditorView.scrollIntoView
        state: any
        contentDOM: HTMLElement
        scrollDOM: HTMLElement
        constructor(config: any) {
            this.state = config.state
            this.scrollDOM = document.createElement('div')
            this.contentDOM = document.createElement('div')
            this.contentDOM.className = 'cm-content'
            this.contentDOM.innerHTML = '<div class="cm-line"><span>sequence</span></div>'
            this.scrollDOM.append(this.contentDOM)
            config.parent.append(this.scrollDOM)
            measured.views.push(this)
        }
        posAtDOM(_node: Node, offset: number) {
            const line = this.state.doc.line(1283)
            return line.from + line.text.indexOf('sequence') + offset
        }
        scaleY = 1
        get documentTop() { return measured.tokenTop - measured.scroll!.scrollTop - this.scrollDOM.scrollTop - 21 }
        lineBlockAt(position: number) { return { from: this.state.doc.lineAt(position).from, top: 0 } }
        coordsAtPos(position: number) {
            measured.positions.push(position)
            if (measured.unmounted && measured.scroll!.scrollTop === 70000) return null
            return { top: measured.tokenTop - measured.scroll!.scrollTop - this.scrollDOM.scrollTop }
        }
        requestMeasure(request?: any) { if (request) measured.requests.push(request) }
        dispatch() {} // Effects render a model position, never alter selection.
        destroy() {}
    }
    return { ...actual, EditorView: View }
})

vi.mock('@/hooks/queries/useMachines', () => ({ useMachines: () => ({ machines: [] }) }))
vi.mock('@assistant-ui/react', async importOriginal => {
    const actual = await importOriginal<typeof import('@assistant-ui/react')>()
    return { ...actual, useAuiState: (selector: (state: any) => unknown) => selector({ thread: { extras: undefined, messages: [] } }),
        unstable_useThreadMessageIds: () => [], ThreadPrimitive: { ...actual.ThreadPrimitive,
            Root: ({ children, className }: PropsWithChildren<{ className?: string }>) => <div className={className}>{children}</div>,
            Viewport: ({ children }: PropsWithChildren) => children, Messages: () => null } }
})

const source = Array.from({ length: 10000 }, (_, i) =>
    `const public_record_${i + 1} = { sequence: ${i + 1}, message: "PUBLIC_LARGE_CODE_LINE_${i + 1}" };`).join('\n')
function geometry(top: number, bottom: number) {
    return { top, bottom, left: 0, right: 390, width: 390, height: bottom - top, x: 0, y: top, toJSON: () => {} }
}
let viewport: HTMLElement
let row: HTMLElement
beforeEach(() => {
    measured.unmounted = false
    measured.requests = []; measured.views = []; measured.positions = []
    viewport = document.createElement('div')
    const list = document.createElement('div'); list.className = 'happy-thread-messages'
    row = document.createElement('div'); row.id = 'hapi-message-agent-text:large-code'
    list.append(row); viewport.append(list); document.body.append(viewport)
    measured.scroll = viewport; viewport.scrollTop = 70000; measured.tokenTop = 70116
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => geometry(100, 700))
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => geometry(100, 100000))
    Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({
        offsetNode: row.querySelector('.cm-line span')!.firstChild, offset: 2
    }) })
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [
        geometry(measured.tokenTop - viewport.scrollTop, measured.tokenTop - viewport.scrollTop + 14)
    ] })
})
afterEach(() => {
    viewport.remove(); vi.restoreAllMocks()
    delete (document as any).caretPositionFromPoint
    delete (Range.prototype as any).getClientRects
})
function flushMeasurements() {
    let count = 0
    while (measured.requests.length) {
        if (++count > 4) throw new Error('Unbounded reading restoration')
        const request = measured.requests.shift()!
        request.write(request.read())
    }
    return count
}

it('restores the source character after a fresh editor changes the height map and recycles its short token DOM', () => {
    const first = render(<LargeCodeView code={source} wrap />, { container: row })
    const anchor = captureReadingAnchor(viewport)!
    expect(anchor.text?.quote).toBe('sequence') // The original fallback cannot resolve this short token.
    const point = measured.tokenTop - viewport.scrollTop
    first.unmount()
    const replacement = document.createElement('div')
    replacement.id = row.id
    row.replaceWith(replacement); row = replacement
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => geometry(100, 100000))
    render(<LargeCodeView code={source} wrap />, { container: row })
    measured.tokenTop -= 336 // Actual baseline: native lineBlock.top 70140 -> 69804.
    restoreReadingAnchor(viewport, JSON.parse(JSON.stringify(anchor)))
    expect(flushMeasurements()).toBeLessThanOrEqual(3)
    expect(measured.tokenTop - viewport.scrollTop).toBe(point)
    const line = measured.views[1].state.doc.line(1283)
    expect(measured.positions).toContain(line.from + line.text.indexOf('sequence') + 2)
    expect(row.querySelectorAll('.cm-line')).toHaveLength(1)
    expect(measured.views[1].state.doc.lines).toBe(10000)
    expect(measured.views[1].state.selection.main.anchor).toBe(0)
})

it('measures actual coordinates rather than adding a fixed drift correction', () => {
    render(<LargeCodeView code={source} wrap />, { container: row })
    const anchor = captureReadingAnchor(viewport)!
    const point = measured.tokenTop - viewport.scrollTop
    measured.tokenTop += 1432.5
    restoreReadingAnchor(viewport, anchor)
    flushMeasurements()
    expect(measured.tokenTop - viewport.scrollTop).toBe(point)
})

it('cannot scroll for a recovery superseded by fresh user intent', () => {
    render(<LargeCodeView code={source} wrap />, { container: row })
    const anchor = captureReadingAnchor(viewport)!
    const top = viewport.scrollTop
    const onRestored = vi.fn()
    let current = true
    restoreReadingAnchor(viewport, anchor, { isCurrent: () => current, onScroll: () => {}, onRestored })
    current = false; measured.tokenTop -= 336
    flushMeasurements()
    expect(viewport.scrollTop).toBe(top)
    expect(onRestored).not.toHaveBeenCalled()
})

it('does not claim model restoration by scrolling a message fallback while the lazy editor is absent', () => {
    const component = render(<LargeCodeView code={source} wrap />, { container: row })
    const anchor = captureReadingAnchor(viewport)!
    component.unmount()
    const top = viewport.scrollTop
    const onRestored = vi.fn()
    expect(restoreReadingAnchor(viewport, anchor, { isCurrent: () => true, onScroll: () => {}, onRestored })).toBe(false)
    expect(onRestored).toHaveBeenCalledWith(false)
    expect(viewport.scrollTop).toBe(top)
})

it('mounts an offscreen source through the sparse height map before positioning its wrapped character', () => {
    render(<LargeCodeView code={source} wrap />, { container: row })
    const anchor = captureReadingAnchor(viewport)!
    measured.unmounted = true; measured.tokenTop -= 336
    const onRestored = vi.fn()
    restoreReadingAnchor(viewport, anchor, { isCurrent: () => true, onScroll: () => {}, onRestored })
    expect(flushMeasurements()).toBe(3)
    expect(measured.tokenTop - viewport.scrollTop).toBe(116)
    expect(onRestored).toHaveBeenCalledWith(true)
})

it('restores both the bounded code viewport and its position in the outer chat', () => {
    render(<LargeCodeView code={source} wrap maxHeight={400} />, { container: row })
    const view = measured.views[0]
    vi.spyOn(view.scrollDOM, 'getBoundingClientRect').mockImplementation(() => geometry(70100 - viewport.scrollTop, 70500 - viewport.scrollTop))
    const anchor = captureReadingAnchor(viewport)!
    view.scrollDOM.scrollTop = 900
    viewport.scrollTop += 100
    const onRestored = vi.fn()
    restoreReadingAnchor(viewport, anchor, { isCurrent: () => true, onScroll: () => {}, onRestored })
    expect(flushMeasurements()).toBe(3)
    expect(view.scrollDOM.scrollTop).toBe(0)
    expect(viewport.scrollTop).toBe(70000)
    expect(onRestored).toHaveBeenCalledWith(true)
})

it('rejects a changed document instead of finding a repeated short token elsewhere', () => {
    render(<LargeCodeView code={source} wrap />, { container: row })
    const anchor = captureReadingAnchor(viewport)!
    const view = measured.views[0]
    view.state = view.state.update({ changes: { from: view.posAtDOM(row.querySelector('.cm-line span')!.firstChild, 2), insert: 'CHANGED' } }).state
    const onRestored = vi.fn()
    restoreReadingAnchor(viewport, anchor, { isCurrent: () => true, onScroll: () => {}, onRestored })
    expect(measured.requests).toHaveLength(0)
    expect(onRestored).toHaveBeenCalledWith(false)
    expect(viewport.scrollTop).toBe(70000)
})

it('revokes the remaining outer placement when the user takes over after an inner placement', () => {
    render(<LargeCodeView code={source} wrap maxHeight={400} />, { container: row })
    const view = measured.views[0]
    vi.spyOn(view.scrollDOM, 'getBoundingClientRect').mockImplementation(() => geometry(70100 - viewport.scrollTop, 70500 - viewport.scrollTop))
    const anchor = captureReadingAnchor(viewport)!
    view.scrollDOM.scrollTop = 900; viewport.scrollTop += 100
    let current = true
    const onRestored = vi.fn()
    restoreReadingAnchor(viewport, anchor, { isCurrent: () => current, onScroll: () => {}, onRestored })
    const placement = measured.requests.shift()!
    placement.write(placement.read())
    expect(view.scrollDOM.scrollTop).toBe(0)
    current = false
    flushMeasurements()
    expect(viewport.scrollTop).toBe(70100)
    expect(onRestored).not.toHaveBeenCalled()
})

it('reports unavailable geometry instead of indefinitely retrying a clamped viewport', () => {
    render(<LargeCodeView code={source} wrap />, { container: row })
    const anchor = captureReadingAnchor(viewport)!
    const originalTop = viewport.scrollTop
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, get: () => originalTop, set: () => {} })
    measured.tokenTop -= 336
    const onRestored = vi.fn()
    restoreReadingAnchor(viewport, anchor, { isCurrent: () => true, onScroll: () => {}, onRestored })
    expect(flushMeasurements()).toBe(2)
    expect(onRestored).toHaveBeenCalledWith(false)
})

it('finishes viewport-refined character geometry under one owner instead of failing and waiting for a restart', () => {
    render(<LargeCodeView code={source} wrap />, { container: row })
    const anchor = captureReadingAnchor(viewport)!
    const target = measured.tokenTop - viewport.scrollTop
    measured.tokenTop -= 251.609375
    const onRestored = vi.fn()
    restoreReadingAnchor(viewport, anchor, { isCurrent: () => true, onScroll: () => {}, onRestored })
    const first = measured.requests.shift()!
    first.write(first.read())
    // CodeMirror recycles/measures the wrapped viewport after placement.
    // Actual trace then had a -10 residual despite a valid model position.
    measured.tokenTop -= 10
    expect(flushMeasurements()).toBe(2)
    expect(measured.tokenTop - viewport.scrollTop).toBe(target)
    expect(onRestored).toHaveBeenCalledExactlyOnceWith(true)
})

it('stops non-converging measured geometry without polling or scheduling endless corrections', () => {
    render(<LargeCodeView code={source} wrap />, { container: row })
    const anchor = captureReadingAnchor(viewport)!
    measured.tokenTop -= 100
    const onRestored = vi.fn()
    restoreReadingAnchor(viewport, anchor, { isCurrent: () => true, onScroll: () => {}, onRestored })
    const first = measured.requests.shift()!
    first.write(first.read())
    const lastTop = viewport.scrollTop
    measured.tokenTop -= 150 // More error, not a converging refinement.
    expect(flushMeasurements()).toBe(1)
    expect(viewport.scrollTop).toBe(lastTop)
    expect(onRestored).toHaveBeenCalledExactlyOnceWith(false)
})

it('lets fresh user intent revoke a second model correction after viewport refinement', () => {
    render(<LargeCodeView code={source} wrap />, { container: row })
    const anchor = captureReadingAnchor(viewport)!
    measured.tokenTop -= 251
    let current = true
    const onRestored = vi.fn()
    restoreReadingAnchor(viewport, anchor, { isCurrent: () => current, onScroll: () => {}, onRestored })
    const first = measured.requests.shift()!
    first.write(first.read())
    measured.tokenTop -= 10
    const next = measured.requests.shift()!
    const placement = next.read()
    const lastTop = viewport.scrollTop
    current = false
    next.write(placement)
    expect(viewport.scrollTop).toBe(lastTop)
    expect(measured.requests).toHaveLength(0)
    expect(onRestored).not.toHaveBeenCalled()
})

it('keeps one actual HappyThread restoration owner through repeated layout publications', () => {
    const oldEditor = render(<LargeCodeView code={source} wrap />, { container: row })
    const anchor = captureReadingAnchor(viewport)!
    oldEditor.unmount()
    const replacement = document.createElement('div'); replacement.id = row.id
    row.replaceWith(replacement); row = replacement
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => geometry(100, 100000))
    const session = 'model-owner-layout'
    sessionStorage.setItem(`hapi:message-window:v2:${session}`, JSON.stringify({ messages: [], readingBookmark: anchor,
        viewMode: 'history', hasMore: true, epoch: 1, oldestPositionAt: 1, oldestPositionSeq: 1, newestPositionAt: 1, newestPositionSeq: 1 }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const api = { getHubSettings: vi.fn(async () => ({ sessionSummaryContract: false, sessionSummaryInChat: false })) } as any
    const thread = (version: number) => <QueryClientProvider client={queryClient}><I18nProvider><HappyThread
        api={api} session={{ metadata: {} } as any} sessionId={session} metadata={null} disabled={false}
        onRefresh={() => {}} onViewModeChange={() => {}} isSyncingTail={false} messagesWarning={null}
        hasMoreMessages={false} isLoadingMoreMessages={false} onLoadMore={async () => ({ kind: 'stopped', reason: 'exhausted' })}
        onCancelLoadMore={() => {}} unseenCount={0} rawMessagesCount={1} normalizedMessagesCount={1}
        messagesVersion={version} historyVersion={0} forceScrollToken={0} outlineOpen={false}
        outlineItems={[]} outlineEpoch={null} onOutlineOpenChange={() => {}} /></I18nProvider></QueryClientProvider>
    const component = render(thread(1))
    const originalViewport = viewport
    viewport = component.container.querySelector('.chat-scroll-y')!
    measured.scroll = viewport; viewport.scrollTop = 70000
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => geometry(100, 700))
    vi.spyOn(viewport, 'getClientRects').mockImplementation(() => [geometry(100, 700)] as any)
    viewport.querySelector('.happy-thread-messages')!.append(row)
    originalViewport.remove()
    render(<LargeCodeView code={source} wrap />, { container: row })
    // Source-ready publication and actual component version/layout effects
    // all target the same saved model position before its first measure runs.
    component.rerender(thread(2))
    act(() => { viewport.dispatchEvent(new Event('hapi-code-reading-source-ready', { bubbles: true })) })
    component.rerender(thread(3))
    expect(measured.requests).toHaveLength(1)
    measured.tokenTop -= 251
    const first = measured.requests.shift()!; first.write(first.read())
    component.rerender(thread(4))
    expect(measured.requests).toHaveLength(1)
    measured.tokenTop -= 10
    act(() => { flushMeasurements() })
    expect(measured.tokenTop - viewport.scrollTop).toBe(116)
    component.unmount(); queryClient.clear(); clearMessageWindow(session)
})
