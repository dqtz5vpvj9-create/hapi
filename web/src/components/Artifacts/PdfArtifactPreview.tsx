import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

export default function PdfArtifactPreview({ blob }: { blob: Blob }) {
    const canvas = useRef<HTMLCanvasElement>(null)
    const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
    const [page, setPage] = useState(1)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        let disposed = false
        let task: ReturnType<typeof getDocument> | undefined
        setDocument(null); setPage(1); setError(null)
        void blob.arrayBuffer().then(data => {
            if (disposed) return
            const assets = `${import.meta.env.BASE_URL}pdf-assets/`
            task = getDocument({ data: new Uint8Array(data), cMapUrl: `${assets}cmaps/`,
                standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/` })
            return task.promise.then(value => { if (!disposed) setDocument(value) })
        }).catch(reason => { if (!disposed) setError(String(reason)) })
        return () => { disposed = true; void task?.destroy() }
    }, [blob])
    useEffect(() => {
        if (!document || !canvas.current) return
        let disposed = false
        let task: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined
        void document.getPage(page).then(value => {
            if (disposed || !canvas.current) return
            const viewport = value.getViewport({ scale: 1 })
            const scale = Math.min(2, 800 / viewport.width)
            const display = value.getViewport({ scale })
            canvas.current.width = display.width; canvas.current.height = display.height
            task = value.render({ canvas: canvas.current, viewport: display })
            return task.promise.then(() => { if (!disposed && canvas.current) canvas.current.dataset.pdfPage = String(page) })
        }).catch(reason => { if (!disposed) setError(String(reason)) })
        return () => { disposed = true; task?.cancel() }
    }, [document, page])
    return <div className="space-y-2">
        {error ? <p role="alert">{error}</p> : null}
        <div className="flex items-center justify-between gap-2 text-sm">
            <button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>←</button>
            <span>{document ? `${page} / ${document.numPages}` : '…'}</span>
            <button disabled={!document || page >= document.numPages} onClick={() => setPage(value => value + 1)}>→</button>
        </div>
        <canvas ref={canvas} className="max-w-full bg-white" />
    </div>
}
