import { useEffect, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, PDFWorker, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import 'pdfjs-dist/web/pdf_viewer.css'
import type { DocumentSelection } from '@hapi/protocol/documents'
import type { DocumentSession } from './documentSession'
import { RegionSelection } from './RegionSelection'
import { useDocumentLabels } from './labels'
import { useAppContext } from '@/lib/app-context'
GlobalWorkerOptions.workerSrc = workerUrl

export default function PdfDocument({ session, foreground, office, onSelect }: {
    session: DocumentSession; foreground: boolean; office: boolean; onSelect: (value: DocumentSelection | undefined) => void
}) {
    const labels = useDocumentLabels()
    const { api } = useAppContext()
    const [pdf, setPdf] = useState<PDFDocumentProxy>()
    const [worker, setWorker] = useState<PDFWorker>()
    const [page, setPage] = useState(session.page)
    const [zoom, setZoom] = useState(session.zoom)
    const [region, setRegion] = useState(false)
    const [zoomOpen, setZoomOpen] = useState(false)
    const [toolOpen, setToolOpen] = useState(false)
    const foregroundRef = useRef(foreground)
    foregroundRef.current = foreground
    const [error, setError] = useState<string>()
    const [retry, setRetry] = useState(0)
    const [width, setWidth] = useState(600)
    const [size, setSize] = useState({ width: 600, height: 800 })
    const [ready, setReady] = useState(false)
    const canvas = useRef<HTMLCanvasElement>(null), text = useRef<HTMLDivElement>(null), container = useRef<HTMLDivElement>(null)
    const sourceBlob = session.state.blob
    const preview = session.state.preview
    useEffect(() => {
        if (!foreground) { setZoomOpen(false); setToolOpen(false) }
    }, [foreground])
    // Load the viewer worker while Office conversion is running, not after it finishes.
    useEffect(() => {
        if (!foreground) return
        let disposed = false
        const next = new PDFWorker()
        setWorker(next)
        void next.promise.catch(reason => { if (!disposed) setError(String(reason)) })
        return () => { disposed = true; setWorker(undefined); next.destroy() }
    }, [foreground])
    useEffect(() => {
        if (!foreground || !worker || (!preview && !sourceBlob)) return
        let disposed = false
        let failed = false
        let task: ReturnType<typeof getDocument> | undefined
        const controller = new AbortController()
        setPdf(undefined); setError(undefined)
        const fail = (reason: unknown) => {
            if (disposed || failed) return
            failed = true; setError(String(reason)); controller.abort(); void task?.destroy()
        }
        class PreviewRange extends PDFDataRangeTransport {
            requestDataRange(begin: number, end: number) {
                void api.readDocumentPreviewRange(session.resource.sessionId, preview!.id, begin, end, controller.signal)
                    .then(bytes => { if (!disposed && !failed) this.onDataRange(begin, bytes) }).catch(fail)
            }
            abort() { controller.abort() }
        }
        void (preview ? Promise.resolve(undefined) : sourceBlob!.arrayBuffer()).then(data => {
                if (disposed) return
                const assets = `${import.meta.env.BASE_URL}pdf-assets/`
                task = getDocument({ worker, ...(preview ? { range: new PreviewRange(preview.length, null, true), rangeChunkSize: 64 * 1024,
                    disableAutoFetch: true, disableStream: true } : { data: new Uint8Array(data!) }),
                    cMapUrl: `${assets}cmaps/`, standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/` })
                return task.promise.then(document => { if (!disposed) { setPdf(document); setPage(value => Math.min(value, document.numPages)) } })
            }).catch(fail)
        return () => { disposed = true; controller.abort(); void task?.destroy() }
    }, [session, sourceBlob, preview, api, retry, worker, foreground])
    useEffect(() => {
        if (!container.current || !foreground) return
        const observer = new ResizeObserver(entries => setWidth(Math.max(100, entries[0].contentRect.width)))
        observer.observe(container.current)
        return () => observer.disconnect()
    }, [foreground])
    useEffect(() => {
        if (!pdf || !canvas.current || !text.current || !foreground) return
        let disposed = false
        let rendering: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined
        let layer: TextLayer | undefined
        setReady(false); setError(undefined)
        void pdf.getPage(page).then(async value => {
            if (disposed || !canvas.current || !text.current) return
            const original = value.getViewport({ scale: 1 })
            const viewport = value.getViewport({ scale: width / original.width * zoom })
            const density = Math.min(2, window.devicePixelRatio || 1)
            setSize({ width: viewport.width, height: viewport.height })
            canvas.current.width = Math.round(viewport.width * density); canvas.current.height = Math.round(viewport.height * density)
            canvas.current.style.width = `${viewport.width}px`; canvas.current.style.height = `${viewport.height}px`
            rendering = value.render({ canvas: canvas.current, viewport, transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0] })
            text.current.replaceChildren()
            text.current.style.setProperty('--scale-factor', `${viewport.scale}`)
            text.current.style.setProperty('--total-scale-factor', `${viewport.scale}`)
            layer = new TextLayer({ container: text.current, viewport, textContentSource: value.streamTextContent() })
            await Promise.all([rendering.promise, layer.render()])
            if (!disposed) setReady(true)
        }).catch(reason => { if (!disposed) setError(String(reason)) })
        return () => { disposed = true; rendering?.cancel(); layer?.cancel() }
    }, [pdf, page, zoom, width, foreground])
    useEffect(() => { session.page = page; session.zoom = zoom }, [session, page, zoom])
    const changePage = (value: number) => { setPage(value); onSelect(undefined); if (container.current) container.current.scrollTop = 0 }
    const textSelection = () => {
        const selection = window.getSelection()
        if (!selection?.rangeCount || selection.isCollapsed || !text.current?.contains(selection.anchorNode) || !text.current.contains(selection.focusNode)) return
        const bounds = text.current.getBoundingClientRect(), rect = selection.getRangeAt(0).getBoundingClientRect()
        onSelect({ kind: 'page', page, quote: selection.toString().slice(0, 12000), rect: {
            x: (rect.left - bounds.left) / bounds.width, y: (rect.top - bounds.top) / bounds.height, width: rect.width / bounds.width, height: rect.height / bounds.height,
        } })
    }
    return <div className="document-pages">
        <div className="document-page-controls">
            <div className="document-pagination" aria-label={labels.pages}>
                <button type="button" className="document-icon-button" disabled={page <= 1} aria-label={labels.previous} title={labels.previous} onClick={() => changePage(page - 1)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>
                </button>
                <span className="document-page-number" aria-live="polite">{pdf ? `${page} / ${pdf.numPages}` : '…'}</span>
                <button type="button" className="document-icon-button" disabled={!pdf || page >= pdf.numPages} aria-label={labels.next} title={labels.next} onClick={() => changePage(page + 1)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m10 6 6 6-6 6" /></svg>
                </button>
            </div>
            <Popover.Root open={foreground && zoomOpen} onOpenChange={setZoomOpen}>
                <Popover.Trigger asChild><button type="button" className="document-zoom-trigger" aria-label={labels.zoom} title={labels.zoom}>
                    {Math.round(zoom * 100)}%<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 6 3 3 3-3" /></svg>
                </button></Popover.Trigger>
                <Popover.Portal><Popover.Content className="document-popover document-zoom-popover" side="bottom" align="end" sideOffset={6} collisionPadding={12} aria-label={labels.zoom}
                    onCloseAutoFocus={event => { if (!foregroundRef.current) event.preventDefault() }}>
                    <div className="document-zoom-controls">
                        <button type="button" className="document-icon-button" disabled={zoom <= .25} aria-label={labels.zoomOut} onClick={() => setZoom(value => Math.max(.25, value - .25))}>−</button>
                        <span aria-live="polite">{Math.round(zoom * 100)}%</span>
                        <button type="button" className="document-icon-button" disabled={zoom >= 3} aria-label={labels.zoomIn} onClick={() => setZoom(value => Math.min(3, value + .25))}>+</button>
                    </div>
                    <Popover.Close asChild><button type="button" className="document-fit-width" onClick={() => setZoom(1)}>{labels.fit}</button></Popover.Close>
                </Popover.Content></Popover.Portal>
            </Popover.Root>
            <Popover.Root open={foreground && toolOpen} onOpenChange={setToolOpen}>
                <Popover.Trigger asChild><button type="button" className="document-icon-button document-selection-trigger" data-region={region || undefined} aria-label={labels.selectionTool} title={region ? labels.region : labels.text}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        {region ? <path d="M9 4H5a1 1 0 0 0-1 1v4m0 6v4a1 1 0 0 0 1 1h4m6 0h4a1 1 0 0 0 1-1v-4m0-6V5a1 1 0 0 0-1-1h-4" /> : <path d="M5 7V4h14v3M12 4v16m-4 0h8" />}
                    </svg>
                </button></Popover.Trigger>
                <Popover.Portal><Popover.Content className="document-popover document-action-menu" side="bottom" align="end" sideOffset={6} collisionPadding={12} aria-label={labels.selectionTool}
                    onCloseAutoFocus={event => { if (!foregroundRef.current) event.preventDefault() }}>
                    <Popover.Close asChild><button type="button" aria-pressed={!region} onClick={() => setRegion(false)}>{labels.text}<span aria-hidden="true">{!region ? '✓' : ''}</span></button></Popover.Close>
                    <Popover.Close asChild><button type="button" aria-pressed={region} onClick={() => setRegion(true)}>{labels.region}<span aria-hidden="true">{region ? '✓' : ''}</span></button></Popover.Close>
                </Popover.Content></Popover.Portal>
            </Popover.Root>
        </div>
        {office ? <div className="document-notice">{labels.conversionNotice}</div> : null}
        {error ? <div className="document-notice" role="alert">{error} <button onClick={() => preview ? void session.load(api, true) : setRetry(value => value + 1)}>{labels.reload}</button></div> : null}
        {!pdf && !error ? <div role="status" className="document-notice">{office && !preview ? labels.conversion : labels.loading}</div> : null}
        <div className="document-page-scroll" ref={container}>
            {pdf ? <div className="document-page" style={{ width: size.width, height: size.height }} aria-busy={!ready}>
                {/* Warm workspace panes retain geometry under visibility:hidden.
                    A ready page must inherit that state, not paint over another pane. */}
                <canvas ref={canvas} style={{ visibility: ready ? 'inherit' : 'hidden' }} />
                <div className="textLayer" ref={text} onPointerUp={textSelection} onKeyUp={textSelection} style={{ visibility: ready ? 'inherit' : 'hidden' }} />
                {region && ready ? <RegionSelection key={page} onSelect={rect => onSelect({ kind: 'page', page, rect })} /> : null}
            </div> : null}
        </div>
    </div>
}
